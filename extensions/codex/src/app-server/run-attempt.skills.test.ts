import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { isJsonObject } from "./protocol.js";
import { itemNotification } from "./protocol.test-helpers.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createParams,
  createStartedThreadHarness,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

const FIRST_CATALOG = "<available_skills><skill><name>weather</name></skill></available_skills>";
const SECOND_CATALOG =
  "<available_skills><skill><name>weather</name><description>edited</description></skill></available_skills>";

describe("Codex app-server skill catalog delivery", () => {
  it("keeps managed catalogs fresh and parent-local without thread refreshes", async () => {
    const sessionKey = "agent:main:dashboard:incognito-managed-skills";
    await seedRunSessionOwnerForTest("session-1", sessionKey);
    let started = createDeferred<void>();
    const received: string[] = [];
    const harness = createStartedThreadHarness(async (method, request) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "turn/start") {
        const route = getCodexInferenceThread(harness.client, "thread-1");
        expect(route).toBeDefined();
        if (!route || !isJsonObject(request) || !isJsonObject(request.responsesapiClientMetadata)) {
          throw new Error("Missing managed turn registration");
        }
        const generation = request.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY];
        if (typeof generation !== "string") {
          throw new Error("Missing managed generation");
        }
        const nativeBody = { instructions: "Native model-owned policy", input: [] };
        const metadata = { requestKind: "turn", threadId: "thread-1", generation };
        const parent = route.context.prepare(nativeBody, metadata);
        parent.assertCurrent();
        const instructions = parent.body.instructions;
        if (typeof instructions !== "string") {
          throw new Error("Expected managed parent instructions to be a string");
        }
        received.push(instructions);
        // A continuation uses the same current registration even if native history
        // was rebuilt by compaction. Neither compaction nor children borrow it.
        expect(route.context.prepare(nativeBody, metadata).body).toEqual(parent.body);
        expect(
          route.context.prepare(nativeBody, { ...metadata, requestKind: "compaction" }).body,
        ).toBe(nativeBody);
        expect(
          route.context.prepare(nativeBody, {
            ...metadata,
            threadId: "child",
            parentThreadId: "thread-1",
          }).body,
        ).toBe(nativeBody);
        started.resolve();
      }
      return undefined;
    });
    ownCodexInferenceClient(harness.client);
    for (const [index, catalog] of [
      FIRST_CATALOG,
      SECOND_CATALOG,
      undefined,
      SECOND_CATALOG,
    ].entries()) {
      started = createDeferred<void>();
      const params = createParams(path.join(tempDir, "managed.jsonl"), tempDir, {
        sessionKey,
        runId: `managed-${index}`,
      });
      params.skillsSnapshot = { prompt: catalog ?? "", skills: [] };
      if (index === 2) {
        params.bootstrapContextMode = "lightweight";
        params.bootstrapContextRunKind = "cron";
      }
      const run = runCodexAppServerAttempt(params);
      await Promise.race([
        started.promise,
        run.then(() => {
          throw new Error("Attempt completed before turn/start");
        }),
      ]);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    }
    expect(received[0]).toContain(FIRST_CATALOG);
    expect(received[1]).toContain(SECOND_CATALOG);
    expect(received[1]).not.toContain(FIRST_CATALOG);
    expect(received[2]).not.toContain("available_skills");
    expect(received[3]).toContain(SECOND_CATALOG);
    const nativeRequests = harness.requests.filter(({ method }) =>
      ["thread/start", "thread/resume", "thread/inject_items"].includes(method),
    );
    expect(nativeRequests.map(({ method }) => method)).toEqual(["thread/start"]);
    expect(JSON.stringify(nativeRequests)).not.toContain("available_skills");
  });

  it("re-delivers the catalog on the next turn when the post-compaction restore fails", async () => {
    const sessionKey = "agent:main:dashboard:incognito-skill-restore-failure";
    await seedRunSessionOwnerForTest("session-1", sessionKey);
    let failNextInject = false;
    const harness = createStartedThreadHarness(async (method) => {
      if (method === "thread/inject_items" && failNextInject) {
        failNextInject = false;
        throw new Error("inject_items unavailable");
      }
      return undefined;
    });
    const sessionFile = path.join(tempDir, "incognito-restore-failure-session.jsonl");
    const workspaceDir = path.join(tempDir, "incognito-restore-failure-workspace");
    const injectCount = () =>
      harness.requests.filter(({ method }) => method === "thread/inject_items").length;
    const turnStarts = () =>
      harness.requests.filter(({ method }) => method === "turn/start").length;
    const runTurn = async (runId: string, catalog: string, options: { compact?: boolean } = {}) => {
      const params = createParams(sessionFile, workspaceDir, { sessionKey, runId });
      // Allow the real before_compaction history worker to start.
      params.timeoutMs = 60_000;
      params.skillsSnapshot = { prompt: catalog, skills: [] };
      const turnStartsBefore = turnStarts();
      const run = runCodexAppServerAttempt(params);
      await Promise.race([
        vi.waitFor(() => expect(turnStarts()).toBe(turnStartsBefore + 1), {
          interval: 1,
          timeout: 10_000,
        }),
        run.then(() => {
          throw new Error(`Codex attempt ${runId} completed before requesting a turn`);
        }),
      ]);
      if (options.compact) {
        await harness.notify(
          itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
        );
        await harness.notify(
          itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
        );
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    };

    await runTurn("run-1", FIRST_CATALOG);
    await runTurn("run-2", SECOND_CATALOG);
    expect(injectCount()).toBe(1);

    // A failed restore leaves the thread on the creation-time catalog. Recording
    // the refresh as still delivered would strand it there for the whole session.
    failNextInject = true;
    await runTurn("run-3", SECOND_CATALOG, { compact: true });
    expect(injectCount()).toBe(2);

    await runTurn("run-4", SECOND_CATALOG);
    const injected = harness.requests.filter(({ method }) => method === "thread/inject_items");
    expect(injected).toHaveLength(3);
    expect(JSON.stringify(injected[2]?.params)).toContain(SECOND_CATALOG);
  });
});

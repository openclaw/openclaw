import path from "node:path";
import { registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { describe, expect, it } from "vitest";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { itemNotification } from "./protocol.test-helpers.js";
import { readManagedInstructions } from "./run-attempt-continuity.test-support.js";
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
    const received: string[] = [];
    const personalUser = "Synthetic selected personal preferences.";
    const personalPath = path.join(tempDir, "users", "alice", "USER.md");
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as { bootstrapFiles: unknown[] };
      context.bootstrapFiles.push({
        name: "USER.md",
        path: personalPath,
        content: personalUser,
        missing: false,
        personalUser: true,
      });
    });
    const harness = createStartedThreadHarness(async (method, request) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "turn/start") {
        received.push(readManagedInstructions(harness.client, request));
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
      await run.waitForTurnAccepted();
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;
      if (index !== 2) {
        expect(received[index]).toContain(personalUser);
        expect(result.systemPromptReport?.injectedWorkspaceFiles).toContainEqual(
          expect.objectContaining({ path: personalPath, injectedChars: personalUser.length }),
        );
      }
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
    expect(JSON.stringify(harness.requests)).not.toContain(personalUser);
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
    const runTurn = async (runId: string, catalog: string, options: { compact?: boolean } = {}) => {
      const params = createParams(sessionFile, workspaceDir, { sessionKey, runId });
      // Allow the real before_compaction history worker to start.
      params.timeoutMs = 60_000;
      params.skillsSnapshot = { prompt: catalog, skills: [] };
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
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

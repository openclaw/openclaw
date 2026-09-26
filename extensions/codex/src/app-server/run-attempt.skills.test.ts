// Codex tests cover installed-skill catalog delivery across live thread turns.
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { isJsonObject } from "./protocol.js";
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

  it("refreshes the incognito skill catalog without recreating the live thread", async () => {
    const sessionKey = "agent:main:dashboard:incognito-skill-refresh";
    await seedRunSessionOwnerForTest("session-1", sessionKey);
    const harness = createStartedThreadHarness();
    const sessionFile = path.join(tempDir, "incognito-session.jsonl");
    const workspaceDir = path.join(tempDir, "incognito-workspace");
    const developerRequests = () =>
      harness.requests.filter(({ method }) =>
        ["thread/start", "thread/resume", "thread/inject_items", "turn/start"].includes(method),
      );
    const runTurn = async (runId: string, catalog: string) => {
      const params = createParams(sessionFile, workspaceDir, { sessionKey, runId });
      params.skillsSnapshot = { prompt: catalog, skills: [] };
      const turnStartsBefore = developerRequests().filter(
        ({ method }) => method === "turn/start",
      ).length;
      const run = runCodexAppServerAttempt(params);
      // A refused preflight rejects the run before any turn/start; surface that
      // exact error instead of timing out while waiting for the turn.
      await Promise.race([
        vi.waitFor(
          () => {
            expect(
              developerRequests().filter(({ method }) => method === "turn/start"),
            ).toHaveLength(turnStartsBefore + 1);
          },
          { interval: 1, timeout: 10_000 },
        ),
        run.then(() => {
          throw new Error(`Codex attempt ${runId} completed before requesting a turn`);
        }),
      ]);
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    };

    await runTurn("run-1", FIRST_CATALOG);
    // A supported mid-session catalog refresh (for example an edited skill
    // description) must reach the live incognito thread instead of refusing the turn.
    await runTurn("run-2", SECOND_CATALOG);
    // An unchanged catalog is not re-delivered.
    await runTurn("run-3", SECOND_CATALOG);

    expect(developerRequests().map(({ method }) => method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/inject_items",
      "turn/start",
      "turn/start",
    ]);
    const [threadStart, , injectItems] = developerRequests();
    const threadStartParams = threadStart?.params as {
      ephemeral?: boolean;
      developerInstructions?: string;
    };
    expect(threadStartParams.ephemeral).toBe(true);
    // The catalog rides the thread carrier exactly once, after the generic policy.
    expect(threadStartParams.developerInstructions?.split(FIRST_CATALOG)).toHaveLength(2);
    expect(threadStartParams.developerInstructions?.endsWith(FIRST_CATALOG)).toBe(true);
    expect(injectItems?.params).toEqual({
      threadId: "thread-1",
      items: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: expect.stringContaining(SECOND_CATALOG) }],
        },
      ],
    });
    expect(JSON.stringify(injectItems?.params)).not.toContain(FIRST_CATALOG);
  });

  it.each([
    {
      label: "an edited catalog",
      refreshed: SECOND_CATALOG,
      expectRestored: (text: string) => expect(text).toContain(SECOND_CATALOG),
    },
    {
      label: "a withdrawn catalog",
      refreshed: undefined,
      expectRestored: (text: string) => {
        expect(text).toContain("skills catalog is empty");
        expect(text).not.toContain(FIRST_CATALOG);
      },
    },
  ])(
    "re-delivers $label after compaction discards the refresh",
    async ({ refreshed, expectRestored }) => {
      const sessionKey = `agent:main:dashboard:incognito-skill-compaction-${refreshed ? "edit" : "removal"}`;
      await seedRunSessionOwnerForTest("session-1", sessionKey);
      const harness = createStartedThreadHarness();
      const sessionFile = path.join(tempDir, "incognito-compaction-session.jsonl");
      const workspaceDir = path.join(tempDir, "incognito-compaction-workspace");
      const injectedTexts = () =>
        harness.requests
          .filter(({ method }) => method === "thread/inject_items")
          .map(({ params }) => JSON.stringify(params));
      const turnStarts = () =>
        harness.requests.filter(({ method }) => method === "turn/start").length;
      const runTurn = async (
        runId: string,
        catalog: string | undefined,
        options: { compact?: boolean } = {},
      ) => {
        const params = createParams(sessionFile, workspaceDir, { sessionKey, runId });
        // Compaction runs the real before_compaction history read, whose first
        // worker start costs several seconds. The 5s default attempt budget
        // expires inside it and aborts projection before the catalog restore,
        // so this lane needs the same budget as the native compaction tests.
        params.timeoutMs = 60_000;
        params.skillsSnapshot = catalog ? { prompt: catalog, skills: [] } : undefined;
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
          // Native remote compaction rebuilds initial context from the creation-time
          // developer instructions, dropping the client-authored catalog refresh.
          const forTurn = (method: string, item: Record<string, unknown>) => ({
            method,
            params: { threadId: "thread-1", turnId: "turn-1", item },
          });
          await harness.notify(
            forTurn("item/started", {
              type: "contextCompaction",
              id: "compact-1",
            }) as Parameters<typeof harness.notify>[0],
          );
          await harness.notify(
            forTurn("item/completed", {
              type: "contextCompaction",
              id: "compact-1",
            }) as Parameters<typeof harness.notify>[0],
          );
        }
        await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
        await run;
      };

      await runTurn("run-1", FIRST_CATALOG);
      await runTurn("run-2", refreshed);
      const injectedAfterRefresh = injectedTexts().length;
      expect(injectedAfterRefresh).toBe(1);

      // A turn that compacts must re-deliver the current catalog before it ends,
      // otherwise the rebuilt context silently reverts to the creation-time catalog.
      await runTurn("run-3", refreshed, { compact: true });
      const injected = injectedTexts();
      expect(injected).toHaveLength(injectedAfterRefresh + 1);
      expectRestored(injected[injected.length - 1] ?? "");
    },
  );

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
      // Same real before_compaction history read as the case above; the default
      // 5s attempt budget expires inside it.
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
        for (const method of ["item/started", "item/completed"]) {
          await harness.notify({
            method,
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { type: "contextCompaction", id: "compact-1" },
            },
          } as Parameters<typeof harness.notify>[0]);
        }
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

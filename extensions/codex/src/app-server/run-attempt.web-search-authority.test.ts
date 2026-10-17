import path from "node:path";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it } from "vitest";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { isJsonObject, type RpcRequest } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setCodexAppServerClientFactoryForTest,
  threadStartResult,
  turnStartResult,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { createCodexLifecycleTurnHarness } from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();

it.each([
  { transition: "allowed", boundary: "thread/start" },
  { transition: "revoked", boundary: "thread/start" },
  { transition: "reassigned", boundary: "thread/start" },
  { transition: "revoked", boundary: "turn/start" },
  { transition: "reassigned", boundary: "turn/start" },
] as const)(
  "keeps prepared native search bound to the $transition requester at $boundary",
  async ({ transition, boundary }) => {
    const params = createParams(path.join(tempDir, "session.jsonl"), tempDir, {
      sessionKey: "agent:main:dashboard:search-authority",
      provider: "openai",
      prompt: "Search the web for the synthetic authority-chain fixture.",
    });
    params.config = {};
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => []);
    const scope = {
      agentId: "main",
      sessionKey: params.sessionKey!,
      storePath: resolveStorePath(undefined, { agentId: "main" }),
    };
    await patchSessionEntry({
      ...scope,
      fallbackEntry: { sessionId: params.sessionId, updatedAt: 1 },
      update: () => ({
        spawnedBy: "agent:main:parent",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: [],
        inheritedToolDeny: [],
      }),
    });
    const close = await bindProductionHarnessHostCapabilitiesForTest(params);
    const host = params.hostCapabilities;
    const prepare = host.prepareWebSearchToolPolicy!;
    const prepared: boolean[] = [];
    let transitioned = false;
    params.hostCapabilities = {
      ...host,
      async prepareWebSearchToolPolicy(options) {
        const policy = await prepare(options);
        prepared.push(policy.allowed);
        return policy;
      },
    };
    const harness = createCodexLifecycleTurnHarness({
      agentDir: path.join(tempDir, "wire-agent"),
      respond: (method) => {
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          return turnStartResult();
        }
        if (method === "modelProvider/capabilities/read") {
          return { imageGeneration: false, webSearch: true };
        }
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "skills/list" || method === "thread/backgroundTerminals/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        return {};
      },
    });
    setCodexAppServerClientFactoryForTest(async (_start, _auth, _dir, _config, options) =>
      harness.acquire(options),
    );
    const dispatch = harness.request.getMockImplementation()!;
    harness.request.mockImplementation((method, body, options) => {
      if (method !== boundary) {
        return dispatch(method, body, options);
      }
      return dispatch(method, body, {
        ...options,
        withCurrent: async (write) => {
          if (!transitioned) {
            transitioned = true;
            if (transition !== "allowed") {
              await patchSessionEntry({
                ...scope,
                update: () =>
                  transition === "revoked"
                    ? { inheritedToolDeny: ["web_search"] }
                    : { spawnedBy: "agent:main:other-parent" },
              });
            }
            // Preparation has finished; the attempt stays live at the wire admission gate.
            host.assertActive();
          }
          if (options?.withCurrent) {
            await options.withCurrent(write);
          } else {
            write();
          }
        },
      });
    });
    const run = runCodexAppServerAttempt(params);
    const complete = run.waitForTurnAccepted().then(
      () => harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" }),
      () => {},
    );
    try {
      const outcome = await run.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await complete;
      const requests = harness.writes.map((line) => JSON.parse(line) as RpcRequest);
      const starts = requests.filter((request) => request.method === "thread/start");
      const turns = requests.filter((request) => request.method === "turn/start");
      console.log(
        `[authority-chain] boundary=${boundary} requester=${transition} prepared=${prepared[0] ? "allowed" : "denied"} host=active native-thread-writes=${starts.length} native-turn-writes=${turns.length} outcome=${"error" in outcome ? "rejected" : "completed"}`,
      );
      expect(prepared[0]).toBe(true);
      expect(transitioned).toBe(true);
      if (transition === "allowed" || boundary === "turn/start") {
        expect(starts[0]?.params).toMatchObject({ config: { web_search: "cached" } });
      }
      if (transition === "allowed") {
        expect(outcome).not.toHaveProperty("error");
        expect(turns).toHaveLength(1);
        expect(isJsonObject(turns[0]?.params) && turns[0].params.input).toBeTruthy();
      } else {
        expect(outcome).toHaveProperty("error");
        if ("error" in outcome) {
          expect(outcome.error).toMatchObject({
            message: expect.stringMatching(/policy changed|superseded|no longer active/),
          });
        }
        expect(starts).toHaveLength(boundary === "thread/start" ? 0 : 1);
        expect(turns).toEqual([]);
      }
    } finally {
      close();
    }
  },
);

import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
  isCodexAppServerLiveThreadClaimed,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import type { RpcRequest } from "./protocol.js";
import { tempDir, threadStartResult } from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  type writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import { releaseLeasedSharedCodexAppServerClient } from "./shared-client.js";
import type { createClientHarness } from "./test-support.js";
import type { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle-run.js";
import type { CodexAttemptThreadInput as StartParams } from "./thread-lifecycle.test-fixtures.js";
import { CodexIncognitoPolicyChangeError } from "./thread-policy.js";

export function createUnobservedThreadClient(
  instanceId: string,
  request: (method: string, params?: unknown) => Promise<unknown>,
) {
  return {
    getInstanceId: () => instanceId,
    request,
    addNotificationHandler: () => () => undefined,
    addRequestHandler: () => () => undefined,
    addCloseHandler: () => () => undefined,
  };
}

type PolicyRefreshFixtures = {
  createParams: (sessionFile: string, workspaceDir: string) => StartParams["params"];
  createThreadLifecycleAppServerOptions: () => StartParams["appServer"];
  createLeasedLifecycleWireClient: (
    agentDir: string,
    respond: (request: RpcRequest) => unknown,
    transport: "stdio" | "websocket" | "unix" | "proxy",
  ) => Promise<ReturnType<typeof createClientHarness>>;
  startOrResumeThread: (
    params: Pick<StartParams, "client"> & Partial<StartParams>,
  ) => ReturnType<typeof startOrResumeThreadImpl>;
  writeCodexAppServerBinding: typeof writeRawCodexAppServerBinding;
};

/** Keep policy refresh cases under the binding suite's existing lifecycle setup and cleanup. */
export function registerThreadPolicyRefreshTests({
  createParams,
  createThreadLifecycleAppServerOptions,
  createLeasedLifecycleWireClient,
  startOrResumeThread,
  writeCodexAppServerBinding,
}: PolicyRefreshFixtures) {
  async function fixture(
    threadId: string,
    respond: (request: RpcRequest, response: ReturnType<typeof threadStartResult>) => unknown,
    transport: StartParams["appServer"]["start"]["transport"] = "stdio",
  ) {
    const sessionFile = path.join(tempDir, `${threadId}.jsonl`);
    const cwd = path.join(tempDir, "workspace");
    const agentDir = path.join(tempDir, "agent");
    const response = threadStartResult(threadId);
    const requests: RpcRequest[] = [];
    const wire = await createLeasedLifecycleWireClient(
      agentDir,
      (request) => {
        requests.push(request);
        return respond(request, response);
      },
      transport,
    );
    const appServer = createThreadLifecycleAppServerOptions();
    const common = {
      client: wire.client,
      params: { ...createParams(sessionFile, cwd), agentDir },
      cwd,
      dynamicTools: [],
      appServer: { ...appServer, start: { ...appServer.start, transport } },
      userMcpServersEnabled: false,
      signal: new AbortController().signal,
    };
    const run = (developerInstructions: string, overrides: Partial<StartParams> = {}) =>
      startOrResumeThread({
        ...common,
        developerInstructions,
        ...overrides,
      });
    return { threadId, sessionFile, cwd, wire, requests, run };
  }
  function close(wire: ReturnType<typeof createClientHarness>) {
    releaseLeasedSharedCodexAppServerClient(wire.client);
    wire.client.close();
  }
  function configResult(method: string) {
    if (method === "config/read") {
      return { config: {}, origins: {}, layers: [] };
    }
    if (method === "configRequirements/read") {
      return { requirements: null };
    }
    throw new Error(`unexpected method: ${method}`);
  }
  const configReads = ["config/read", "configRequirements/read"];
  it.each(
    [
      { nativeStatus: "systemError", outcome: "unloaded", sibling: true },
      { nativeStatus: "idle", outcome: "unloaded", sibling: true },
      { nativeStatus: "systemError", outcome: "timeout", sibling: true },
      { nativeStatus: "idle", outcome: "timeout", sibling: false },
      { nativeStatus: "systemError", outcome: "timeout", sibling: false },
      { nativeStatus: "systemError", outcome: "abort", sibling: true },
      { nativeStatus: "idle", outcome: "unloaded", sibling: true, earlyClose: true },
      { nativeStatus: "idle", outcome: "unloaded", sibling: true, earlyClose: true, closing: 1 },
      { nativeStatus: "notLoaded", outcome: "unloaded", sibling: true },
      { nativeStatus: "notLoaded", outcome: "unloaded", sibling: true, closing: 1 },
      { nativeStatus: "notLoaded", outcome: "rejected", sibling: true, closing: 2 },
      { nativeStatus: "notLoaded", outcome: "timeout", sibling: true, closing: 1 },
      { nativeStatus: "notLoaded", outcome: "abort", sibling: true, closing: 1 },
      { nativeStatus: "notLoaded", outcome: "revoked", sibling: true, closing: 1 },
    ].map(({ nativeStatus, outcome, sibling, closing = 0, earlyClose = false }) => ({
      nativeStatus,
      outcome,
      sibling,
      closing,
      earlyClose,
    })),
  )(
    "preserves managed $nativeStatus history across $outcome with sibling=$sibling, closing=$closing, early=$earlyClose",
    async ({ nativeStatus, outcome, sibling, closing, earlyClose }) => {
      const unsubscribed = createDeferred<void>();
      const resumeRequested = createDeferred<void>();
      const rejectClosing = createDeferred<void>();
      const closingRejected = createDeferred<void>();
      const controller = new AbortController();
      const abandonClient = vi.fn(async () => {});
      let current = true;
      let resumeCount = 0;
      const { sessionFile, threadId, wire, requests, run } = await fixture(
        "managed-unload",
        async (request, response) => {
          switch (request.method) {
            case "thread/start":
              return response;
            case "thread/resume":
              resumeCount += 1;
              if (resumeCount <= closing) {
                resumeRequested.resolve();
                await rejectClosing.promise;
                closingRejected.resolve();
                throw new CodexAppServerRpcError(
                  {
                    code: -32_600,
                    message: `thread ${threadId} is closing; retry thread/resume after the thread is closed`,
                  },
                  "thread/resume",
                );
              }
              return response;
            case "thread/read":
              return { thread: { ...response.thread, status: { type: nativeStatus } } };
            case "thread/unsubscribe":
              vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
              if (earlyClose) {
                wire.send({ method: "thread/closed", params: { threadId } });
              }
              unsubscribed.resolve();
              return {
                status: nativeStatus === "notLoaded" && !closing ? "notLoaded" : "unsubscribed",
              };
            case "thread/inject_items":
              return {};
            default:
              return configResult(request.method);
          }
        },
      );
      const options = {
        signal: controller.signal,
        abandonClient,
        assertCurrent: () => {
          if (!current) {
            throw new Error("host authority ended");
          }
        },
      };
      const siblingOwner = sibling
        ? await claimCodexAppServerLiveThread(wire.client, "sibling")
        : undefined;
      try {
        const first = await run("old policy", options);
        await retainCodexAppServerLiveThread(
          wire.client,
          threadId,
          undefined,
          first.liveThreadConfigFingerprint,
        );
        const before = await readCodexAppServerBinding(sessionFile);
        const resumed = run("replacement policy", options);
        const expectedError =
          outcome === "abort" || outcome === "revoked"
            ? closing || outcome === "revoked"
              ? "handoff ended before replay"
              : "cancel unload"
            : outcome === "rejected" || closing
              ? "is closing"
              : nativeStatus === "systemError" && !sibling
                ? "fresh client is required"
                : "did not confirm unloading";
        const result =
          outcome === "unloaded"
            ? expect(resumed).resolves.toMatchObject({ threadId, lifecycle: { action: "resumed" } })
            : expect(resumed).rejects.toThrow(expectedError);
        await unsubscribed.promise;
        await vi.advanceTimersByTimeAsync(0);
        if (closing) {
          await resumeRequested.promise;
          // Consume most of the existing teardown budget before native rejects.
          await vi.advanceTimersByTimeAsync(1_500);
          rejectClosing.resolve();
          await closingRejected.promise;
          await vi.advanceTimersByTimeAsync(0);
        }
        wire.send({
          method: "thread/status/changed",
          params: { threadId: "sibling", status: { type: "notLoaded" } },
        });
        wire.send({ method: "thread/closed", params: { threadId: "unrelated-thread" } });
        if (!earlyClose) {
          wire.send({
            method: "thread/status/changed",
            params: { threadId, status: { type: "notLoaded" } },
          });
          await vi.advanceTimersByTimeAsync(0);
        }
        if (nativeStatus !== "notLoaded" && !earlyClose) {
          expect(resumeCount).toBe(0);
        }
        if (outcome === "unloaded" || outcome === "rejected" || outcome === "revoked") {
          if (outcome === "revoked") {
            current = false;
          }
          if (!earlyClose && (nativeStatus !== "notLoaded" || closing)) {
            wire.send({ method: "thread/closed", params: { threadId } });
          }
        } else if (outcome === "abort") {
          controller.abort(new Error("cancel unload"));
        } else {
          await vi.advanceTimersByTimeAsync(closing ? 500 : 2_000);
        }
        await result;
        expect(requests.filter(({ method }) => method === "thread/start")).toHaveLength(1);
        if (outcome === "unloaded") {
          expect(resumeCount).toBe(closing ? 2 : 1);
          const resumes = requests.filter(({ method }) => method === "thread/resume");
          if (closing) {
            expect(resumes[1]?.params).toEqual(resumes[0]?.params);
          }
          expect(requests.find(({ method }) => method === "thread/resume")?.params).toMatchObject({
            threadId,
            developerInstructions: expect.stringContaining("replacement policy"),
          });
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(threadId);
        } else {
          expect(resumeCount).toBe(outcome === "rejected" ? 2 : closing ? 1 : 0);
          expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
        }
        expect(requests.filter(({ method }) => method === "thread/unsubscribe")).toHaveLength(1);
        expect(abandonClient).toHaveBeenCalledTimes(
          outcome === "timeout" && nativeStatus === "systemError" && !sibling ? 1 : 0,
        );
        if (sibling) {
          expect(isCodexAppServerLiveThreadClaimed(wire.client, "sibling")).toBe(true);
        }
      } finally {
        vi.useRealTimers();
        await siblingOwner?.release("sibling");
        close(wire);
      }
    },
  );

  it.each([
    { developerInstructions: "", fault: "none", transport: "stdio" as const },
    {
      developerInstructions: "replacement policy",
      fault: "retirement failure",
      transport: "stdio" as const,
    },
  ])(
    "refreshes ordinary generic policy over $transport before admitting a resumed turn: $developerInstructions / $fault",
    async ({ developerInstructions, fault, transport }) => {
      const { sessionFile, cwd, threadId, wire, requests, run } = await fixture(
        "ordinary-policy",
        (request, response) => {
          if (request.method === "thread/read") {
            return { thread: { ...response.thread, status: { type: "notLoaded" } } };
          }
          if (request.method === "thread/resume") {
            return response;
          }
          if (request.method === "thread/inject_items") {
            if (fault === "retirement failure") {
              throw new CodexAppServerRpcError(
                { code: -32603, message: "policy flush failed after write" },
                "thread/inject_items",
              );
            }
            return {};
          }
          if (request.method === "thread/unsubscribe") {
            return { status: "unsubscribed" };
          }
          return configResult(request.method);
        },
        transport,
      );
      await writeCodexAppServerBinding(sessionFile, { threadId, cwd });
      const before = await readCodexAppServerBinding(sessionFile);
      try {
        const pending = run(
          developerInstructions,
          fault === "retirement failure"
            ? {
                abandonClient: async () => {
                  throw new Error("client retirement failed");
                },
              }
            : {},
        );
        if (fault !== "none") {
          await expect(pending).rejects.toBeInstanceOf(AgentHarnessPreflightError);
          await expect(pending).rejects.toMatchObject({
            name: "CodexThreadPolicyHandoffError",
            scope: undefined,
            outcome: "unknown",
          });
          expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
          expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
          expect(requests.filter(({ method }) => method === "thread/inject_items")).toHaveLength(1);
          expect(requests.some(({ method }) => method === "thread/start")).toBe(false);
          return;
        }
        expect((await pending).threadId).toBe(threadId);
        expect(requests.map(({ method }) => method)).toEqual([
          ...configReads,
          "thread/read",
          "thread/resume",
          "thread/inject_items",
        ]);
        const policy = JSON.stringify(requests.at(-1)?.params);
        expect(policy).toContain(developerInstructions || "<collaboration_mode>");
        expect(policy).toContain("It replaces earlier OpenClaw-supplied generic policy");
        expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(threadId);
      } finally {
        close(wire);
      }
    },
  );

  it.each([
    { nativeStatus: "idle", transport: "websocket" as const },
    { nativeStatus: "systemError", transport: "websocket" as const },
    { nativeStatus: "active", transport: "stdio" as const },
  ])(
    "keeps ordinary warm configuration honest over $transport across $nativeStatus",
    async ({ nativeStatus, transport }) => {
      const developerInstructions = "replacement policy";
      let subscribed = true;
      const { sessionFile, threadId, wire, requests, run } = await fixture(
        "ordinary-warm-policy",
        (request, response) => {
          if (request.method === "thread/unsubscribe" || request.method === "thread/resume") {
            expect(request.params).toMatchObject({ threadId });
          }
          if (request.method === "thread/start" || request.method === "thread/resume") {
            if (!subscribed && nativeStatus === "idle") {
              wire.send({
                method: "thread/status/changed",
                params: { threadId, status: { type: "notLoaded" } },
              });
            }
            subscribed = true;
            return response;
          }
          if (request.method === "thread/read") {
            return { thread: { ...response.thread, status: { type: nativeStatus } } };
          }
          if (request.method === "thread/unsubscribe") {
            subscribed = false;
            return { status: "unsubscribed" };
          }
          if (request.method === "thread/inject_items") {
            return {};
          }
          return configResult(request.method);
        },
        transport,
      );
      const notifications: string[] = [];
      const removeNotificationHandler = wire.client.addNotificationHandler((notification) => {
        notifications.push(notification.method);
      });
      try {
        const first = await run("initial policy");
        await retainCodexAppServerLiveThread(
          wire.client,
          first.threadId,
          undefined,
          first.liveThreadConfigFingerprint,
        );
        const resume = run(developerInstructions);
        if (nativeStatus === "active") {
          await expect(resume).rejects.toThrow("Codex session became active in another runner");
          expect(requests.map(({ method }) => method)).toEqual([
            ...configReads,
            "thread/start",
            ...configReads,
            "thread/read",
          ]);
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(first.threadId);
          return;
        }
        if (nativeStatus === "systemError") {
          await expect(resume).rejects.toThrow("did not confirm unloading");
          expect(requests.map(({ method }) => method)).not.toContain("thread/inject_items");
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(first.threadId);
          return;
        }
        const second = await resume;
        expect(second.threadId).toBe(first.threadId);
        expect(notifications).toContain("thread/status/changed");
        expect(notifications).not.toContain("thread/closed");
        expect(requests.map(({ method }) => method)).toEqual([
          ...configReads,
          "thread/start",
          ...configReads,
          "thread/read",
          "thread/unsubscribe",
          "thread/resume",
          "thread/inject_items",
        ]);
      } finally {
        removeNotificationHandler();
        close(wire);
      }
    },
  );
  it.each([
    { change: "policy", policy: "generic policy v2", skills: "## OpenClaw Skills\n\nweather" },
    { change: "skills", policy: "generic policy", skills: undefined },
    { change: "questions", policy: "generic policy", skills: "## OpenClaw Skills\n\nweather" },
    { change: "compaction", policy: "generic policy", skills: "## OpenClaw Skills\n\nweather" },
    {
      change: "compaction-scope",
      policy: "generic policy",
      skills: "## OpenClaw Skills\n\nweather",
    },
  ] as const)(
    "refreshes live incognito instructions but refuses generic policy drift ($change: $skills)",
    async ({ change, policy, skills }) => {
      const sessionFile = path.join(tempDir, "incognito-session.jsonl");
      const workspaceDir = path.join(tempDir, "incognito-workspace");
      const params = createParams(sessionFile, workspaceDir);
      params.sessionKey = "agent:main:dashboard:incognito-skill-refresh";
      let nativeQuestions = false;
      const request = vi.fn(async (method: string, _params?: unknown) => {
        if (method === "config/read") {
          return {
            layers: [],
            origins: {},
            config: {
              mcp_servers: {},
              features: { default_mode_request_user_input: nativeQuestions },
            },
          };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        if (method === "thread/start") {
          return threadStartResult("thread-incognito");
        }
        if (method === "thread/inject_items") {
          return {};
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const client = createUnobservedThreadClient("client-incognito", request) as never;
      ensureCodexAppServerClientRuntime(client, { agentDir: workspaceDir });
      const common = {
        client,
        params,
        userMcpServersEnabled: false,
      };
      const firstSkills =
        "## OpenClaw Skills\n\nweather\n\n<AGENT_SOUL>Original persona</AGENT_SOUL>";
      const first = await startOrResumeThread({
        ...common,
        developerInstructions: "generic policy",
        refreshableInstructions: firstSkills,
        ...(change === "compaction-scope"
          ? {
              config: {
                model_auto_compact_token_limit: 120_000,
                model_auto_compact_token_limit_scope: "body_after_prefix",
              },
            }
          : {}),
      });
      const genericPolicy = first.liveThreadEphemeralPolicy?.developerInstructions;
      expect(genericPolicy).toContain("generic policy");
      expect(genericPolicy).not.toContain(firstSkills);
      expect(first.liveThreadEphemeralPolicy).toEqual({
        autoCompactTokenLimitScope: "total",
        ...(change === "compaction-scope"
          ? { autoCompactTokenLimit: 120_000, autoCompactTokenLimitScope: "body_after_prefix" }
          : {}),
        developerInstructions: genericPolicy,
        refreshableInstructions: firstSkills,
        // Creation carries the catalog natively, so compaction restores this one.
        nativeRefreshableInstructions: firstSkills,
      });
      expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toEqual(
        expect.objectContaining({
          ephemeral: true,
          developerInstructions: `${genericPolicy}\n\n${firstSkills}`,
        }),
      );
      await retainCodexAppServerLiveThread(
        client,
        first.threadId,
        undefined,
        first.liveThreadConfigFingerprint,
        null,
        first.liveThreadEphemeralPolicy,
      );
      const threadCalls = () =>
        request.mock.calls
          .filter(([method]) => method.startsWith("thread/"))
          .map(([method, requestParams]) => [method, requestParams]);
      const secondTurn: Parameters<typeof startOrResumeThread>[0] = {
        ...common,
        developerInstructions: policy,
        refreshableInstructions: skills,
        ...(change === "compaction"
          ? { config: { model_auto_compact_token_limit: 260_000 } }
          : change === "compaction-scope"
            ? {
                config: {
                  model_auto_compact_token_limit: 120_000,
                  model_auto_compact_token_limit_scope: "total",
                },
              }
            : {}),
      };

      nativeQuestions = change === "questions";
      if (change !== "skills") {
        await expect(startOrResumeThread(secondTurn)).rejects.toBeInstanceOf(
          CodexIncognitoPolicyChangeError,
        );
        expect(threadCalls().map(([method]) => method)).toEqual(["thread/start"]);
        // The refusal keeps the ephemeral conversation retained for a corrected turn.
        expect(hasCodexAppServerLiveThread(client, first.threadId)).toBe(true);
        return;
      }

      const second = await startOrResumeThread(secondTurn);
      expect(second).toMatchObject({
        threadId: first.threadId,
        lifecycle: { action: "resumed" },
        liveThreadEphemeralPolicy: {
          developerInstructions: genericPolicy,
          refreshableInstructions: skills,
          // A refresh never rewrites native instructions, so the creation-time
          // catalog stays recorded as the one compaction will restore.
          nativeRefreshableInstructions: firstSkills,
        },
      });
      expect(threadCalls()).toEqual([
        ["thread/start", expect.objectContaining({ ephemeral: true })],
        [
          "thread/inject_items",
          {
            threadId: first.threadId,
            items: [
              {
                type: "message",
                role: "developer",
                content: [
                  {
                    type: "input_text",
                    text: expect.stringContaining(
                      skills ?? "The current OpenClaw refreshable thread instructions are empty",
                    ),
                  },
                ],
              },
            ],
          },
        ],
      ]);
      // The delivered catalog travels with the binding so cleanup retains it and
      // an unchanged catalog on the next turn is not re-delivered.
      await retainCodexAppServerLiveThread(
        client,
        second.threadId,
        second.liveThreadOwnership?.release,
        second.liveThreadConfigFingerprint,
        null,
        second.liveThreadEphemeralPolicy,
      );
      const third = await startOrResumeThread(secondTurn);
      expect(third.lifecycle).toEqual({ action: "resumed" });
      expect(threadCalls().map(([method]) => method)).toEqual([
        "thread/start",
        "thread/inject_items",
      ]);
    },
  );
}

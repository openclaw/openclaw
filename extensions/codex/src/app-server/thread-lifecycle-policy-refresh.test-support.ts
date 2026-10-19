import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import {
  claimCodexAppServerLiveThread,
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

type PolicyRefreshFixtures = {
  createParams: (sessionFile: string, workspaceDir: string) => StartParams["params"];
  createThreadLifecycleAppServerOptions: () => StartParams["appServer"];
  createLeasedLifecycleWireClient: (
    agentDir: string,
    respond: (request: RpcRequest) => unknown,
    transport: "stdio" | "websocket" | "unix" | "proxy",
  ) => Promise<ReturnType<typeof createClientHarness>>;
  startOrResumeThread: (params: StartParams) => ReturnType<typeof startOrResumeThreadImpl>;
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
  function fixture(threadId: string) {
    return {
      threadId,
      response: threadStartResult(threadId),
      sessionFile: path.join(tempDir, `${threadId}.jsonl`),
      cwd: path.join(tempDir, "workspace"),
      agentDir: path.join(tempDir, "agent"),
    };
  }
  function common(
    wire: Awaited<ReturnType<PolicyRefreshFixtures["createLeasedLifecycleWireClient"]>>,
    sessionFile: string,
    cwd: string,
  ) {
    return {
      client: wire.client,
      params: { ...createParams(sessionFile, cwd), agentDir: path.join(tempDir, "agent") },
      cwd,
      dynamicTools: [],
      appServer: createThreadLifecycleAppServerOptions(),
      userMcpServersEnabled: false,
      signal: new AbortController().signal,
    };
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
      const { sessionFile, cwd, agentDir, threadId, response } = fixture("managed-unload");
      const unsubscribed = createDeferred<void>();
      const resumeRequested = createDeferred<void>();
      const rejectClosing = createDeferred<void>();
      const closingRejected = createDeferred<void>();
      const requests: RpcRequest[] = [];
      const controller = new AbortController();
      const abandonClient = vi.fn(async () => {});
      let current = true;
      let resumeCount = 0;
      const wire = await createLeasedLifecycleWireClient(
        agentDir,
        async (request) => {
          requests.push(request);
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
        "stdio",
      );
      const options = {
        ...common(wire, sessionFile, cwd),
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
        const first = await startOrResumeThread({
          ...options,
          developerInstructions: "old policy",
        });
        await retainCodexAppServerLiveThread(
          wire.client,
          threadId,
          undefined,
          first.liveThreadConfigFingerprint,
        );
        const before = await readCodexAppServerBinding(sessionFile);
        const resumed = startOrResumeThread({
          ...options,
          developerInstructions: "replacement policy",
        });
        const result =
          outcome === "unloaded"
            ? expect(resumed).resolves.toMatchObject({ threadId, lifecycle: { action: "resumed" } })
            : expect(resumed).rejects.toThrow(
                outcome === "abort"
                  ? closing
                    ? "handoff ended before replay"
                    : "cancel unload"
                  : outcome === "revoked"
                    ? "handoff ended before replay"
                    : outcome === "rejected"
                      ? "is closing"
                      : closing
                        ? "is closing"
                        : nativeStatus === "systemError" && !sibling
                          ? "fresh client is required"
                          : "did not confirm unloading",
              );
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
            developerInstructions: "replacement policy",
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
      const { sessionFile, cwd, agentDir, threadId, response } = fixture("ordinary-policy");
      const requests: RpcRequest[] = [];
      const wire = await createLeasedLifecycleWireClient(
        agentDir,
        (request) => {
          requests.push(request);
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
        const run = startOrResumeThread({
          ...common(wire, sessionFile, cwd),
          developerInstructions,
          ...(fault === "retirement failure"
            ? {
                abandonClient: async () => {
                  throw new Error("client retirement failed");
                },
              }
            : {}),
        });
        if (fault !== "none") {
          await expect(run).rejects.toBeInstanceOf(AgentHarnessPreflightError);
          await expect(run).rejects.toMatchObject({
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
        expect((await run).threadId).toBe(threadId);
        expect(requests.map(({ method }) => method)).toEqual([
          ...configReads,
          "thread/read",
          "thread/resume",
          "thread/inject_items",
        ]);
        const policy = JSON.stringify(requests.at(-1)?.params);
        expect(policy).toContain(
          developerInstructions || "earlier OpenClaw generic policy is withdrawn",
        );
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
      const { sessionFile, cwd, agentDir, threadId, response } = fixture("ordinary-warm-policy");
      const methods: string[] = [];
      let subscribed = true;
      const wire = await createLeasedLifecycleWireClient(
        agentDir,
        (request) => {
          methods.push(request.method);
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
      const options = {
        ...common(wire, sessionFile, cwd),
        appServer: {
          ...createThreadLifecycleAppServerOptions(),
          start: { ...createThreadLifecycleAppServerOptions().start, transport },
        },
      };
      try {
        const first = await startOrResumeThread({
          ...options,
          developerInstructions: "initial policy",
        });
        await retainCodexAppServerLiveThread(
          wire.client,
          first.threadId,
          undefined,
          first.liveThreadConfigFingerprint,
        );
        const resume = startOrResumeThread({ ...options, developerInstructions });
        if (nativeStatus === "active") {
          await expect(resume).rejects.toThrow("Codex session became active in another runner");
          expect(methods).toEqual([...configReads, "thread/start", ...configReads, "thread/read"]);
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(first.threadId);
          return;
        }
        if (nativeStatus === "systemError") {
          await expect(resume).rejects.toThrow("did not confirm unloading");
          expect(methods).not.toContain("thread/inject_items");
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(first.threadId);
          return;
        }
        const second = await resume;
        expect(second.threadId).toBe(first.threadId);
        expect(notifications).toContain("thread/status/changed");
        expect(notifications).not.toContain("thread/closed");
        expect(methods).toEqual([
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
}

import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it, vi } from "vitest";
import { retainCodexAppServerLiveThread } from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import type { RpcRequest } from "./protocol.js";
import { tempDir, threadStartResult } from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
  type writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import {
  releaseLeasedSharedCodexAppServerClient,
  retireSharedCodexAppServerClientIfCurrent,
} from "./shared-client.js";
import type { createClientHarness } from "./test-support.js";
import type { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";

type StartParams = Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">;

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
  it.each(
    [
      { developerInstructions: "replacement policy", fault: "none" },
      { developerInstructions: "", fault: "none" },
      { developerInstructions: "replacement policy", fault: "unload" },
      { developerInstructions: "replacement policy", fault: "client retired" },
      { developerInstructions: "replacement policy", fault: "unknown write" },
      { developerInstructions: "replacement policy", fault: "retirement failure" },
      { developerInstructions: "replacement policy", fault: "binding commit" },
    ].flatMap((scenario) =>
      (["stdio", "websocket", "unix", "proxy"] as const).map((transport) => ({
        developerInstructions: scenario.developerInstructions,
        fault: scenario.fault,
        transport,
      })),
    ),
  )(
    "refreshes ordinary generic policy over $transport before admitting a resumed turn: $developerInstructions / $fault",
    async ({ developerInstructions, fault, transport }) => {
      const sessionFile = path.join(tempDir, "ordinary-policy.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const threadId = "ordinary-policy";
      const response = threadStartResult(threadId);
      const requests: RpcRequest[] = [];
      const wire = await createLeasedLifecycleWireClient(
        path.join(tempDir, "agent"),
        (request) => {
          requests.push(request);
          if (request.method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (request.method === "configRequirements/read") {
            return { requirements: null };
          }
          if (request.method === "thread/read") {
            return {
              thread: {
                ...response.thread,
                status: { type: fault === "unload" ? "idle" : "notLoaded" },
              },
            };
          }
          if (request.method === "thread/resume") {
            if (fault === "client retired") {
              retireSharedCodexAppServerClientIfCurrent(wire.client);
            }
            return response;
          }
          if (request.method === "thread/inject_items") {
            if (fault === "unknown write" || fault === "retirement failure") {
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
          throw new Error(`unexpected method: ${request.method}`);
        },
        transport,
      );
      await writeCodexAppServerBinding(sessionFile, { threadId, cwd: workspaceDir });
      const before = await readCodexAppServerBinding(sessionFile);
      if (fault === "binding commit") {
        vi.spyOn(testCodexAppServerBindingStore, "mutate").mockRejectedValueOnce(
          new Error("binding commit failed"),
        );
      }
      try {
        const run = startOrResumeThread({
          client: wire.client,
          params: {
            ...createParams(sessionFile, workspaceDir),
            agentDir: path.join(tempDir, "agent"),
          },
          cwd: workspaceDir,
          dynamicTools: [],
          appServer: createThreadLifecycleAppServerOptions(),
          userMcpServersEnabled: false,
          developerInstructions,
          signal: new AbortController().signal,
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
            outcome:
              fault === "unknown write" || fault === "retirement failure"
                ? "unknown"
                : fault === "binding commit"
                  ? "acknowledged"
                  : "not-written",
          });
          expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
          expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
          expect(requests.filter(({ method }) => method === "thread/inject_items")).toHaveLength(
            fault === "unknown write" ||
              fault === "retirement failure" ||
              fault === "binding commit"
              ? 1
              : 0,
          );
          expect(requests.some(({ method }) => method === "thread/start")).toBe(false);
          return;
        }
        expect((await run).threadId).toBe(threadId);
        expect(requests.map(({ method }) => method)).toEqual([
          "config/read",
          "configRequirements/read",
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
        releaseLeasedSharedCodexAppServerClient(wire.client);
        wire.client.close();
      }
    },
  );

  it.each(
    ["idle", "systemError", "active"].flatMap((nativeStatus) =>
      (nativeStatus === "active"
        ? ["replacement policy"]
        : ["initial policy", "replacement policy", ""]
      ).flatMap((developerInstructions) =>
        (["stdio", "websocket", "unix", "proxy"] as const).map((transport) => ({
          nativeStatus,
          developerInstructions,
          transport,
        })),
      ),
    ),
  )(
    "keeps ordinary warm configuration honest over $transport across $nativeStatus and policy $developerInstructions",
    async ({ nativeStatus, developerInstructions, transport }) => {
      const sessionFile = path.join(tempDir, "ordinary-warm-policy.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const threadId = "ordinary-warm-policy";
      const response = threadStartResult(threadId);
      const methods: string[] = [];
      let subscribed = true;
      const wire = await createLeasedLifecycleWireClient(
        path.join(tempDir, "agent"),
        (request) => {
          methods.push(request.method);
          if (request.method === "thread/unsubscribe" || request.method === "thread/resume") {
            expect(request.params).toMatchObject({ threadId });
          }
          if (request.method === "config/read") {
            return { config: {}, origins: {}, layers: [] };
          }
          if (request.method === "configRequirements/read") {
            return { requirements: null };
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
          throw new Error(`unexpected method: ${request.method}`);
        },
        transport,
      );
      const common = {
        client: wire.client,
        params: {
          ...createParams(sessionFile, workspaceDir),
          agentDir: path.join(tempDir, "agent"),
        },
        cwd: workspaceDir,
        dynamicTools: [],
        appServer: createThreadLifecycleAppServerOptions(),
        userMcpServersEnabled: false,
        signal: new AbortController().signal,
      };
      try {
        const first = await startOrResumeThread({
          ...common,
          developerInstructions: "initial policy",
        });
        await retainCodexAppServerLiveThread(
          wire.client,
          first.threadId,
          undefined,
          first.liveThreadConfigFingerprint,
        );
        const resume = startOrResumeThread({ ...common, developerInstructions });
        if (nativeStatus === "active") {
          await expect(resume).rejects.toThrow("Codex session became active in another runner");
          expect(methods).toEqual([
            "config/read",
            "configRequirements/read",
            "thread/start",
            "config/read",
            "configRequirements/read",
            "thread/read",
          ]);
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(first.threadId);
          return;
        }
        if (nativeStatus === "systemError" && developerInstructions !== "initial policy") {
          await expect(resume).rejects.toThrow("did not confirm unloading");
          expect(methods).not.toContain("thread/inject_items");
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(first.threadId);
          return;
        }
        const second = await resume;
        expect(second.threadId).toBe(first.threadId);
        expect(methods).toEqual(
          developerInstructions === "initial policy"
            ? [
                "config/read",
                "configRequirements/read",
                "thread/start",
                "config/read",
                "configRequirements/read",
              ]
            : [
                "config/read",
                "configRequirements/read",
                "thread/start",
                "config/read",
                "configRequirements/read",
                "thread/read",
                "thread/unsubscribe",
                "thread/resume",
                "thread/inject_items",
              ],
        );
      } finally {
        releaseLeasedSharedCodexAppServerClient(wire.client);
        wire.client.close();
      }
    },
  );
}

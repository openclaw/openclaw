import path from "node:path";
import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { expect, it } from "vitest";
import {
  protectCodexAppServerLiveThread,
  releaseCodexAppServerLiveThread,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { CodexAppServerRpcError } from "./client.js";
import type { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
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
  createManualResumeFixture: (options: { wireClient: true }) => Promise<
    Pick<ReturnType<typeof createFakeCodexAppServerClient>, "client" | "request" | "close"> & {
      sessionFile: string;
      threadId: string;
      start: () => ReturnType<typeof startOrResumeThreadImpl>;
    }
  >;
  writeCodexAppServerBinding: typeof writeRawCodexAppServerBinding;
};

/** Keep policy refresh cases under the binding suite's existing lifecycle setup and cleanup. */
export function registerThreadPolicyRefreshTests({
  createParams,
  createThreadLifecycleAppServerOptions,
  createLeasedLifecycleWireClient,
  startOrResumeThread,
  createManualResumeFixture,
  writeCodexAppServerBinding,
}: PolicyRefreshFixtures) {
  it.each([
    { developerInstructions: "", fault: "none", transport: "stdio" as const },
    ...["unload", "retirement failure"].map((fault) => ({
      developerInstructions: "replacement policy",
      fault,
      transport: "stdio" as const,
    })),
  ])(
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
          throw new Error(`unexpected method: ${request.method}`);
        },
        transport,
      );
      await writeCodexAppServerBinding(sessionFile, { threadId, cwd: workspaceDir });
      const before = await readCodexAppServerBinding(sessionFile);
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
            outcome: fault === "retirement failure" ? "unknown" : "not-written",
          });
          expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
          expect(requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
          expect(requests.filter(({ method }) => method === "thread/inject_items")).toHaveLength(
            fault === "retirement failure" ? 1 : 0,
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

  it.each([
    { nativeStatus: "idle", transport: "websocket" as const, owner: "retained" },
    { nativeStatus: "systemError", transport: "stdio" as const, owner: "retained" },
    { nativeStatus: "active", transport: "stdio" as const, owner: "retained" },
    ...["missing", "released", "previous-available", "previous-lost", "sibling", "protected"].map(
      (owner) => ({ nativeStatus: "idle", transport: "stdio" as const, owner }),
    ),
  ])(
    "keeps ordinary warm configuration honest over $transport across $nativeStatus ($owner owner)",
    async ({ nativeStatus, transport, owner }) => {
      const developerInstructions = "replacement policy";
      const sessionFile = path.join(tempDir, "ordinary-warm-policy.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const threadId = "ordinary-warm-policy";
      const response = threadStartResult(threadId);
      const methods: string[] = [];
      let subscribed = true;
      let previousSubscribed = false;
      let previous: Awaited<ReturnType<typeof createLeasedLifecycleWireClient>> | undefined;
      let unprotect: (() => void) | undefined;
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
            if (
              !subscribed &&
              !previousSubscribed &&
              owner !== "sibling" &&
              nativeStatus === "idle"
            ) {
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
        if (owner === "retained" || owner === "released") {
          await retainCodexAppServerLiveThread(
            wire.client,
            first.threadId,
            undefined,
            first.liveThreadConfigFingerprint,
          );
        }
        if (owner === "released") {
          await expect(releaseCodexAppServerLiveThread(wire.client, first.threadId)).resolves.toBe(
            true,
          );
        }
        if (owner === "previous-available") {
          previous = await createLeasedLifecycleWireClient(
            path.join(tempDir, "previous-agent"),
            (request) => {
              expect(request.params).toMatchObject({ threadId });
              if (request.method === "thread/resume") {
                previousSubscribed = true;
                return response;
              }
              if (request.method === "thread/unsubscribe") {
                methods.push("previous/unsubscribe");
                previousSubscribed = false;
                return { status: "unsubscribed" };
              }
              throw new Error(`unexpected previous-client method: ${request.method}`);
            },
            "stdio",
          );
          await previous.client.request("thread/resume", { threadId }, { timeoutMs: 5_000 });
          await retainCodexAppServerLiveThread(previous.client, threadId);
          // The idle subscription keeps this owner available; no unrelated lease
          // should prevent the lifecycle from waiting for its eventual retirement.
          releaseLeasedSharedCodexAppServerClient(previous.client);
        }
        if (owner === "previous-available" || owner === "previous-lost") {
          await writeCodexAppServerBinding(sessionFile, {
            ...(await readCodexAppServerBinding(sessionFile))!,
            clientId: previous?.client.getInstanceId() ?? "missing-previous-physical-client",
          });
        }
        if (owner === "protected") {
          unprotect = protectCodexAppServerLiveThread(wire.client, threadId);
        }
        const before = await readCodexAppServerBinding(sessionFile);
        const resume = startOrResumeThread({ ...common, developerInstructions });
        if (owner === "sibling" || owner === "protected") {
          await expect(resume).rejects.toThrow(
            owner === "protected" ? "claimed by active work" : "did not confirm unloading",
          );
          // A rejected accepted resume also releases its newly acquired subscription.
          expect(methods.filter((method) => method === "thread/unsubscribe")).toHaveLength(
            owner === "protected" ? 0 : 2,
          );
          expect(methods).not.toContain("thread/inject_items");
          expect(await readCodexAppServerBinding(sessionFile)).toEqual(before);
          return;
        }
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
        if (nativeStatus === "systemError") {
          await expect(resume).rejects.toThrow("did not confirm unloading");
          expect(methods).not.toContain("thread/inject_items");
          expect((await readCodexAppServerBinding(sessionFile))?.threadId).toBe(first.threadId);
          return;
        }
        const second = await resume;
        expect(second.threadId).toBe(first.threadId);
        expect(methods).toEqual([
          "config/read",
          "configRequirements/read",
          "thread/start",
          ...(owner === "released" ? ["thread/unsubscribe"] : []),
          "config/read",
          "configRequirements/read",
          "thread/read",
          ...(owner === "previous-available" ? ["previous/unsubscribe"] : []),
          ...(owner === "released" ? [] : ["thread/unsubscribe"]),
          "thread/resume",
          "thread/inject_items",
        ]);
        if (owner === "released") {
          // The completed release belongs to the old subscription, not the next resume.
          await expect(
            startOrResumeThread({ ...common, developerInstructions: "third policy" }),
          ).resolves.toMatchObject({ threadId });
          expect(methods.filter((method) => method === "thread/unsubscribe")).toHaveLength(2);
        }
      } finally {
        unprotect?.();
        if (previous) {
          releaseLeasedSharedCodexAppServerClient(previous.client);
          previous.client.close();
        }
        releaseLeasedSharedCodexAppServerClient(wire.client);
        wire.client.close();
      }
    },
  );

  it("resumes a manually attached thread without repeating its acknowledged unsubscribe", async () => {
    const fixture = await createManualResumeFixture({ wireClient: true });
    try {
      await expect(releaseCodexAppServerLiveThread(fixture.client, fixture.threadId)).resolves.toBe(
        true,
      );
      await expect(fixture.start()).resolves.toMatchObject({ threadId: fixture.threadId });
      expect(
        fixture.request.mock.calls.filter(([method]) => method === "thread/unsubscribe"),
      ).toHaveLength(1);
      expect(
        (await readCodexAppServerBinding(fixture.sessionFile))?.pendingResumeConfiguration,
      ).toBeUndefined();
    } finally {
      fixture.close();
    }
  });
}

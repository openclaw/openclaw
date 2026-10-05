import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { describe, expect, it, vi } from "vitest";
import { startWorkerCodexAppServerClient } from "./node-app-server-transport.js";
import { getSharedCodexAppServerClientState } from "./shared-client-lifecycle.js";
import { captureCodexAppServerClientLifetime } from "./shared-client.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

describe("worker Codex app-server transport", () => {
  it.each(["remote_resolved", "remote_rejected", "local_close"] as const)(
    "observes %s duplex settlement once without remote error text",
    async (outcome) => {
      vi.stubEnv("FACTORY_WORKER_LLM_CONFIG_VERSION", "a".repeat(64));
      const info = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
      let resolveClosed!: () => void;
      let rejectClosed!: (error: Error) => void;
      const closed = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
      });
      let listener: ((message: Uint8Array) => void | Promise<void>) | undefined;
      const close = vi.fn(() => {
        if (outcome !== "local_close") {
          resolveClosed();
        }
      });
      const runtime = {
        nodes: {
          openDuplex: async () => ({
            send: async (message: Uint8Array) => {
              const outgoing = JSON.parse(Buffer.from(message).toString("utf8")) as {
                id?: number;
                method: string;
              };
              if (outgoing.method === "initialize") {
                await listener?.(
                  Buffer.from(
                    JSON.stringify({
                      id: outgoing.id,
                      result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (Linux; test)` },
                    }),
                  ),
                );
              }
            },
            onMessage: (next: typeof listener) => {
              listener = next;
              return () => {
                listener = undefined;
              };
            },
            closed,
            close,
          }),
        },
      } as unknown as PluginRuntime;
      const sandbox = {
        enabled: true,
        backendId: "node",
        containerWorkdir: "/worker/repo",
        placementNodeId: "worker-node",
        placementEnvironmentId: "worker-environment",
        placementSessionId: "worker-session",
        placementOwnerEpoch: 3,
        sessionKey: "agent:main:worker-session",
      } as unknown as SandboxContext;
      try {
        const client = await startWorkerCodexAppServerClient({
          runtime,
          sandbox,
          signal: new AbortController().signal,
          assertCurrent: () => {},
        });
        const privateMarker = "private-duplex-error:";
        const privateText =
          "Codex node app-server diagnostic exceeded 4 KiB; " +
          privateMarker +
          "x".repeat(4096 - privateMarker.length);
        if (outcome === "remote_rejected") {
          rejectClosed(new Error(privateText));
        } else if (outcome === "remote_resolved") {
          resolveClosed();
        } else {
          await client.closeAndWait();
        }
        if (outcome !== "local_close") {
          await closed.catch(() => undefined);
        }
        await Promise.resolve();
        await client.closeAndWait();
        const observations = [...info.mock.calls, ...warn.mock.calls].filter(
          ([message]) => message === "worker_codex_duplex_closed",
        );
        expect(observations).toHaveLength(1);
        expect(observations[0]).toEqual([
          "worker_codex_duplex_closed",
          {
            nodeId: "worker-node",
            environmentId: "worker-environment",
            sessionId: "worker-session",
            origin: outcome === "local_close" ? "local_stdin_final" : outcome,
            syntheticExitCode: outcome === "remote_rejected" ? 1 : 0,
            openedAtMs: expect.any(Number),
            lifetimeMs: expect.any(Number),
            ...(outcome === "remote_rejected" ? { errorCode: "node_stderr_limit" } : {}),
          },
        ]);
        expect(
          warn.mock.calls.filter(([message]) => message === "worker_codex_duplex_closed"),
        ).toHaveLength(outcome === "remote_rejected" ? 1 : 0);
        expect(JSON.stringify(observations)).not.toContain(privateMarker);
      } finally {
        info.mockRestore();
        warn.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("initializes each placement client and closes a failed startup", async () => {
    const diagnostics = vi.spyOn(embeddedAgentLog, "info").mockImplementation(() => undefined);
    vi.stubEnv("FACTORY_WORKER_LLM_CONFIG_VERSION", "a".repeat(64));
    const invocations: Array<Record<string, unknown>> = [];
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const messages: string[][] = [];
    const delivered = createDeferred<void>();
    const deliveryPublished = createDeferred<void>();
    let failInitialization = false;
    const runtime = {
      nodes: {
        openDuplex: vi.fn(async (request: Record<string, unknown>) => {
          invocations.push(request);
          const sent: string[] = [];
          messages.push(sent);
          let initialized = false;
          let listener: ((message: Uint8Array) => void | Promise<void>) | undefined;
          let resolveClosed!: () => void;
          const closed = new Promise<void>((resolve) => {
            resolveClosed = resolve;
          });
          const close = vi.fn(() => resolveClosed());
          closes.push(close);
          return {
            send: async (message: Uint8Array) => {
              const outgoing = JSON.parse(Buffer.from(message).toString("utf8")) as {
                id?: number;
                method: string;
              };
              sent.push(outgoing.method);
              if (outgoing.method === "initialized") {
                initialized = true;
                return;
              }
              await listener?.(
                Buffer.from(
                  JSON.stringify({
                    id: outgoing.id,
                    ...(outgoing.method === "initialize" && failInitialization
                      ? { error: { code: -32600, message: "Not initialized" } }
                      : outgoing.method === "initialize"
                        ? {
                            result: {
                              userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (Linux; test)`,
                            },
                          }
                        : initialized
                          ? { result: { models: [] } }
                          : { error: { code: -32600, message: "Not initialized" } }),
                  }),
                ),
              );
              if (outgoing.method === "openclaw/resources/settle") {
                deliveryPublished.resolve();
              }
            },
            onMessage: (next: typeof listener) => {
              listener = next;
              return () => {
                listener = undefined;
              };
            },
            closed,
            close,
          };
        }),
      },
    } as unknown as PluginRuntime;
    const sandbox = {
      enabled: true,
      backendId: "node",
      containerWorkdir: "/worker/repo",
      placementNodeId: "worker-node",
      placementEnvironmentId: "worker-environment",
      placementSessionId: "worker-session",
      placementOwnerEpoch: 3,
      sessionKey: "agent:main:worker-session",
    } as unknown as SandboxContext;

    for (let turn = 0; turn < 2; turn++) {
      const client = await startWorkerCodexAppServerClient({
        runtime,
        sandbox: {
          ...sandbox,
          ...(turn === 1
            ? {
                resourceReadiness: { wait: async () => delivered.promise, assertCurrent: () => {} },
              }
            : {}),
        },
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      expect(getSharedCodexAppServerClientState().isolatedClients.has(client)).toBe(true);
      expect(client.getCloseError()).toBeFalsy();
      const assertConnection = captureCodexAppServerClientLifetime(client, "connection");
      const assertConfiguration = captureCodexAppServerClientLifetime(
        client,
        "thread-configuration",
      );
      expect(assertConnection).not.toThrow();
      expect(assertConfiguration).not.toThrow();
      await expect(client.request("model/list", {})).resolves.toEqual({ models: [] });
      if (turn === 1) {
        expect(messages[1]).not.toContain("openclaw/resources/settle");
        expect(invocations[1]).toMatchObject({
          params: { resourcePreparationRequired: true },
          requiredCommandFeatures: ["private-resource-readiness"],
        });
        delivered.resolve();
        await deliveryPublished.promise;
      }
      await client.closeAndWait();
      expect(assertConnection).toThrow(
        "Codex app-server connection changed during thread preparation",
      );
      expect(assertConfiguration).toThrow(
        "Codex app-server connection changed during thread preparation",
      );
    }
    failInitialization = true;
    await expect(
      startWorkerCodexAppServerClient({
        runtime,
        sandbox,
        signal: new AbortController().signal,
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("Not initialized");
    expect(invocations).toHaveLength(3);
    expect(messages).toEqual([
      ["initialize", "initialized", "model/list"],
      ["initialize", "initialized", "model/list", "openclaw/resources/settle"],
      ["initialize"],
    ]);
    const initialize = diagnostics.mock.calls.filter(
      ([name]) => name === "worker_codex_initialize",
    );
    expect(initialize).toHaveLength(3);
    expect(initialize.map(([, fields]) => fields?.outcome)).toEqual([
      "succeeded",
      "succeeded",
      "failed",
    ]);
    expect(diagnostics).toHaveBeenCalledWith(
      "worker_codex_startup",
      expect.objectContaining({
        name: "initialize",
        status: "error",
        sessionId: "worker-session",
        ownerEpoch: 3,
      }),
    );
    diagnostics.mockRestore();
    expect(invocations.map((request) => request.command)).toEqual([
      `codex.app-server.stdio.v1.${"a".repeat(64)}`,
      `codex.app-server.stdio.v1.${"a".repeat(64)}`,
      `codex.app-server.stdio.v1.${"a".repeat(64)}`,
    ]);
    expect(invocations[0]?.params).toEqual({
      authorization: "session-full",
      placement: {
        cwd: "/worker/repo",
        environmentId: "worker-environment",
        sessionId: "worker-session",
        ownerEpoch: 3,
        sessionKey: "agent:main:worker-session",
      },
    });
    expect(closes).toHaveLength(3);
    expect(closes.every((close) => close.mock.calls.length > 0)).toBe(true);
    vi.unstubAllEnvs();
  });
});

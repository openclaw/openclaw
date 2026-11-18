/** A caller-owned app-server client over the placement's authorized node duplex. */
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  prepareWorkerGitHubBindingGrant,
  type WorkerGitHubBindingRefresh,
} from "openclaw/plugin-sdk/github-worker-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createBoundedLineFramer } from "openclaw/plugin-sdk/process-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexWorkerAppServerCommand } from "../node-app-server-command.js";
import { applyCodexAppServerAuthProfile } from "./auth-bridge.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { CodexAppServerClient } from "./client.js";
import { readCodexPlacementWorkspaceIdentity } from "./sandbox-exec-server.js";
import { trackIsolatedCodexAppServerClient } from "./shared-client-lifecycle.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import type { CodexAppServerTransport } from "./transport.js";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;

export function createCodexWorkerClientFactory(params: {
  runtime?: Pick<PluginRuntime, "nodes">;
  agentId?: string;
  permissionMode?: EmbeddedRunAttemptParamsV2["permissionMode"];
  sandbox: SandboxContext;
  signal: AbortSignal;
  assertCurrent: () => void;
  workspaceReadiness?: EmbeddedRunAttemptParamsV2["hostCapabilities"]["workspaceReadiness"];
}): CodexAppServerClientFactory {
  const { runtime, sandbox } = params;
  const nodeId = "placementNodeId" in sandbox ? sandbox.placementNodeId : undefined;
  if (
    !sandbox.enabled ||
    !runtime ||
    typeof nodeId !== "string" ||
    !nodeId ||
    params.permissionMode !== "full"
  ) {
    throw new Error("Worker-hosted Codex requires an enrolled node and Full runtime authority");
  }
  return async (options) => {
    const signal = options?.abandonSignal
      ? AbortSignal.any([params.signal, options.abandonSignal])
      : params.signal;
    const assertCurrent = () => {
      signal.throwIfAborted();
      params.assertCurrent();
      options?.assertCurrent?.();
    };
    assertCurrent();
    await options?.assertCurrentAsync?.();
    assertCurrent();
    const workspace = readCodexPlacementWorkspaceIdentity(params.sandbox);
    const grant = params.agentId
      ? await prepareWorkerGitHubBindingGrant({
          sessionId: workspace.sessionId,
          sessionKey: workspace.sessionKey,
          agentId: params.agentId,
          signal,
          assertCurrent: () => {
            assertCurrent();
            return true;
          },
        })
      : undefined;
    let acquiredChannel: Awaited<ReturnType<PluginRuntime["nodes"]["openDuplex"]>> | undefined;
    try {
      assertCurrent();
      grant?.assertCurrent();
      acquiredChannel = await runtime.nodes.openDuplex({
        nodeId,
        command: resolveCodexWorkerAppServerCommand(process.env, true),
        params: {
          placement: { cwd: params.sandbox.containerWorkdir, ...workspace },
          authorization: "session-full",
          ...(grant ? { github: grant.binding } : {}),
          ...(params.workspaceReadiness ? { resourcePreparationRequired: true } : {}),
        },
        sessionKey: params.sandbox.sessionKey,
        timeoutMs: 0,
        maxMessageBytes: MAX_FRAME_BYTES,
        maxOutstandingDeliveryBytes: MAX_FRAME_BYTES + 2 * 1024 * 1024,
        signal: grant ? AbortSignal.any([signal, grant.signal]) : signal,
        assertCurrent: () => {
          assertCurrent();
          grant?.assertCurrent();
        },
      });
      assertCurrent();
      grant?.assertCurrent();
    } catch (error) {
      acquiredChannel?.close();
      await grant?.revoke();
      throw error;
    }
    const channel = acquiredChannel;
    let renewalTimer: ReturnType<typeof setInterval> | undefined;
    let renewalWork: Promise<void> | undefined;
    let grantRevocation: Promise<void> | undefined;
    const events = new EventEmitter();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let closed = false;
    let exitCode: number | null = null;
    let signalCode: string | null = null;
    let exitError: Error | undefined;
    let nativeExit: { code: number | null; signal: string | null } | undefined;
    const finish = (local: boolean, error?: unknown) => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(renewalTimer);
      grantRevocation = Promise.resolve().then(async () => {
        try {
          await grant?.revoke();
        } finally {
          await renewalWork?.catch(() => {});
        }
      });
      void grantRevocation.catch(() =>
        embeddedAgentLog.warn(
          "Worker GitHub credential cleanup failed; the token may remain valid until expiry.",
        ),
      );
      signal.removeEventListener("abort", onAbort);
      unsubscribe?.();
      if (nativeExit) {
        exitCode = nativeExit.code;
        signalCode = nativeExit.signal;
      }
      exitError = new Error(
        nativeExit
          ? "Worker app-server exited (code " +
              String(nativeExit.code) +
              ", signal " +
              String(nativeExit.signal) +
              ")"
          : local
            ? "Worker app-server closed by its caller"
            : "Worker app-server disconnected",
        error === undefined ? undefined : { cause: error },
      );
      channel.close();
      stdout.end();
      stderr.end();
      events.emit("exit", exitCode, signalCode);
    };
    const onAbort = () => finish(true);
    const framer = createBoundedLineFramer(
      MAX_FRAME_BYTES,
      "Worker app-server request exceeds 64 MiB",
    );
    const stdin = new Writable({
      write(chunk, _encoding, callback) {
        void (async () => {
          if (closed) {
            throw new Error("Worker app-server is closed");
          }
          for (const frame of framer.push(Buffer.from(chunk))) {
            assertCurrent();
            await channel.send(frame);
          }
        })().then(
          () => callback(),
          (error: unknown) => {
            finish(true, error);
            callback(error instanceof Error ? error : new Error("Worker transport write failed"));
          },
        );
      },
      final(callback) {
        finish(true);
        callback();
      },
    });
    const transport: CodexAppServerTransport = {
      stdin,
      stdout,
      stderr,
      get closed() {
        return closed;
      },
      get exitCode() {
        return exitCode;
      },
      get signalCode() {
        return signalCode;
      },
      get exitError() {
        return exitError;
      },
      kill: () => {
        finish(true);
        return true;
      },
      once: (event, listener) => events.once(event, listener),
      off: (event, listener) => events.off(event, listener),
      waitForCleanup: async () => {
        await channel.closed.catch(() => undefined);
        await grantRevocation;
      },
    };
    const client = CodexAppServerClient.fromTransport(transport);
    // Thread custody belongs to this physical client, but credentials stay on
    // the worker. Later attempt initialization must not adopt Gateway auth.
    ensureCodexAppServerClientRuntime(client, { config: options?.config });
    trackIsolatedCodexAppServerClient(client);
    const unsubscribe = channel.onMessage(async (frame) => {
      if (closed) {
        return;
      }
      if (!frame.byteLength || frame.byteLength > MAX_FRAME_BYTES) {
        finish(false, new Error("Worker response frame is invalid"));
        return;
      }
      const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
      if (isRecord(message) && message.method === "openclaw/process/exited") {
        const value = message.params;
        if (
          !isRecord(value) ||
          !(
            value.code === null ||
            (typeof value.code === "number" && Number.isInteger(value.code))
          ) ||
          !(value.signal === null || typeof value.signal === "string")
        ) {
          throw new Error("Worker exit receipt is invalid");
        }
        nativeExit = { code: value.code, signal: value.signal };
        return;
      }
      if (!stdout.write(Buffer.concat([Buffer.from(frame), Buffer.from("\n")]))) {
        await Promise.race([once(stdout, "drain"), channel.closed]);
      }
    });
    void channel.closed.then(
      () => finish(false),
      (error: unknown) => finish(false, error),
    );
    signal.addEventListener("abort", onAbort, { once: true });
    options?.onStartedClient?.(client);
    try {
      assertCurrent();
      await client.initialize();
      assertCurrent();
      // Verify the worker-owned account without resolving or transferring host credentials.
      await applyCodexAppServerAuthProfile({
        client,
        authProfileId: null,
        authRequirement: options?.authRequirement,
        assertCurrent,
        assertCurrentAsync: options?.assertCurrentAsync,
      });
      assertCurrent();
      if (params.workspaceReadiness) {
        const readiness = params.workspaceReadiness;
        void (async () => {
          let status: "ready" | "failed" = "ready";
          try {
            await readiness.waitUntilReady();
          } catch {
            status = "failed";
          }
          assertCurrent();
          await client.request("openclaw/resources/settle", { status }, { signal, assertCurrent });
        })().catch(() => finish(true));
      }
      if (grant) {
        const currentGrant = grant;
        const assertRenewalCurrent = () => {
          signal.throwIfAborted();
          assertCurrent();
          currentGrant.assertCurrent();
          if (closed) {
            throw new Error("Worker GitHub transport closed");
          }
        };
        const install = async (update: WorkerGitHubBindingRefresh, errorMessage: string) => {
          const acknowledged = await client.request("openclaw/github/refresh", update, {
            timeoutMs: 15_000,
            signal: currentGrant.signal,
            assertCurrent: assertRenewalCurrent,
          });
          assertRenewalCurrent();
          if (!isRecord(acknowledged) || acknowledged.generation !== update.generation) {
            throw new Error(errorMessage);
          }
        };
        // Initial installation and renewal must both acknowledge the exact generation.
        await install(
          { generation: 0, token: currentGrant.binding.token },
          "Worker GitHub credential installer is unavailable; update the worker bundle",
        );
        let installedGeneration = 0;
        renewalTimer = setInterval(() => {
          if (closed || renewalWork) {
            return;
          }
          renewalWork = (async () => {
            assertRenewalCurrent();
            const update = await currentGrant.refresh(installedGeneration);
            assertRenewalCurrent();
            if (!update) {
              return;
            }
            await install(update, "Worker GitHub credential installation was not acknowledged");
            installedGeneration = update.generation;
            await currentGrant.refresh(installedGeneration);
            assertRenewalCurrent();
          })()
            .catch(() => {
              // Unknown installation cannot extend the old credential's admitted lifetime.
              if (!closed) {
                finish(true, new Error("Worker GitHub credential renewal failed"));
              }
            })
            .finally(() => {
              renewalWork = undefined;
            });
        }, 30_000);
        renewalTimer.unref?.();
      }
      return client;
    } catch (error) {
      await client.closeAndWait();
      throw error;
    }
  };
}

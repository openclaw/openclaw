/** A caller-owned app-server client over the placement's authorized node duplex. */
import { EventEmitter, once } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
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
    const channel = await runtime.nodes.openDuplex({
      nodeId,
      command: resolveCodexWorkerAppServerCommand(process.env, true),
      params: {
        placement: { cwd: params.sandbox.containerWorkdir, ...workspace },
        authorization: "session-full",
        ...(params.workspaceReadiness ? { resourcePreparationRequired: true } : {}),
      },
      sessionKey: params.sandbox.sessionKey,
      timeoutMs: 0,
      maxMessageBytes: MAX_FRAME_BYTES,
      maxOutstandingDeliveryBytes: MAX_FRAME_BYTES + 2 * 1024 * 1024,
      signal,
      assertCurrent,
    });
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
      return client;
    } catch (error) {
      await client.closeAndWait();
      throw error;
    }
  };
}

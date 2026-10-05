import { randomUUID } from "node:crypto";
/** Gateway-side stdio facade over one authorized worker app-server duplex. */
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { prepareWorkerGitHubBindingGrant } from "openclaw/plugin-sdk/github-worker-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { resolveCodexWorkerAppServerCommand } from "../node-app-server-command.js";
import { CODEX_NODE_RESOURCE_READINESS_FEATURE } from "../node-resource-readiness.js";
import { CodexAppServerClient } from "./client.js";
import { readCodexPlacementWorkspaceIdentity } from "./sandbox-exec-server.js";
import { trackIsolatedCodexAppServerClient } from "./shared-client.js";
import type { CodexAppServerTransport } from "./transport.js";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
type DuplexCloseOrigin =
  | "remote_resolved"
  | "remote_rejected"
  | "local_stdin_final"
  | "local_response_too_large"
  | "local_kill"
  | "local_abort"
  | "local_resource_failure";

function duplexRejectionCode(error: unknown): string {
  const message = formatErrorMessage(error);
  if (message.includes("Codex node app-server diagnostic exceeded 4 KiB")) {
    return "node_stderr_limit";
  }
  if (message.includes("Node command completed without opening a ready duplex invocation.")) {
    return "duplex_not_ready";
  }
  return "unclassified";
}

export async function startWorkerCodexAppServerClient(params: {
  runtime: PluginRuntime;
  sandbox: SandboxContext;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<CodexAppServerClient> {
  const { sandbox, runtime, signal, assertCurrent } = params;
  if (
    !sandbox.enabled ||
    !("placementNodeId" in sandbox) ||
    typeof sandbox.placementNodeId !== "string"
  ) {
    throw new Error("Codex worker app-server requires an exact managed placement node");
  }
  const placement = readCodexPlacementWorkspaceIdentity(sandbox);
  const { agentId, ...workspace } = placement;
  let command: string | undefined;
  const startupId = randomUUID();
  const observe = (
    name: "github-binding" | "node-duplex" | "initialize",
    status: "entry" | "success" | "error",
    startedAt: number,
    fields: Record<string, unknown> = {},
  ) => {
    try {
      embeddedAgentLog.info("worker_codex_startup", {
        startupId,
        nodeId: sandbox.placementNodeId,
        environmentId: workspace.environmentId,
        sessionId: workspace.sessionId,
        ownerEpoch: workspace.ownerEpoch,
        command,
        name,
        status,
        startedAt,
        ...(status !== "entry" ? { durationMs: Math.max(0, Date.now() - startedAt) } : {}),
        ...fields,
      });
    } catch {
      // Observations remain synchronous and cannot change transport scheduling.
    }
  };
  assertCurrent();
  signal.throwIfAborted();
  let grant: Awaited<ReturnType<typeof prepareWorkerGitHubBindingGrant>> | undefined;
  if (agentId) {
    const startedAt = Date.now();
    observe("github-binding", "entry", startedAt);
    try {
      grant = await prepareWorkerGitHubBindingGrant({
        sessionId: workspace.sessionId,
        sessionKey: workspace.sessionKey,
        agentId,
        signal,
        assertCurrent: () => {
          signal.throwIfAborted();
          assertCurrent();
          return true;
        },
      });
      observe("github-binding", "success", startedAt);
    } catch (error) {
      observe("github-binding", "error", startedAt);
      throw error;
    }
  }
  let acquiredChannel: Awaited<ReturnType<PluginRuntime["nodes"]["openDuplex"]>> | undefined;
  const duplexStartedAt = Date.now();
  try {
    assertCurrent();
    grant?.assertCurrent?.();
    const selectedCommand = resolveCodexWorkerAppServerCommand(process.env, true);
    command = selectedCommand;
    observe("node-duplex", "entry", duplexStartedAt);
    acquiredChannel = await runtime.nodes.openDuplex({
      nodeId: sandbox.placementNodeId,
      command: selectedCommand,
      params: {
        placement: { cwd: sandbox.containerWorkdir, ...workspace },
        authorization: "session-full",
        ...(sandbox.repositoryPreparationRequired ? { repositoryPreparationRequired: true } : {}),
        ...(sandbox.resourceReadiness ? { resourcePreparationRequired: true } : {}),
        ...(grant ? { github: grant.binding } : {}),
      },
      sessionKey: sandbox.sessionKey,
      timeoutMs: 0,
      ...(sandbox.resourceReadiness
        ? { requiredCommandFeatures: [CODEX_NODE_RESOURCE_READINESS_FEATURE] }
        : {}),
      maxMessageBytes: MAX_FRAME_BYTES,
      maxOutstandingDeliveryBytes: MAX_FRAME_BYTES + 2 * 1024 * 1024,
      signal: grant?.signal ? AbortSignal.any([signal, grant.signal]) : signal,
      assertCurrent: () => {
        assertCurrent();
        grant?.assertCurrent?.();
      },
    });
    assertCurrent();
    grant?.assertCurrent?.();
    observe("node-duplex", "success", duplexStartedAt);
  } catch (error) {
    observe("node-duplex", "error", duplexStartedAt);
    try {
      acquiredChannel?.close();
    } finally {
      await grant?.revoke();
    }
    throw error;
  }
  const channel = acquiredChannel;
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let exitCode: number | null = null;
  const signalCode: string | null = null;
  let closed = false;
  const openedAtMs = Date.now();
  let pending = Buffer.alloc(0);
  const close = (origin: DuplexCloseOrigin, error?: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    const syntheticExitCode = error ? 1 : 0;
    const observation = {
      nodeId: sandbox.placementNodeId,
      environmentId: workspace.environmentId,
      sessionId: workspace.sessionId,
      origin,
      syntheticExitCode,
      openedAtMs,
      lifetimeMs: Date.now() - openedAtMs,
      ...(origin === "remote_rejected" ? { errorCode: duplexRejectionCode(error) } : {}),
    };
    if (origin === "remote_rejected") {
      embeddedAgentLog.warn("worker_codex_duplex_closed", observation);
    } else {
      embeddedAgentLog.info("worker_codex_duplex_closed", observation);
    }
    channel.close();
    stdout.end();
    stderr.end();
    exitCode = syntheticExitCode;
    events.emit("exit", exitCode, signalCode);
    void grant?.revoke();
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      if (closed) {
        callback(new Error("Codex worker app-server channel is closed"));
        return;
      }
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (pending.length > MAX_FRAME_BYTES + 1) {
        callback(new Error("Codex worker app-server request exceeds 64 MiB"));
        return;
      }
      const messages: Buffer[] = [];
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        const frame = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        messages.push(frame);
      }
      void (async () => {
        for (const message of messages) {
          await channel.send(message);
        }
      })().then(
        () => callback(),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
      );
    },
    final(callback) {
      close("local_stdin_final");
      callback();
    },
  });
  const unsubscribe = channel.onMessage(async (message) => {
    if (closed) {
      return;
    }
    if (message.byteLength > MAX_FRAME_BYTES) {
      close(
        "local_response_too_large",
        new Error("Codex worker app-server response exceeds 64 MiB"),
      );
      return;
    }
    if (!stdout.write(Buffer.concat([Buffer.from(message), Buffer.from("\n")]))) {
      await new Promise<void>((resolve) => {
        stdout.once("drain", resolve);
      });
    }
  });
  void channel.closed.then(
    () => close("remote_resolved"),
    (error: unknown) => close("remote_rejected", error),
  );
  const transport: CodexAppServerTransport = {
    stdin,
    stdout,
    stderr,
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    kill: () => {
      close("local_kill", new Error("Codex worker app-server stopped"));
      return true;
    },
    once: (event, listener) => events.once(event, listener),
    off: (event, listener) => events.off(event, listener),
  };
  const client = CodexAppServerClient.fromTransport(transport);
  trackIsolatedCodexAppServerClient(client);
  if (sandbox.resourceReadiness) {
    const readiness = sandbox.resourceReadiness;
    // This exact duplex owns the resource gate; turn/start does not join delivery.
    void (async () => {
      let status: "ready" | "failed" = "ready";
      try {
        await readiness.wait(signal);
        readiness.assertCurrent();
      } catch {
        status = "failed";
      }
      signal.throwIfAborted();
      assertCurrent();
      await client.request("openclaw/resources/settle", { status }, { signal });
      assertCurrent();
    })().catch(() => {
      if (!signal.aborted && !closed) {
        close("local_resource_failure", new Error("Worker private resource readiness failed"));
      }
    });
  }
  client.addTransportExitHandler(() => unsubscribe());
  if (signal.aborted) {
    close("local_abort", signal.reason);
  }
  const initializeStartedAt = Date.now();
  const observeInitialize = () => {
    try {
      embeddedAgentLog.info("worker_codex_initialize", {
        startupId,
        nodeId: sandbox.placementNodeId,
        environmentId: workspace.environmentId,
        sessionId: workspace.sessionId,
        ownerEpoch: workspace.ownerEpoch,
        command,
        ...client.getInitializeDiagnostic(),
      });
    } catch {
      // The initialize owner retains wire settlement and client closure.
    }
  };
  observe("initialize", "entry", initializeStartedAt);
  try {
    await client.initialize();
    assertCurrent();
    observe("initialize", "success", initializeStartedAt);
    observeInitialize();
    return client;
  } catch (error) {
    observe("initialize", "error", initializeStartedAt);
    observeInitialize();
    await client.closeAndWait();
    throw error;
  }
}

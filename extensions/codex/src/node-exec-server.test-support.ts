import { EventEmitter, once } from "node:events";
import type { OpenClawPluginNodeHostCommandIo } from "openclaw/plugin-sdk/node-host";
import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import { expect, vi } from "vitest";
type JsonRpcRecord = Record<string, unknown>;

export function createManagedWorkspaceInvocation(cwd: string, homeDir?: string) {
  const placement = {
    cwd,
    environmentId: "paired-environment",
    sessionId: "paired-session",
    ownerEpoch: 1,
    sessionKey: "agent:main:paired-session",
  };
  const release = vi.fn();
  const acquireManagedWorkspaceAsync = vi.fn(
    async (request: {
      workspaceDir: string;
      environmentId: string;
      sessionId: string;
      ownerEpoch: number;
      sessionKey: string;
    }) => {
      if (
        request.workspaceDir !== cwd ||
        request.environmentId !== placement.environmentId ||
        request.sessionId !== placement.sessionId ||
        request.ownerEpoch !== placement.ownerEpoch ||
        request.sessionKey !== placement.sessionKey
      ) {
        throw new Error("node placement does not own the requested workspace");
      }
      return { workspaceDir: cwd, ...(homeDir ? { homeDir } : {}), release };
    },
  );
  const context = {
    sessionKey: placement.sessionKey,
    sendNodeEvent: async () => undefined,
    acquireManagedWorkspaceAsync,
    prepareExecAuthorization: () => () => {},
  } satisfies NonNullable<Parameters<OpenClawPluginNodeHostCommand["handle"]>[2]>;
  return { placement, context, acquireManagedWorkspaceAsync, release };
}

export function createNodeFrames(testSignal?: AbortSignal) {
  const controller = new AbortController();
  const signal = testSignal ? AbortSignal.any([controller.signal, testSignal]) : controller.signal;
  const messages = new EventEmitter();
  let receive: ((message: Uint8Array) => void | Promise<void>) | undefined;
  let signalReady = () => {};
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const outbound: JsonRpcRecord[] = [];
  const io: OpenClawPluginNodeHostCommandIo = {
    signal,
    emitChunk: async () => undefined,
    onInput: () => undefined,
    frames: {
      send: async (message) => {
        outbound.push(JSON.parse(Buffer.from(message).toString("utf8")) as JsonRpcRecord);
        messages.emit("frame");
      },
      onMessage: (listener) => {
        receive = listener;
        signalReady();
        return () => {
          if (receive === listener) {
            receive = undefined;
          }
        };
      },
    },
  };
  return {
    controller,
    io,
    outbound,
    ready,
    waitForMessage: async (matches: (message: JsonRpcRecord) => boolean) => {
      // Retain frames before waking readers: responses may precede the waiter.
      // The test's cancellation owns the wait, not an arbitrary RPC poll deadline.
      for (;;) {
        signal.throwIfAborted();
        const message = outbound.find(matches);
        if (message) {
          return message;
        }
        await once(messages, "frame", { signal });
      }
    },
    send: async (message: unknown) => {
      if (!receive) {
        throw new Error("Codex node command did not register a ready duplex receiver.");
      }
      await receive(Buffer.from(JSON.stringify(message)));
    },
    sendRaw: async (message: Uint8Array) => {
      if (!receive) {
        throw new Error("Codex node command did not register a ready duplex receiver.");
      }
      return await receive(message);
    },
  };
}

export async function readNodeResponse(
  frames: ReturnType<typeof createNodeFrames>,
  id: number,
): Promise<JsonRpcRecord> {
  const response = await frames.waitForMessage(
    (message) => message.id === id && ("result" in message || "error" in message),
  );
  if (response.error) {
    throw new Error(`Codex exec-server request ${id} failed: ${JSON.stringify(response.error)}`);
  }
  return response.result as JsonRpcRecord;
}

export async function readNodeProcessNotifications(
  frames: ReturnType<typeof createNodeFrames>,
  processId: string,
  count: number,
): Promise<JsonRpcRecord[]> {
  const matching = () =>
    frames.outbound.filter(
      (message) =>
        String(message.method).startsWith("process/") &&
        (message.params as { processId?: string }).processId === processId,
    );
  // Codex records exit before asynchronously notifying; closed can arrive first.
  // Wait for both facts, then reject extra notifications with the exact count.
  await frames.waitForMessage(
    (message) =>
      message.method === "process/closed" &&
      (message.params as { processId?: string }).processId === processId &&
      matching().length >= count,
  );
  expect(matching()).toHaveLength(count);
  const notifications = matching().toSorted(
    (left, right) => (left.params as { seq: number }).seq - (right.params as { seq: number }).seq,
  );
  expect(notifications.map((message) => (message.params as { seq: number }).seq)).toEqual(
    Array.from({ length: count }, (_, index) => index + 1),
  );
  expect(notifications.at(-1)?.method).toBe("process/closed");
  return notifications;
}

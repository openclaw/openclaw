import { randomUUID } from "node:crypto";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";

type Channel = Awaited<ReturnType<PluginRuntime["nodes"]["openDuplex"]>>;

/** Carries one delivery receipt without exposing its control reply to native Codex. */
export function bindCodexNodeResourceDelivery(
  channel: Channel,
  readiness: NonNullable<SandboxContext["resourceReadiness"]>,
  signal: AbortSignal,
  assertCurrent: () => void,
): Channel {
  const id = `openclaw-resource-${randomUUID()}`;
  const acknowledgement = createDeferred<void>();
  void acknowledgement.promise.catch(() => {});
  let started = false;
  let closed = false;
  const check = () => {
    signal.throwIfAborted();
    assertCurrent();
    if (closed) {
      throw new Error("Private resource delivery connection closed.");
    }
  };
  const retire = () => {
    closed = true;
    acknowledgement.reject(new Error("Private resource delivery connection closed."));
  };
  void channel.closed.then(retire, retire);
  return {
    ...channel,
    async send(message) {
      check();
      await channel.send(message);
      check();
    },
    onMessage(listener) {
      const unsubscribe = channel.onMessage((message) => {
        if (closed) {
          return;
        }
        if (message[0] !== 0) {
          const response: unknown = JSON.parse(Buffer.from(message).toString("utf8"));
          if (isRecord(response) && response.id === id) {
            check();
            if (response.error || !isRecord(response.result)) {
              acknowledgement.reject(new Error("Private resource readiness was rejected."));
            } else {
              acknowledgement.resolve();
            }
            return;
          }
        }
        return listener(message);
      });
      if (!started) {
        started = true;
        void (async () => {
          let status: "ready" | "failed" = "ready";
          try {
            await readiness.wait(signal);
            readiness.assertCurrent();
          } catch {
            status = "failed";
          }
          check();
          await channel.send(
            Buffer.from(
              JSON.stringify({ id, method: "openclaw/resources/settle", params: { status } }),
            ),
          );
          await racePromiseWithAbortSignal(acknowledgement.promise, signal);
          check();
        })().catch(() => channel.close());
      }
      return () => {
        retire();
        unsubscribe();
      };
    },
    close() {
      retire();
      channel.close();
    },
  };
}

import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "openclaw/plugin-sdk/github-worker-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  parseCodexNodeGitHubControl,
  encodeCodexNodeGitHubControl,
} from "../node-github-refresh.js";

type NodeChannel = Awaited<ReturnType<PluginRuntime["nodes"]["openDuplex"]>>;
/** Adapts grant-owner deliveries to a single already-authorized node lease. */
export function bindCodexNodeGitHubRenewal(
  channel: NodeChannel,
  grant: WorkerGitHubBindingGrant,
): NodeChannel {
  let pending:
    | { generation: number; resolve: () => void; reject: (error: unknown) => void }
    | undefined;
  let closed = false;
  const install = async (snapshot: WorkerGitHubBindingRefresh) => {
    grant.assertCurrent?.();
    if (closed) {
      throw new Error("Node GitHub renewal lease closed");
    }
    const acknowledgement = createDeferred<void>();
    void acknowledgement.promise.catch(() => {});
    pending = {
      generation: snapshot.generation,
      resolve: acknowledgement.resolve,
      reject: acknowledgement.reject,
    };
    const timeout = setTimeout(
      () =>
        acknowledgement.reject(new Error("Node GitHub profile renewal acknowledgement expired")),
      10_000,
    );
    timeout.unref?.();
    try {
      await channel.send(
        encodeCodexNodeGitHubControl({ type: "openclaw.github.profile", ...snapshot }),
      );
      await acknowledgement.promise;
      grant.assertCurrent?.();
      if (closed) {
        throw new Error("Node GitHub renewal lease closed");
      }
    } finally {
      clearTimeout(timeout);
      pending = undefined;
    }
  };
  let unsubscribe: (() => void) | undefined;
  let stop: (() => void) | undefined;
  const retire = () => {
    if (closed) {
      return;
    }
    closed = true;
    stop?.();
    unsubscribe?.();
    pending?.reject(new Error("Node GitHub renewal lease closed"));
  };
  void channel.closed.then(retire, retire);
  return {
    ...channel,
    onMessage: (listener) => {
      if (closed) {
        throw new Error("Node GitHub renewal lease closed");
      }
      unsubscribe = channel.onMessage((message) => {
        const control = parseCodexNodeGitHubControl(message);
        if (control) {
          if (
            control.type === "openclaw.github.profile.ack" &&
            control.generation === pending?.generation
          ) {
            if (control.ok) {
              pending.resolve();
            } else {
              pending.reject(new Error("Node GitHub profile renewal was rejected"));
            }
          }
          return;
        }
        return listener(message);
      });
      stop ??= grant.startRenewal?.(install);
      return retire;
    },
    close: () => {
      retire();
      channel.close();
    },
  };
}

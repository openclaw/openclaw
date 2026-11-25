import { StringDecoder } from "node:string_decoder";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type NodeWorkspaceWorkerOptions = {
  nodeId: string;
  workspaceDir: string;
  remoteRoot: string;
  signal: AbortSignal;
  assertCurrent?: () => void;
  openDuplex: NonNullable<OpenClawPluginServiceContext["openNodeDuplex"]>;
};

export async function runNodeWorkspaceWorker(
  options: NodeWorkspaceWorkerOptions,
  command: "workspace.memory" | "workspace.skills",
  params: Record<string, unknown>,
  signal: AbortSignal,
  onLine?: (line: string, reply?: (value: unknown) => Promise<void>) => void | Promise<void>,
  beforeStart?: () => Promise<void>,
) {
  signal.throwIfAborted();
  options.assertCurrent?.();
  const channel = await options.openDuplex({
    nodeId: options.nodeId,
    command,
    params: { ...params, workspaceDir: options.remoteRoot },
    signal,
    assertCurrent: options.assertCurrent,
    // The existing node transport supplies liveness heartbeats for subscriptions.
    timeoutMs: onLine || params.operation === "installDependencies" ? 0 : 60_000,
  });
  void channel.closed.catch(() => {});
  const decoder = new StringDecoder("utf8");
  let text = "";
  let pending = Promise.resolve();
  let unsubscribe: (() => void) | undefined;
  try {
    options.assertCurrent?.();
    unsubscribe = channel.onMessage((message) => {
      signal.throwIfAborted();
      text += decoder.write(Buffer.from(message));
      if (onLine) {
        let newline: number;
        while ((newline = text.indexOf("\n")) >= 0) {
          const line = text.slice(0, newline);
          pending = pending.then(() =>
            onLine(line, async (value) => {
              signal.throwIfAborted();
              await channel.send(Buffer.from(`${JSON.stringify(value)}\n`));
            }),
          );
          void pending.catch(() => {
            channel.close();
          });
          text = text.slice(newline + 1);
        }
      }
    });
    // The admitted node owns cleanup before any source bytes are uploaded.
    await beforeStart?.();
    signal.throwIfAborted();
    options.assertCurrent?.();
    // Wait until the caller has installed its output listener before starting IO.
    await channel.send(Buffer.from("start"));
    const result = asOptionalRecord(await channel.closed);
    await pending;
    signal.throwIfAborted();
    const payload = asOptionalRecord(result?.payload);
    if (payload?.ok !== true) {
      throw new Error("Node workspace worker did not complete");
    }
    return text + decoder.end();
  } finally {
    unsubscribe?.();
    channel.close();
    // Revocation prevents new IO, but accepted node work still owns its cleanup.
    await channel.closed.catch(() => {});
  }
}

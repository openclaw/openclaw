import { StringDecoder } from "node:string_decoder";
import type { OpenClawPluginServiceContext } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type NodeWorkspaceWorkerOptions = {
  nodeId: string;
  workspaceDir: string;
  remoteRoot: string;
  signal: AbortSignal;
  openDuplex: NonNullable<OpenClawPluginServiceContext["openNodeDuplex"]>;
};

export async function runNodeWorkspaceWorker(
  options: NodeWorkspaceWorkerOptions,
  command: "workspace.memory" | "workspace.skills",
  params: Record<string, unknown>,
  signal: AbortSignal,
  onLine?: (line: string) => void,
) {
  signal.throwIfAborted();
  const channel = await options.openDuplex({
    nodeId: options.nodeId,
    command,
    params: { ...params, workspaceDir: options.remoteRoot },
    signal,
    // The existing node transport supplies liveness heartbeats for subscriptions.
    timeoutMs: onLine || params.operation === "installDependencies" ? 0 : 60_000,
  });
  void channel.closed.catch(() => {});
  const decoder = new StringDecoder("utf8");
  let text = "";
  const unsubscribe = channel.onMessage((message) => {
    signal.throwIfAborted();
    text += decoder.write(Buffer.from(message));
    if (onLine) {
      let newline: number;
      while ((newline = text.indexOf("\n")) >= 0) {
        onLine(text.slice(0, newline));
        text = text.slice(newline + 1);
      }
    }
  });
  try {
    // Wait until the caller has installed its output listener before starting IO.
    await channel.send(Buffer.from("start"));
    const result = asOptionalRecord(await channel.closed);
    signal.throwIfAborted();
    const payload = asOptionalRecord(result?.payload);
    if (payload?.ok !== true) {
      throw new Error("Node workspace worker did not complete");
    }
    return text + decoder.end();
  } finally {
    unsubscribe();
    channel.close();
  }
}

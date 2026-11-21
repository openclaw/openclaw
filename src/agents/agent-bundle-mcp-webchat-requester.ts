import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { AsyncContext } from "../shared/async-context.js";
import type { BundleMcpToolRuntime, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

/** Captured by the admitted human-turn owner; never accepted from harness arguments. */
export type WebchatMcpRequester = {
  sessionId: string;
  sessionKey: string;
  profileId: string;
  assertCurrent: () => void;
};

const requesterContext = new AsyncContext<WebchatMcpRequester>(
  Symbol.for("openclaw.webchatMcpRequester"),
);

/** Every attempt enters a frame, including senderless background attempts. */
export function withWebchatMcpRequester<T>(
  requester: WebchatMcpRequester | undefined,
  run: () => T,
): T {
  return requesterContext.run(requester, run);
}

export function readWebchatMcpRequester(params: {
  sessionId: string;
  sessionKey?: string;
  requesterSenderId?: string | null;
}): WebchatMcpRequester | undefined {
  if (params.requesterSenderId?.trim()) {
    return undefined;
  }
  const requester = requesterContext.getStore();
  if (requester?.sessionId !== params.sessionId || requester.sessionKey !== params.sessionKey) {
    return undefined;
  }
  requester.assertCurrent();
  return requester;
}

export function guardWebchatMcpTools(
  view: BundleMcpToolRuntime,
  runtime: SessionMcpRuntime,
  assertCurrent: (() => void) | undefined,
): void {
  if (!assertCurrent) {
    return;
  }
  let disposed = false;
  const dispose = view.dispose;
  view.dispose = async () => {
    disposed = true;
    await dispose();
  };
  for (const tool of view.tools) {
    const serverName = getPluginToolMeta(tool)?.mcp?.serverName;
    if (
      !serverName ||
      (!runtime.isRequesterScopedServer?.(serverName) &&
        !Object.hasOwn(runtime.requesterConnect?.catalog.servers ?? {}, serverName))
    ) {
      continue;
    }
    const execute = tool.execute;
    tool.execute = async (...args) => {
      if (disposed) {
        throw new Error("This MCP view has closed; ask again in a new turn.");
      }
      assertCurrent();
      return execute(...args);
    };
  }
}

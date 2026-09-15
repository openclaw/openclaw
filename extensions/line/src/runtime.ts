// Line plugin module implements runtime behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";

type LineChannelRuntime = {
  buildTemplateMessageFromPayload?: typeof import("./template-messages.js").buildTemplateMessageFromPayload;
  createQuickReplyItems?: typeof import("./send.js").createQuickReplyItems;
  monitorLineProvider?: typeof import("./monitor.js").monitorLineProvider;
  pushMessageLine?: typeof import("./send.js").pushMessageLine;
  pushMessagesLine?: typeof import("./send.js").pushMessagesLine;
  resolveLineAccount?: typeof import("./accounts.js").resolveLineAccount;
};

type LineRuntime = PluginRuntime & {
  channel: PluginRuntime["channel"] & {
    line?: LineChannelRuntime;
  };
};

const { setRuntime: setLineRuntime, getRuntime: getLineRuntime } =
  createPluginRuntimeStore<LineRuntime>({
    pluginId: "line",
    errorMessage: "LINE runtime not initialized - plugin not registered",
  });
export { getLineRuntime, setLineRuntime };

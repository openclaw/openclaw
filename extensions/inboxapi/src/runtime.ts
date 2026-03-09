import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk/inboxapi";

const { setRuntime: setInboxApiRuntime, getRuntime: getInboxApiRuntime } =
  createPluginRuntimeStore<PluginRuntime>(
    "InboxAPI runtime not initialized - plugin not registered",
  );
export { getInboxApiRuntime, setInboxApiRuntime };

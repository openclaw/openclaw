import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadMattermostThreadBindingsModule = createLazyRuntimeModule(
  () => import("./src/mattermost/thread-bindings.js"),
);

export function registerMattermostSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_ended", async (event) => {
    const { handleMattermostSubagentEnded } = await loadMattermostThreadBindingsModule();
    await handleMattermostSubagentEnded(event);
  });
}

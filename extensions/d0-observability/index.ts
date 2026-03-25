import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { createD0RunObservabilityService, createD0RunObservabilityState } from "./src/service.js";

const plugin = {
  id: "d0-observability",
  name: "D0 Observability",
  description: "Project D0 runtime lifecycle into backend Langfuse run traces.",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    const state = createD0RunObservabilityState();

    api.on("before_prompt_build", (event, ctx) => {
      if (ctx.sessionKey && typeof event.prompt === "string" && event.prompt.trim().length > 0) {
        state.recordPrompt(ctx.sessionKey, event.prompt, ctx.trigger);
      }
      return undefined;
    });

    api.registerService(
      createD0RunObservabilityService({
        runtime: api.runtime,
        state,
      }),
    );
  },
};

export default plugin;

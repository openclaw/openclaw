import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { AUTOMATION_SYSTEM_PROMPT } from "../system-prompt.js";

export function registerPromptBuildHook(api: OpenClawPluginApi) {
  api.on(
    "before_prompt_build",
    async (_event: any, _ctx: any) => {
      return { appendSystemContext: AUTOMATION_SYSTEM_PROMPT };
    },
    { timeoutMs: 5_000 },
  );
}

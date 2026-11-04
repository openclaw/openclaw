import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginApi,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildSkillWorkshopPromptSection, SKILL_WORKSHOP_TOOL_NAME } from "./prompt.js";
import { readWorkshopRuntimeConfig } from "./runtime.js";
import { resolveSkillWorkshopToolConstructionBlock } from "./tool-availability.js";
import { createSkillWorkshopTool } from "./tool.js";

const WORKSHOP_PLUGIN_ID = "skill-workshop";

/**
 * Builds the Workshop tool for one run, or none. Sandboxed runs get none: Workshop writes the
 * host-side skills root. The run owner withholds the tool in personal-default library turns.
 */
function createConfiguredSkillWorkshopTool(ctx: OpenClawPluginToolContext<2>) {
  if (resolveSkillWorkshopToolConstructionBlock({ sandboxed: ctx.sandboxed })) {
    return null;
  }
  // Only this plugin's own background fork is a review; core forks carry no plugin owner.
  const reviewOf =
    ctx.backgroundRun?.ownerPluginId === WORKSHOP_PLUGIN_ID
      ? ctx.backgroundRun.sourceSessionKey
      : undefined;
  const config: OpenClawConfig =
    ctx.config ?? ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? readWorkshopRuntimeConfig();
  const sessionKey = ctx.sessionKey?.trim();
  const runId = ctx.runId?.trim();
  return createSkillWorkshopTool({
    config,
    agentId: ctx.agentId ?? "main",
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
    ...(reviewOf ? { reviewOf } : {}),
    assertInvocationCurrent: ctx.assertInvocationCurrent,
  });
}

/** Registers `skill_workshop` with the Workshop system-prompt section as its guidance. */
export function registerSkillWorkshopTool(api: OpenClawPluginApi): void {
  api.registerTool(
    { contextVersion: 2, create: (ctx) => createConfiguredSkillWorkshopTool(ctx) },
    {
      name: SKILL_WORKSHOP_TOOL_NAME,
      promptGuidance: buildSkillWorkshopPromptSection().join("\n").trim(),
    },
  );
}

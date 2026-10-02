import {
  splitSystemPromptCacheBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from "@openclaw/ai/internal/shared";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderTransformSystemPromptContext } from "../../../plugins/types.js";
import { buildEmbeddedSystemPrompt } from "../system-prompt.js";

type EmbeddedSystemPromptParams = Parameters<typeof buildEmbeddedSystemPrompt>[0];
type ProviderSystemPromptTransform = (params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir: string;
  context: ProviderTransformSystemPromptContext;
}) => string;

type BuildAttemptSystemPromptParams = {
  isRawModelRun: boolean;
  embeddedSystemPrompt: EmbeddedSystemPromptParams;
  transformProviderSystemPrompt: ProviderSystemPromptTransform;
  providerTransform: {
    provider: string;
    config?: OpenClawConfig;
    workspaceDir: string;
    context: Omit<ProviderTransformSystemPromptContext, "systemPrompt">;
  };
};

const ATTEMPT_PROMPT_SECTION =
  /<!-- openclaw:attempt:(STABLE|DYNAMIC|PERMISSION) -->[\s\S]*?<!-- \/openclaw:attempt:\1 -->/g;

function renderAttemptPromptSection(section: "STABLE" | "DYNAMIC" | "PERMISSION", text: string) {
  return `<!-- openclaw:attempt:${section} -->\n${text}\n<!-- /openclaw:attempt:${section} -->`;
}

/**
 * Builds the embedded system prompt and applies provider-specific transforms
 * unless this is a raw model run. Raw runs still keep `baseSystemPrompt` for
 * diagnostics/cache boundaries, but submit an empty provider prompt.
 */
export function buildAttemptSystemPrompt(params: BuildAttemptSystemPromptParams) {
  let renderedSkillsPrompt = "";
  const baseSystemPrompt = buildEmbeddedSystemPrompt({
    ...params.embeddedSystemPrompt,
    onRenderedSkillsPrompt: (skillsPrompt) => {
      renderedSkillsPrompt = skillsPrompt;
      params.embeddedSystemPrompt.onRenderedSkillsPrompt?.(skillsPrompt);
    },
  });
  const transformedSystemPrompt = params.isRawModelRun
    ? ""
    : params.transformProviderSystemPrompt({
        provider: params.providerTransform.provider,
        config: params.providerTransform.config,
        workspaceDir: params.providerTransform.workspaceDir,
        context: {
          ...params.providerTransform.context,
          systemPrompt: baseSystemPrompt,
        },
      });
  // Runtime additions at the cache boundary stay outside both owned regions;
  // permission refreshes replace capability guidance without dropping that context.
  const splitPrompt = splitSystemPromptCacheBoundary(transformedSystemPrompt);
  const stablePrompt = renderAttemptPromptSection(
    "STABLE",
    splitPrompt?.stablePrefix ?? transformedSystemPrompt,
  );
  const dynamicPrompt = splitPrompt
    ? renderAttemptPromptSection("DYNAMIC", splitPrompt.dynamicSuffix)
    : "";
  const systemPrompt = params.isRawModelRun
    ? ""
    : splitPrompt
      ? `${stablePrompt}${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamicPrompt}` // nosemgrep: security.opengrep.ghsa-2qj5-gwg2-xwc4.openclaw.prompt-unsanitized-literal-interpolation -- These are complete prompts from trusted builders/transforms; path literals are sanitized at their producers, not by flattening prompt newlines here.
      : stablePrompt;

  return {
    baseSystemPrompt,
    systemPrompt,
    skillsPrompt: params.isRawModelRun ? "" : renderedSkillsPrompt,
    refreshSystemPrompt: (currentSystemPrompt: string, permissionNotice?: string) => {
      if (params.isRawModelRun) {
        return currentSystemPrompt;
      }
      const nextNotice = permissionNotice
        ? renderAttemptPromptSection("PERMISSION", permissionNotice)
        : undefined;
      let replacedNotice = false;
      // Hooks can return any older generation. Replace owned segments by identity,
      // not their prior text; external additions and whole-prompt overrides survive.
      const refreshed = currentSystemPrompt.replace(
        ATTEMPT_PROMPT_SECTION,
        (_match, section: string) => {
          if (section === "PERMISSION") {
            replacedNotice = true;
            return nextNotice ?? _match;
          }
          return section === "STABLE" ? stablePrompt : dynamicPrompt;
        },
      );
      return replacedNotice || !nextNotice ? refreshed : `${refreshed}\n\n${nextNotice}`;
    },
  };
}

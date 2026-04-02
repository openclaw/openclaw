import * as path from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("skill-model-router");
import type { AnyAgentTool } from "../pi-tools.types.js";
import type { SkillEntry } from "./types.js";

// ---------------------------------------------------------------------------
// Active skill model context — one instance per run attempt, shared by the
// read-tool interceptor and the StreamFn ModelRouter wrapper.
// ---------------------------------------------------------------------------

export type ActiveSkillModelContext = {
  activeModel: Model<Api> | undefined;
};

export function createActiveSkillModelContext(): ActiveSkillModelContext {
  return { activeModel: undefined };
}

// ---------------------------------------------------------------------------
// Profile-based model resolution
// ---------------------------------------------------------------------------

const PROFILE_HINTS: Record<string, string[]> = {
  fast: ["haiku", "flash", "mini", "small", "nano"],
  powerful: ["opus", "pro", "large", "max"],
  large: ["opus", "pro", "large", "max"],
  balanced: ["sonnet", "medium"],
};

/**
 * Resolve a capability-tier profile name (e.g. "fast", "powerful") to the
 * best available model in the registry.  Returns `undefined` when no model
 * matches or the profile is unknown.
 */
export function resolveModelByProfile(
  profile: string,
  modelRegistry: ModelRegistry,
): Model<Api> | undefined {
  const key = profile.trim().toLowerCase();
  if (!key) {
    return undefined;
  }

  const available = (modelRegistry as unknown as { getAvailable(): Model<Api>[] }).getAvailable();

  // Special case: "vision" — prefer models that accept image input
  if (key === "vision") {
    return available.find((m) => m.input?.includes("image")) as Model<Api> | undefined;
  }

  const hints = PROFILE_HINTS[key];
  if (!hints) {
    log.debug(`[model-router] unknown model profile "${profile}", skipping override`);
    return undefined;
  }

  for (const hint of hints) {
    const match = available.find(
      (m) => m.id.toLowerCase().includes(hint) || (m.name ?? "").toLowerCase().includes(hint),
    ) as Model<Api> | undefined;
    if (match) {
      return match;
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Build the skill → model map once at the start of a run attempt.
// ---------------------------------------------------------------------------

/**
 * Returns a map from absolute SKILL.md file path → Model to use when that
 * skill is active.  Only skills with a `model` or `modelProfile` metadata
 * field that resolves against the user's registry are included.
 */
export function buildSkillModelMap(
  skillEntries: SkillEntry[],
  modelRegistry: ModelRegistry,
): Map<string, Model<Api>> {
  const map = new Map<string, Model<Api>>();

  log.debug(`[model-router] buildSkillModelMap: ${skillEntries.length} entries`);

  for (const entry of skillEntries) {
    const filePath: string | undefined = (entry.skill as unknown as { filePath?: string }).filePath;
    if (!filePath) {
      log.debug(`[model-router] skill "${entry.skill.name}" has no filePath, skipping`);
      continue;
    }

    const { model: modelField, modelProfile } = entry.metadata ?? {};
    log.debug(
      `[model-router] skill "${entry.skill.name}" filePath=${filePath} model=${modelField ?? "none"} modelProfile=${modelProfile ?? "none"}`,
    );

    if (modelField) {
      const slashIdx = modelField.indexOf("/");
      if (slashIdx <= 0) {
        log.debug(
          `[model-router] skill "${entry.skill.name}" has invalid model "${modelField}" (expected "provider/modelId"), skipping`,
        );
        continue;
      }
      const provider = modelField.slice(0, slashIdx);
      const modelId = modelField.slice(slashIdx + 1);
      const resolved = (
        modelRegistry as unknown as { find(p: string, m: string): Model<Api> | null | undefined }
      ).find(provider, modelId);
      if (resolved) {
        map.set(path.resolve(filePath), resolved);
      } else {
        log.debug(
          `[model-router] skill "${entry.skill.name}" requests model "${modelField}" which is not available in the registry, skipping override`,
        );
      }
    } else if (modelProfile) {
      const resolved = resolveModelByProfile(modelProfile, modelRegistry);
      if (resolved) {
        map.set(path.resolve(filePath), resolved);
      } else {
        log.debug(
          `[model-router] skill "${entry.skill.name}" profile "${modelProfile}" matched no available model, skipping override`,
        );
      }
    }
  }

  return map;
}

// ---------------------------------------------------------------------------
// Read-tool interceptor — sets activeModel synchronously before pi-agent-core
// processes the tool result and issues the next LLM call.
// ---------------------------------------------------------------------------

/**
 * Wraps the `read` tool so that reading a SKILL.md whose path is in
 * `skillModelMap` updates `ctx.activeModel` before the result is returned.
 * If `skillModelMap` is empty the original tool is returned unchanged.
 */
export function wrapReadToolWithSkillModelDetect(
  tool: AnyAgentTool,
  skillModelMap: Map<string, Model<Api>>,
  ctx: ActiveSkillModelContext,
): AnyAgentTool {
  if (skillModelMap.size === 0) {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId: unknown, argsObj: unknown, ...rest: unknown[]) => {
      // pi-coding-agent execute signature: (toolCallId, args, signal)
      // argsObj is { path, offset?, limit? } for the read tool.
      // Note: LLMs sometimes use field aliases ("file", "filename") instead of "path".
      const argsRecord =
        argsObj != null && typeof argsObj === "object" ? (argsObj as Record<string, unknown>) : {};
      const rawFilePath =
        typeof argsRecord.path === "string"
          ? argsRecord.path
          : typeof argsRecord.file === "string"
            ? argsRecord.file
            : typeof argsRecord.filename === "string"
              ? argsRecord.filename
              : "";
      const filePath = rawFilePath.trim();
      log.debug(
        `[model-router] read tool wrapper: toolCallId=${String(toolCallId)} argsKeys=${Object.keys(argsRecord).join(",")} filePath=${filePath}`,
      );
      if (filePath) {
        const normalized = path.resolve(filePath);
        const override = skillModelMap.get(normalized);
        if (override) {
          ctx.activeModel = override;
          log.debug(
            `[model-router] skill model override set to ${override.provider}/${override.id} (from ${normalized})`,
          );
        } else if (path.basename(normalized) === "SKILL.md") {
          // Reading a SKILL.md that has no model override — reset to session default
          ctx.activeModel = undefined;
          log.debug(`[model-router] skill model override cleared (no override for ${normalized})`);
        }
        // Other file reads leave activeModel unchanged
      }
      // oxlint-disable-next-line typescript/no-explicit-any
      return (tool.execute as (...a: any[]) => unknown)(toolCallId, argsObj, ...rest);
    },
  } as AnyAgentTool;
}

// ---------------------------------------------------------------------------
// StreamFn ModelRouter wrapper — substitutes the model on every LLM call.
// ---------------------------------------------------------------------------

/**
 * Wraps `baseFn` so that when `ctx.activeModel` is set every LLM call uses
 * the override model instead of the session default.  Zero overhead when
 * `ctx.activeModel` is undefined.
 */
export function wrapStreamFnSkillModelRouter(
  baseFn: StreamFn,
  ctx: ActiveSkillModelContext,
): StreamFn {
  return (model, context, options) => baseFn(ctx.activeModel ?? model, context, options);
}

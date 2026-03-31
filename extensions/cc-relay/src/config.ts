/**
 * How the agent interacts with Claude Code CLI.
 *
 * - `relay`:     Agent forwards ALL user requests to CC without answering itself.
 *                The SOUL personality and memory are preserved; only a behavioral
 *                directive is appended via the `before_prompt_build` hook.
 * - `hybrid`:    Agent decides when to use CC vs answer directly. A softer hint
 *                is appended suggesting CC for complex tasks.
 * - `tool-only`: The `cc_dispatch` tool is registered but no prompt modification
 *                is made. The agent uses CC only if its SOUL or the user asks.
 */
export type CcRelayMode = "relay" | "hybrid" | "tool-only";

/**
 * Resolved plugin configuration with defaults applied.
 */
export interface CcRelayConfig {
  mode: CcRelayMode;
  claudeBin: string;
  workdir: string;
  runAsUser: string;
  permissionMode: string;
  model: string;
  timeoutSeconds: number;
  progressIntervalSeconds: number;
  maxResultChars: number;
  maxAttachments: number;
  maxAttachmentBytes: number;
}

export function resolveConfig(raw: unknown): CcRelayConfig {
  const cfg = (raw ?? {}) as Record<string, unknown>;

  // Validate runAsUser contains only safe characters (alphanumeric, underscore, hyphen)
  let runAsUser = typeof cfg.runAsUser === "string" ? cfg.runAsUser : "";
  if (runAsUser && !/^[a-zA-Z0-9_-]+$/.test(runAsUser)) {
    throw new Error(`cc-relay: invalid runAsUser "${runAsUser}" — only alphanumeric, _, - allowed`);
  }

  const rawMode = typeof cfg.mode === "string" ? cfg.mode : "hybrid";
  const mode: CcRelayMode =
    rawMode === "relay" || rawMode === "hybrid" || rawMode === "tool-only" ? rawMode : "hybrid";

  return {
    mode,
    claudeBin: typeof cfg.claudeBin === "string" ? cfg.claudeBin : "claude",
    workdir: typeof cfg.workdir === "string" ? cfg.workdir : "",
    runAsUser,
    permissionMode: typeof cfg.permissionMode === "string" ? cfg.permissionMode : "default",
    model: typeof cfg.model === "string" ? cfg.model : "",
    timeoutSeconds: typeof cfg.timeoutSeconds === "number" ? cfg.timeoutSeconds : 7200,
    progressIntervalSeconds:
      typeof cfg.progressIntervalSeconds === "number" ? cfg.progressIntervalSeconds : 60,
    maxResultChars: typeof cfg.maxResultChars === "number" ? cfg.maxResultChars : 4000,
    maxAttachments: typeof cfg.maxAttachments === "number" ? cfg.maxAttachments : 10,
    maxAttachmentBytes:
      typeof cfg.maxAttachmentBytes === "number" ? cfg.maxAttachmentBytes : 10 * 1024 * 1024,
  };
}

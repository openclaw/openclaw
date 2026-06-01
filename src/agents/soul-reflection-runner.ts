import crypto from "node:crypto";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { readLastSoulRule } from "./soul-auto-update.js";
import { buildReflectionPrompt, shouldFireReflection } from "./soul-reflection.js";

type AgentCommandFromIngress = typeof import("../commands/agent.js").agentCommandFromIngress;

const defaultDeps = {
  agentCommandFromIngress: (async (...args) => {
    const mod = await import("../commands/agent.js");
    return mod.agentCommandFromIngress(...args);
  }) as AgentCommandFromIngress,
};

let deps: { agentCommandFromIngress: AgentCommandFromIngress } = defaultDeps;

export type SoulReflectionOutcome =
  | { readonly status: "skipped"; readonly reason: "disabled" | "no-session" | "no-trigger" }
  | { readonly status: "fired"; readonly appendedRule: string | null }
  | { readonly status: "error"; readonly detail: string };

export type MaybeFireSoulReflectionInput = {
  readonly cfg: OpenClawConfig;
  readonly sessionKey: string | undefined;
  readonly workspaceDir: string | undefined;
  readonly userMessage: string;
  readonly turnsSinceLast: number;
  readonly channel?: string;
  readonly skipSoulReflection?: boolean;
};

/**
 * Pre-turn hook called from agentCommandInternal. When the config opts in and the
 * current user message trips a reflection trigger, spawns a sub-turn that prompts
 * the agent to call `soul_update` (or noop). The sub-turn is internal —
 * `deliver: false`, `sessionEffects: "internal"`, `suppressPromptPersistence: true`,
 * and `skipSoulReflection: true` to prevent recursion.
 *
 * Reads SOUL.md before and after the sub-turn so the caller can emit a forced
 * notice ("Added to SOUL.md: '...'") when a rule actually landed.
 *
 * Errors are swallowed so a misbehaving reflection cannot block the user's main turn.
 */
export async function maybeFireSoulReflection(
  input: MaybeFireSoulReflectionInput,
): Promise<SoulReflectionOutcome> {
  if (input.skipSoulReflection === true) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!input.sessionKey) {
    return { status: "skipped", reason: "no-session" };
  }
  const soulConfig = input.cfg.agents?.defaults?.soul;
  if (soulConfig?.autoUpdate !== true) {
    return { status: "skipped", reason: "disabled" };
  }
  const trigger = shouldFireReflection({
    userMessage: input.userMessage,
    turnsSinceLast: input.turnsSinceLast,
    config: soulConfig,
  });
  if (!trigger) {
    return { status: "skipped", reason: "no-trigger" };
  }
  const beforeRule = input.workspaceDir ? await readLastSoulRule(input.workspaceDir) : null;
  const prompt = buildReflectionPrompt({ trigger, recentUserMessage: input.userMessage });
  try {
    await deps.agentCommandFromIngress({
      message: prompt,
      sessionKey: input.sessionKey,
      deliver: false,
      channel: input.channel ?? INTERNAL_MESSAGE_CHANNEL,
      runId: crypto.randomUUID(),
      extraSystemPrompt: "",
      sessionEffects: "internal",
      suppressPromptPersistence: true,
      skipSoulReflection: true,
      allowModelOverride: false,
      inputProvenance: {
        kind: "inter_session",
        sourceTool: "soul_reflection",
      },
    });
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const afterRule = input.workspaceDir ? await readLastSoulRule(input.workspaceDir) : null;
  const appendedRule = afterRule !== null && afterRule !== beforeRule ? afterRule : null;
  return { status: "fired", appendedRule };
}

export function formatSoulReflectionNotice(rule: string): string {
  return `Added to SOUL.md: '${rule}'`;
}

export const testing = {
  setDepsForTest(overrides?: Partial<{ agentCommandFromIngress: AgentCommandFromIngress }>) {
    deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
  },
};

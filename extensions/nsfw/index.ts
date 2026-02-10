/**
 * OpenClaw NSFW Plugin — Not Satisfy For Weekend
 *
 * Toggle with `/nsfw true` or `/nsfw false`.
 * State is in-memory only — defaults to OFF and resets on restart.
 *
 * When active:
 *   • Part 1 — replaces the Identity line in the system prompt
 *   • Part 2 — injected after conversation history (prependContext)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================================
// Random key generation (16-char alphanumeric, regenerated per startup)
// ============================================================================

const CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

function generateKey(): string {
  const bytes = randomBytes(16);
  let key = "";
  for (let i = 0; i < 16; i++) {
    key += CHARSET[bytes[i] % CHARSET.length];
  }
  return key;
}

function generateKey_7(): string {
  const bytes = randomBytes(7);
  let key = "";
  for (let i = 0; i < 7; i++) {
    key += CHARSET[bytes[i] % CHARSET.length];
  }
  return key;
}

const randomKeys: Record<string, string> = {
  random_key_1: generateKey(),
  random_key_2: generateKey(),
  random_key_3: generateKey(),
  random_key_4: generateKey(),
  random_key_5: generateKey_7(),
};

// ============================================================================
// Load prompt fragments from prompts.json and replace {{random_key_N}}
// Auto-create a default prompts.json if it doesn't exist.
// ============================================================================

const __dir = dirname(fileURLToPath(import.meta.url));
const PROMPTS_PATH = join(__dir, "prompts.json");

const DEFAULT_PROMPTS = {
  part1: ["You are a helpful assistant. (Replace this with your own Part 1 prompt.)"],
  part2: ["(Replace this with your own Part 2 prompt.)"],
};

if (!existsSync(PROMPTS_PATH)) {
  writeFileSync(PROMPTS_PATH, JSON.stringify(DEFAULT_PROMPTS, null, 2) + "\n", "utf-8");
}

const rawPrompts: { part1: string[]; part2: string[] } = JSON.parse(
  readFileSync(PROMPTS_PATH, "utf-8"),
);

function interpolateKeys(text: string): string {
  return text.replace(/\{\{(random_key_[1-5])\}\}/g, (_match, key: string) => randomKeys[key]);
}

const NSFW_SYSTEM_PROMPT_PART1 = interpolateKeys(rawPrompts.part1.join("\n"));
const NSFW_SYSTEM_PROMPT_PART2 = interpolateKeys(rawPrompts.part2.join("\n"));

// The default identity line to replace
const IDENTITY_LINE = "You are a personal assistant running inside OpenClaw.";

// ============================================================================
// In-memory state (resets on restart)
// Per-agent toggle: Set of agentIds that have NSFW enabled.
// ============================================================================

const nsfwEnabledAgents = new Set<string>();

// ============================================================================
// Plugin Definition
// ============================================================================

const nsfwPlugin = {
  id: "nsfw",
  name: "NSFW – Not Satisfy For Weekend",
  description: "Toggle-able system prompt injection via /nsfw command",

  register(api: OpenClawPluginApi) {
    api.logger.info("nsfw: plugin registered (default: off, use /nsfw true to enable)");

    // /nsfw command — toggle in-memory state
    api.registerCommand({
      name: "nsfw",
      description: "Toggle NSFW mode per agent. Usage: /nsfw on | /nsfw off",
      acceptsArgs: true,
      requireAuth: true,
      handler(ctx) {
        const arg = (ctx.args ?? "").trim().toLowerCase();
        const agent = (ctx as { agentId?: string }).agentId ?? "main";

        if (arg === "on" || arg === "true" || arg === "1") {
          nsfwEnabledAgents.add(agent);
          return { text: `NSFW mode ON for agent "${agent}". Will reset on restart.` };
        }

        if (arg === "off" || arg === "false" || arg === "0") {
          nsfwEnabledAgents.delete(agent);
          return { text: `NSFW mode OFF for agent "${agent}".` };
        }

        // No arg or unrecognized → show status
        const isOn = nsfwEnabledAgents.has(agent);
        const list =
          nsfwEnabledAgents.size > 0 ? ` [active: ${[...nsfwEnabledAgents].join(", ")}]` : "";
        return {
          text: `NSFW mode is currently ${isOn ? "ON" : "OFF"} for agent "${agent}".${list} Usage: /nsfw on | /nsfw off`,
        };
      },
    });

    // Inject prompt fragments when enabled for this agent
    api.on("before_agent_start", async (event, ctx) => {
      const agent = ctx?.agentId ?? "main";
      if (!nsfwEnabledAgents.has(agent)) {
        return;
      }

      // Part 1: replace the Identity line in the system prompt
      let modifiedSystemPrompt: string | undefined;
      const currentSystemPrompt = (event as { systemPrompt?: string }).systemPrompt;
      if (currentSystemPrompt) {
        modifiedSystemPrompt = currentSystemPrompt.replace(IDENTITY_LINE, NSFW_SYSTEM_PROMPT_PART1);
      }

      return {
        // Part 1 → replaces Identity in system prompt
        ...(modifiedSystemPrompt ? { systemPrompt: modifiedSystemPrompt } : {}),
        // Part 2 → injected between conversation history and user message
        prependContext: NSFW_SYSTEM_PROMPT_PART2,
      };
    });
  },
};

export default nsfwPlugin;

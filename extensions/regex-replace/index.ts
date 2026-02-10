/**
 * OpenClaw Regex Replace Plugin
 *
 * Applies regex-based find-and-replace rules to outgoing agent messages.
 * Rules are defined in regex.json next to this file.
 *
 * Each rule has:
 *   pattern     — regex pattern string (no surrounding slashes)
 *   flags       — regex flags, e.g. "gm", "gi" (default: "g")
 *   replacement — the replacement string (default: "")
 *
 * The plugin hot-reloads regex.json on every message so you can edit
 * rules without restarting the gateway.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = join(__dir, "regex.json");

type Rule = {
  pattern: string;
  flags?: string;
  replacement?: string;
};

/** Load rules from disk (hot-reload on each call). */
function loadRules(logger: { warn: (msg: string) => void }): Rule[] {
  try {
    const raw = readFileSync(RULES_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn("regex-replace: regex.json must be a JSON array; skipping");
      return [];
    }
    return parsed;
  } catch (err) {
    logger.warn(`regex-replace: failed to load regex.json — ${err}`);
    return [];
  }
}

/** Apply all rules to the input string. */
function applyRules(input: string, rules: Rule[], logger: { warn: (msg: string) => void }): string {
  let result = input;
  for (const rule of rules) {
    if (!rule.pattern) continue;
    try {
      const re = new RegExp(rule.pattern, rule.flags ?? "g");
      result = result.replace(re, rule.replacement ?? "");
    } catch (err) {
      logger.warn(`regex-replace: invalid pattern "${rule.pattern}" — ${err}`);
    }
  }
  return result;
}

const regexReplacePlugin = {
  id: "regex-replace",
  name: "Regex Replace",
  description:
    "Apply regex find-and-replace rules to outgoing messages (edit regex.json to configure)",

  register(api: OpenClawPluginApi) {
    api.logger.info("regex-replace: plugin registered (rules in regex.json)");

    // Hook into message_sending to transform content before delivery
    api.on("message_sending", async (event) => {
      if (!event.content) return;

      const rules = loadRules(api.logger);
      if (rules.length === 0) {
        api.logger.info("regex-replace: no rules loaded, skipping");
        return;
      }

      const transformed = applyRules(event.content, rules, api.logger);

      if (transformed !== event.content) {
        api.logger.info(
          `regex-replace: replaced (${event.content.length} → ${transformed.length} chars, ${rules.length} rules)`,
        );
        return { content: transformed };
      }

      api.logger.info(`regex-replace: no match (${rules.length} rules checked)`);
    });
  },
};

export default regexReplacePlugin;

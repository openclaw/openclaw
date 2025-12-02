import path from "node:path";

import {
  CLAUDE_BIN,
  CLAUDE_IDENTITY_PREFIX,
  type ClaudeJsonParseResult,
  parseClaudeJson,
  summarizeClaudeMetadata,
} from "../auto-reply/claude.js";
import type { AgentMeta, AgentSpec } from "./types.js";

function toMeta(parsed?: ClaudeJsonParseResult): AgentMeta | undefined {
  if (!parsed?.parsed) return undefined;
  const summary = summarizeClaudeMetadata(parsed.parsed);
  return summary ? { extra: { summary } } : undefined;
}

export const claudeSpec: AgentSpec = {
  kind: "claude",
  isInvocation: (argv) =>
    argv.length > 0 && path.basename(argv[0]) === CLAUDE_BIN,
  buildArgs: (ctx) => {
    // Split around the body so we can inject flags without losing the body
    // position. This keeps templated prompts intact even when we add flags.
    const argv = [...ctx.argv];
    const body = argv[ctx.bodyIndex] ?? "";
    const beforeBody = argv.slice(0, ctx.bodyIndex);
    const afterBody = argv.slice(ctx.bodyIndex + 1);

    const wantsOutputFormat = typeof ctx.format === "string";
    if (wantsOutputFormat) {
      const hasOutputFormat = argv.some(
        (part) =>
          part === "--output-format" || part.startsWith("--output-format="),
      );
      if (!hasOutputFormat) {
        const outputFormat = ctx.format ?? "json";
        beforeBody.push("--output-format", outputFormat);
      }
    }

    const hasPrintFlag = argv.some(
      (part) => part === "-p" || part === "--print",
    );
    if (!hasPrintFlag) {
      beforeBody.push("-p");
    }

    const shouldPrependIdentity = !(ctx.sendSystemOnce && ctx.systemSent);
    const bodyWithIdentity =
      shouldPrependIdentity && body
        ? [ctx.identityPrefix ?? CLAUDE_IDENTITY_PREFIX, body]
            .filter(Boolean)
            .join("\n\n")
        : body;

    return [...beforeBody, bodyWithIdentity, ...afterBody];
  },
  parseOutput: (rawStdout) => {
    const parsed = parseClaudeJson(rawStdout);
    const text = parsed?.text ?? rawStdout.trim();
    return {
      text: text?.trim(),
      meta: toMeta(parsed),
    };
  },
};

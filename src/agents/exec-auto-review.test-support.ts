import type { ExecAutoReviewInput } from "../infra/exec-auto-review.js";

export const input: ExecAutoReviewInput = {
  command: "git status",
  argv: ["git", "status"],
  resolvedPath: "/usr/bin/git",
  cwd: "/repo",
  envKeys: [],
  host: "gateway",
  reason: "approval-required",
  analysis: { parsed: true, allowlistMatched: false, inlineEval: false },
};

export function preparedModel(modelId = "reviewer", maxTokens?: number) {
  return {
    selection: { provider: "openrouter", modelId, agentDir: "/agent" },
    model: { provider: "openrouter", id: modelId, api: "openai" as const, maxTokens },
    auth: { apiKey: "redacted", mode: "env" as const },
    [Symbol.asyncDispose]: async () => {},
  };
}

export function response(decision = "allow", risk = "low", rationale = "reviewer fixture") {
  return {
    stopReason: "stop" as const,
    content: [{ type: "text" as const, text: JSON.stringify({ decision, risk, rationale }) }],
  };
}

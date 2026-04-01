import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";

const OSTK_MODEL_ALIASES: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-5",
  haiku: "claude-haiku-3-5",
  "sonnet-4.5": "claude-sonnet-4-5",
  "opus-4.6": "claude-opus-4-6",
};

export function buildOstkCliBackend(): CliBackendPlugin {
  return {
    id: "ostk",
    config: {
      command: "ostk",
      args: [
        "agent",
        "run",
        "--output-format",
        "stream-json",
        "--pin",
        "default",
      ],
      resumeArgs: [
        "agent",
        "resume",
        "--output-format",
        "stream-json",
        "--session",
        "{sessionId}",
      ],
      output: "jsonl",
      input: "stdin",
      modelArg: "--model",
      modelAliases: OSTK_MODEL_ALIASES,
      sessionArg: "--session",
      sessionMode: "always",
      sessionIdFields: ["session_id", "sessionId"],
      systemPromptArg: "--append-system-prompt",
      systemPromptMode: "append",
      systemPromptWhen: "first",
      serialize: true,
      reliability: {
        watchdog: {
          fresh: {
            noOutputTimeoutMs: 120_000,
            minMs: 30_000,
            maxMs: 300_000,
          },
          resume: {
            noOutputTimeoutMs: 60_000,
            minMs: 15_000,
            maxMs: 180_000,
          },
        },
      },
    },
  };
}

import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

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
        "run",
        "Agentfile",
      ],
      output: "jsonl",
      input: "stdin",
      modelArg: "--model",
      modelAliases: OSTK_MODEL_ALIASES,
      serialize: true,
      // Session resume (resumeArgs, sessionArg, sessionMode) is intentionally
      // omitted. The ostk kernel manages session continuity internally via
      // session journals in .ostk/sessions/ — OpenClaw does not need to pass
      // session IDs or use resume args for this backend.
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
    },
  };
}

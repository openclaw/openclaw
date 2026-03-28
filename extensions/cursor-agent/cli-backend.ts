import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

export function buildCursorAgentCliBackend(): CliBackendPlugin {
  return {
    id: "cursor-agent",
    config: {
      command: "agent",
      args: ["-p", "--trust"],
      output: "text",
      input: "arg",
      modelArg: "--model",
      sessionMode: "none",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}

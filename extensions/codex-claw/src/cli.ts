import type { Command } from "commander";
import {
  formatInstallResult,
  formatStatus,
  installCodexClawBridge,
  readCodexClawStatus,
  type CodexClawMode,
  type CodexClawUserPromptReinject,
} from "./codex-desktop-bridge.js";
import { formatReviewPrompt } from "./review-prompt.js";

type CodexClawCliContext = {
  program: Command;
  workspaceDir?: string;
};

type InstallOptions = {
  agents?: string;
  soul?: string;
  codexHome?: string;
  mode?: CodexClawMode;
  userPromptReinject?: CodexClawUserPromptReinject;
  json?: boolean;
};

type StatusOptions = {
  codexHome?: string;
  json?: boolean;
};

export function registerCodexClawCli(ctx: CodexClawCliContext): void {
  const codexClaw = ctx.program
    .command("codex-claw")
    .description("Install and inspect the Codex Desktop AGENTS.md/SOUL.md bridge");

  codexClaw
    .command("install")
    .description("Write the bundled Codex Desktop plugin payload and Codex Claw config")
    .option("--agents <path>", "AGENTS.md path to load in Codex Desktop")
    .option("--soul <path>", "SOUL.md path to load in Codex Desktop")
    .option("--codex-home <path>", "Codex home directory", "~/.codex")
    .option("--mode <mode>", "Context loading mode: full, sentinel, or off", "full")
    .option(
      "--user-prompt-reinject <policy>",
      "UserPromptSubmit policy: after_compact, every_prompt, or off",
      "after_compact",
    )
    .option("--json", "Print machine-readable JSON")
    .action((options: InstallOptions) => {
      const result = installCodexClawBridge({
        codexHome: options.codexHome,
        workspaceDir: ctx.workspaceDir,
        agentsPath: options.agents,
        soulPath: options.soul,
        mode: options.mode,
        userPromptReinject: options.userPromptReinject,
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(formatInstallResult(result));
    });

  codexClaw
    .command("status")
    .description("Show the Codex Claw Desktop plugin payload and config state")
    .option("--codex-home <path>", "Codex home directory", "~/.codex")
    .option("--json", "Print machine-readable JSON")
    .action((options: StatusOptions) => {
      const status = readCodexClawStatus({
        codexHome: options.codexHome,
        workspaceDir: ctx.workspaceDir,
      });
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(formatStatus(status));
    });

  codexClaw
    .command("review-prompt")
    .description("Print the AGENTS.md/SOUL.md native Codex compatibility review prompt")
    .action(() => {
      console.log(formatReviewPrompt());
    });
}

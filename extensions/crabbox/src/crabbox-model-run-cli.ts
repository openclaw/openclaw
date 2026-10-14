import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveCrabboxBinary } from "./crabbox-binary.js";
import { runCrabboxModelCommand } from "./crabbox-model-run.js";

type CliContext = Parameters<Parameters<OpenClawPluginApi["registerCli"]>[0]>[0];

export function registerCrabboxModelRunCommand({
  program,
  config,
}: Pick<CliContext, "program" | "config">): void {
  const crabbox =
    program.commands.find((command) => command.name() === "crabbox") ?? program.command("crabbox");
  crabbox.description("Run model-backed commands and manage Crabbox warm images");
  crabbox
    .command("run")
    .description(
      "Run a foreground command on an exclusive Linux lease using a protected model credential",
    )
    .requiredOption("--id <lease>", "Existing, exclusively owned Crabbox lease")
    .requiredOption("--model <provider/model>", "Configured OpenAI-compatible API-key model")
    .option("--provider <provider>", "Crabbox backend override; otherwise use the lease's provider")
    .option("--binary <path>", "Crabbox binary with upstream proxy support")
    .option("--timeout <seconds>", "Total command and setup deadline in seconds", "600")
    .argument("<command...>", "Remote executable and arguments, following --")
    .action(
      async (
        argv: string[],
        options: {
          id: string;
          model: string;
          provider?: string;
          binary?: string;
          timeout: string;
        },
      ) => {
        const seconds = Number(options.timeout);
        if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400) {
          throw new Error("--timeout must be an integer between 1 and 86400 seconds");
        }
        const controller = new AbortController();
        const cancel = () => controller.abort(new Error("Crabbox model command interrupted"));
        process.once("SIGINT", cancel);
        process.once("SIGTERM", cancel);
        try {
          const result = await runCrabboxModelCommand({
            config,
            binary: resolveCrabboxBinary({ explicit: options.binary, pathEnv: process.env.PATH }),
            id: options.id,
            model: options.model,
            provider: options.provider,
            argv,
            timeoutMs: seconds * 1000,
            signal: controller.signal,
            onOutput: (text, stream) => {
              process[stream].write(text);
            },
          });
          process.exitCode = result.termination === "exit" ? (result.code ?? 1) : 1;
        } finally {
          process.off("SIGINT", cancel);
          process.off("SIGTERM", cancel);
        }
      },
    );
}

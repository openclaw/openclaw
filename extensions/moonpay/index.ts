import { execFile } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

function runMp(
  args: string[],
  env?: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      "mp",
      args,
      { timeout: 120_000, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode: error
            ? ((error as NodeJS.ErrnoException & { status?: number })?.status ?? 1)
            : 0,
        });
      },
    );
  });
}

const moonpayPlugin = {
  id: "moonpay",
  name: "MoonPay",
  description: "Crypto wallet, swaps, bridges, and fiat on/off-ramps via MoonPay CLI",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Generic mp CLI tool — lets the agent run any mp command
    api.registerTool(
      () => ({
        name: "moonpay_cli",
        description:
          "Run a MoonPay CLI (`mp`) command. Use for crypto operations: check wallet balances, swap tokens, bridge across chains, buy crypto with fiat, manage wallets, discover tokens, and more. Pass the full command arguments as a string array.",
        parameters: Type.Object({
          args: Type.Array(Type.String(), {
            description:
              'CLI arguments to pass to `mp`. Examples: ["wallet", "list"], ["token", "balance", "list", "--wallet", "0x...", "--chain", "ethereum"], ["token", "swap", "--wallet", "main", "--chain", "base", "--from-token", "0x...", "--to-token", "0x...", "--from-amount", "10"]',
          }),
        }),
        async execute({ args }: { args: string[] }) {
          // Block dangerous/internal commands
          const blockedTopLevel = ["consent", "skill"];
          const blockedSubcommands: Record<string, string[]> = {
            wallet: ["delete", "export"],
          };
          const cmd = args[0];
          const sub = args[1];
          if (cmd && blockedTopLevel.includes(cmd)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Command "${cmd}" is not available in this context.`,
                },
              ],
            };
          }
          if (cmd && sub && blockedSubcommands[cmd]?.includes(sub)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Command "${cmd} ${sub}" is not available in this context. This operation requires manual confirmation.`,
                },
              ],
            };
          }

          const { stdout, stderr, exitCode } = await runMp(args);
          const output = [stdout, stderr].filter(Boolean).join("\n").trim();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  output ||
                  (exitCode === 0
                    ? "Command completed successfully."
                    : `Command failed (exit ${exitCode}).`),
              },
            ],
          };
        },
      }),
      { names: ["moonpay_cli"] },
    );

    // Register CLI extension so `openclaw moonpay` works
    api.registerCli(
      ({ program }) => {
        const cmd = program.command("moonpay").description("MoonPay crypto operations");

        cmd
          .command("status")
          .description("Check MoonPay CLI installation and auth status")
          .action(async () => {
            const version = await runMp(["--version"]);
            const wallets = await runMp(["wallet", "list"]);
            console.log(`MoonPay CLI: ${version.stdout.trim() || "not installed"}`);
            if (wallets.stdout.trim()) {
              console.log(`\nWallets:\n${wallets.stdout.trim()}`);
            } else {
              console.log("\nNo wallets found. Run: mp login --email your@email.com");
            }
          });

        cmd
          .command("install")
          .description("Install MoonPay CLI globally")
          .action(async () => {
            const { execSync } = await import("node:child_process");
            try {
              execSync("npm install -g @moonpay/cli", { stdio: "inherit" });
              console.log("MoonPay CLI installed successfully.");
            } catch {
              console.error("Failed to install MoonPay CLI. Try: npm install -g @moonpay/cli");
            }
          });
      },
      { commands: ["moonpay"] },
    );

    // Check if mp is installed on plugin load
    runMp(["--version"]).then(({ stdout, exitCode }) => {
      if (exitCode === 0) {
        api.logger.info(`MoonPay CLI ${stdout.trim()} available`);
      } else {
        api.logger.warn("MoonPay CLI (mp) not found. Install with: npm install -g @moonpay/cli");
      }
    });
  },
};

export default moonpayPlugin;

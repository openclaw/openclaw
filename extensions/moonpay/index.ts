import { execFile } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/moonpay";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/moonpay";

function runMp(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("mp", args, { timeout: 120_000, env: process.env }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: error ? ((error as NodeJS.ErrnoException & { status?: number })?.status ?? 1) : 0,
      });
    });
  });
}

const BLOCKED_TOP_LEVEL = new Set(["consent", "skill"]);
const BLOCKED_SUBCOMMANDS: Record<string, Set<string>> = {
  wallet: new Set(["delete", "export"]),
};

const moonpayPlugin = {
  id: "moonpay",
  name: "MoonPay",
  description: "Crypto wallet, swaps, bridges, and fiat on/off-ramps via MoonPay CLI",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    api.registerTool(
      {
        name: "moonpay_cli",
        label: "MoonPay CLI",
        description:
          "Run a MoonPay CLI (`mp`) command. Use for crypto operations: check wallet balances, swap tokens, bridge across chains, buy crypto with fiat, manage wallets, discover tokens, and more.",
        parameters: {
          type: "object",
          properties: {
            args: {
              type: "array",
              items: { type: "string" },
              description:
                'CLI arguments to pass to `mp`. Examples: ["wallet", "list"], ["token", "balance", "list", "--wallet", "0x...", "--chain", "ethereum"]',
            },
          },
          required: ["args"],
        },
        async execute(_id: string, params: { args: string[] }) {
          const cmd = params.args[0];
          const sub = params.args[1];

          if (cmd && BLOCKED_TOP_LEVEL.has(cmd)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Command "${cmd}" is not available in this context.`,
                },
              ],
              details: undefined,
            };
          }
          if (cmd && sub && BLOCKED_SUBCOMMANDS[cmd]?.has(sub)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Command "${cmd} ${sub}" is not available in this context. This operation requires manual confirmation.`,
                },
              ],
              details: undefined,
            };
          }

          const { stdout, stderr, exitCode } = await runMp(params.args);
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
            details: undefined,
          };
        },
      },
      { names: ["moonpay_cli"] },
    );

    api.registerCli(
      ({ program }) => {
        const cmd = program.command("moonpay").description("MoonPay crypto operations");

        cmd
          .command("status")
          .description("Check MoonPay CLI installation and auth status")
          .action(async () => {
            const version = await runMp(["--version"]);
            console.log(`MoonPay CLI: ${version.stdout.trim() || "not installed"}`);
            if (version.exitCode !== 0) {
              return;
            }
            const wallets = await runMp(["wallet", "list"]);
            if (wallets.exitCode !== 0) {
              console.log(`\nWallet check failed: ${wallets.stderr.trim() || "unknown error"}`);
            } else if (wallets.stdout.trim()) {
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

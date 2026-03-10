import { execFile } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/moonpay";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/moonpay";

export function runMp(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile("mp", args, { timeout: 120_000, env: process.env }, (error, stdout, stderr) => {
      if (error) {
        const errno = error as NodeJS.ErrnoException & { status?: number };
        // ENOENT / EACCES etc. — binary missing or not executable
        const exitCode = typeof errno.status === "number" ? errno.status : 1;
        resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", exitCode });
        return;
      }
      resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", exitCode: 0 });
    });
  });
}

const BLOCKED_TOP_LEVEL = new Set(["consent", "skill"]);
const BLOCKED_SUBCOMMANDS: Record<string, Set<string>> = {
  wallet: new Set(["delete", "export"]),
};

/** Strip leading flags (--foo, -f, --bar=val) to find the positional command/subcommand. */
export function extractPositionals(args: string[]): {
  cmd: string | undefined;
  sub: string | undefined;
} {
  const positionals: string[] = [];
  for (let i = 0; i < args.length && positionals.length < 2; i++) {
    const arg = args[i];
    if (arg === "--") break;
    if (arg?.startsWith("-")) {
      // skip --flag=value; for --flag value, skip next token too
      if (arg.includes("=")) continue;
      // flags like --verbose (no value) vs --timeout 30 — we can't perfectly distinguish,
      // but top-level mp flags that take values are rare; safer to just skip dashes
      continue;
    }
    if (arg !== undefined) positionals.push(arg);
  }
  return { cmd: positionals[0], sub: positionals[1] };
}

export function isBlocked(args: string[]): string | undefined {
  const { cmd, sub } = extractPositionals(args);
  if (cmd && BLOCKED_TOP_LEVEL.has(cmd)) {
    return `Command "${cmd}" is not available in this context.`;
  }
  if (cmd && sub && BLOCKED_SUBCOMMANDS[cmd]?.has(sub)) {
    return `Command "${cmd} ${sub}" is not available in this context. This operation requires manual confirmation.`;
  }
  return undefined;
}

const moonpayPlugin = {
  id: "moonpay",
  name: "MoonPay",
  description: "Crypto wallet, swaps, bridges, and fiat on/off-ramps via MoonPay CLI",
  configSchema: emptyPluginConfigSchema(),

  register(api: OpenClawPluginApi) {
    // Check mp availability first; only register the tool if the binary exists.
    const mpAvailable = new Promise<boolean>((resolve) => {
      execFile("mp", ["--version"], { timeout: 10_000 }, (error, stdout) => {
        if (error) {
          api.logger.warn("MoonPay CLI (mp) not found. Install with: npm install -g @moonpay/cli");
          resolve(false);
        } else {
          api.logger.info(`MoonPay CLI ${stdout?.toString().trim()} available`);
          resolve(true);
        }
      });
    });

    mpAvailable.then((available) => {
      if (!available) return;
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
            const blocked = isBlocked(params.args);
            if (blocked) {
              return {
                content: [{ type: "text" as const, text: blocked }],
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
    });

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
  },
};

export default moonpayPlugin;

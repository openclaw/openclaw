import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { tlonPlugin } from "./src/channel.js";
import { setTlonRuntime } from "./src/runtime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Whitelist of allowed tlon subcommands
const ALLOWED_TLON_COMMANDS = new Set([
  "activity",
  "channels",
  "contacts",
  "groups",
  "messages",
  "dms",
  "posts",
  "notebook",
  "settings",
  "help",
  "version",
]);

/**
 * Find the tlon binary from the skill package
 */
function findTlonBinary(): string {
  // Check in node_modules/.bin
  const skillBin = join(__dirname, "node_modules", ".bin", "tlon");
  console.log(`[tlon] Checking for binary at: ${skillBin}, exists: ${existsSync(skillBin)}`);
  if (existsSync(skillBin)) return skillBin;

  // Check for platform-specific binary directly
  const platform = process.platform;
  const arch = process.arch;
  const platformPkg = `@tloncorp/tlon-skill-${platform}-${arch}`;
  const platformBin = join(__dirname, "node_modules", platformPkg, "tlon");
  console.log(
    `[tlon] Checking for platform binary at: ${platformBin}, exists: ${existsSync(platformBin)}`,
  );
  if (existsSync(platformBin)) return platformBin;

  // Fallback to PATH
  console.log(`[tlon] Falling back to PATH lookup for 'tlon'`);
  return "tlon";
}

/**
 * Shell-like argument splitter that respects quotes
 */
function shellSplit(str: string): string[] {
  const args: string[] = [];
  let cur = "";
  let inDouble = false;
  let inSingle = false;
  let escape = false;

  for (const ch of str) {
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escape = true;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (/\s/.test(ch) && !inDouble && !inSingle) {
      if (cur) {
        args.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) args.push(cur);
  return args;
}

/**
 * Run the tlon command and return the result
 */
function runTlonCommand(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to run tlon: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `tlon exited with code ${code}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

const plugin = {
  id: "tlon",
  name: "Tlon",
  description: "Tlon/Urbit channel plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setTlonRuntime(api.runtime);
    api.registerChannel({ plugin: tlonPlugin });

    // Register the tlon tool
    const tlonBinary = findTlonBinary();
    api.logger.info(`[tlon] Registering tlon tool, binary: ${tlonBinary}`);
    api.registerTool({
      name: "tlon",
      label: "Tlon CLI",
      description:
        "Tlon/Urbit API operations: activity, channels, contacts, groups, messages, dms, posts, notebook, settings. " +
        "Examples: 'activity mentions --limit 10', 'channels groups', 'contacts self', 'groups list'",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The tlon command and arguments. " +
              "Examples: 'activity mentions --limit 10', 'contacts get ~sampel-palnet', 'groups list'",
          },
        },
        required: ["command"],
      },
      async execute(_id: string, params: { command: string }) {
        try {
          const args = shellSplit(params.command);

          // Validate first argument is a whitelisted tlon subcommand
          const subcommand = args[0];
          if (!ALLOWED_TLON_COMMANDS.has(subcommand)) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error: Unknown tlon subcommand '${subcommand}'. Allowed: ${[...ALLOWED_TLON_COMMANDS].join(", ")}`,
                },
              ],
              details: { error: true },
            };
          }

          const output = await runTlonCommand(tlonBinary, args);
          return {
            content: [{ type: "text" as const, text: output }],
            details: undefined,
          };
        } catch (error: any) {
          return {
            content: [{ type: "text" as const, text: `Error: ${error.message}` }],
            details: { error: true },
          };
        }
      },
    });
  },
};

export default plugin;

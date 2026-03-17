import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/tlon";
import { tlonPlugin } from "./src/channel.js";
import { setTlonRuntime } from "./src/runtime.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ALLOWED_TLON_COMMANDS = /* @__PURE__ */ new Set([
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
  "version"
]);
function findTlonBinary() {
  const skillBin = join(__dirname, "node_modules", ".bin", "tlon");
  console.log(`[tlon] Checking for binary at: ${skillBin}, exists: ${existsSync(skillBin)}`);
  if (existsSync(skillBin)) return skillBin;
  const platform = process.platform;
  const arch = process.arch;
  const platformPkg = `@tloncorp/tlon-skill-${platform}-${arch}`;
  const platformBin = join(__dirname, "node_modules", platformPkg, "tlon");
  console.log(
    `[tlon] Checking for platform binary at: ${platformBin}, exists: ${existsSync(platformBin)}`
  );
  if (existsSync(platformBin)) return platformBin;
  console.log(`[tlon] Falling back to PATH lookup for 'tlon'`);
  return "tlon";
}
function shellSplit(str) {
  const args = [];
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
function runTlonCommand(binary, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      env: process.env
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
  register(api) {
    setTlonRuntime(api.runtime);
    api.registerChannel({ plugin: tlonPlugin });
    const tlonBinary = findTlonBinary();
    api.logger.info(`[tlon] Registering tlon tool, binary: ${tlonBinary}`);
    api.registerTool({
      name: "tlon",
      label: "Tlon CLI",
      description: "Tlon/Urbit API operations: activity, channels, contacts, groups, messages, dms, posts, notebook, settings. Examples: 'activity mentions --limit 10', 'channels groups', 'contacts self', 'groups list'",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The tlon command and arguments. Examples: 'activity mentions --limit 10', 'contacts get ~sampel-palnet', 'groups list'"
          }
        },
        required: ["command"]
      },
      async execute(_id, params) {
        try {
          const args = shellSplit(params.command);
          const subcommand = args[0];
          if (!ALLOWED_TLON_COMMANDS.has(subcommand)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Unknown tlon subcommand '${subcommand}'. Allowed: ${[...ALLOWED_TLON_COMMANDS].join(", ")}`
                }
              ],
              details: { error: true }
            };
          }
          const output = await runTlonCommand(tlonBinary, args);
          return {
            content: [{ type: "text", text: output }],
            details: void 0
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: `Error: ${error.message}` }],
            details: { error: true }
          };
        }
      }
    });
  }
};
var tlon_default = plugin;
export {
  tlon_default as default
};

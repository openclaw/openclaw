import { i as formatErrorMessage } from "../../errors-QN8rySzW.js";
import "../../error-runtime-B9i9dR6-.js";
import { t as defineBundledChannelEntry } from "../../channel-entry-contract-CSjRAxu4.js";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
//#region extensions/tlon/index.ts
const __dirname = dirname(fileURLToPath(import.meta.url));
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
	"version"
]);
let cachedTlonBinary;
function findTlonBinary() {
	if (cachedTlonBinary) return cachedTlonBinary;
	const skillBin = join(__dirname, "node_modules", ".bin", "tlon");
	if (existsSync(skillBin)) {
		cachedTlonBinary = skillBin;
		return skillBin;
	}
	const platformBin = join(__dirname, "node_modules", `@tloncorp/tlon-skill-${process.platform}-${process.arch}`, "tlon");
	if (existsSync(platformBin)) {
		cachedTlonBinary = platformBin;
		return platformBin;
	}
	cachedTlonBinary = "tlon";
	return cachedTlonBinary;
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
		if (ch === "\"" && !inSingle) {
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
		const child = spawn(binary, args, { env: process.env });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (data) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data) => {
			stderr += data.toString();
		});
		child.on("error", (err) => {
			reject(/* @__PURE__ */ new Error(`Failed to run tlon: ${err.message}`));
		});
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(stderr || `tlon exited with code ${code}`));
				return;
			}
			resolve(stdout);
		});
	});
}
var tlon_default = defineBundledChannelEntry({
	id: "tlon",
	name: "Tlon",
	description: "Tlon/Urbit channel plugin",
	importMetaUrl: import.meta.url,
	plugin: {
		specifier: "./channel-plugin-api.js",
		exportName: "tlonPlugin"
	},
	runtime: {
		specifier: "./api.js",
		exportName: "setTlonRuntime"
	},
	registerFull(api) {
		api.registerTool({
			name: "tlon",
			label: "Tlon CLI",
			description: "Tlon/Urbit API operations: activity, channels, contacts, groups, messages, dms, posts, notebook, settings. Examples: 'activity mentions --limit 10', 'channels groups', 'contacts self', 'groups list'",
			parameters: {
				type: "object",
				properties: { command: {
					type: "string",
					description: "The tlon command and arguments. Examples: 'activity mentions --limit 10', 'contacts get ~sampel-palnet', 'groups list'"
				} },
				required: ["command"]
			},
			async execute(_id, params) {
				try {
					const args = shellSplit(params.command);
					const subcommand = args[0];
					if (!ALLOWED_TLON_COMMANDS.has(subcommand)) return {
						content: [{
							type: "text",
							text: `Error: Unknown tlon subcommand '${subcommand}'. Allowed: ${[...ALLOWED_TLON_COMMANDS].join(", ")}`
						}],
						details: { error: true }
					};
					return {
						content: [{
							type: "text",
							text: await runTlonCommand(findTlonBinary(), args)
						}],
						details: void 0
					};
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: `Error: ${formatErrorMessage(error)}`
						}],
						details: { error: true }
					};
				}
			}
		});
	}
});
//#endregion
export { tlon_default as default };

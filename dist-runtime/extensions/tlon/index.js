import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-BZ4hHpx2.js";
import "../../logger-CRwcgB9y.js";
import "../../tmp-openclaw-dir-Bz3ouN_i.js";
import "../../paths-Byjx7_T6.js";
import "../../subsystem-CsP80x3t.js";
import "../../utils-o1tyfnZ_.js";
import "../../fetch-Dx857jUp.js";
import "../../retry-BY_ggjbn.js";
import "../../agent-scope-DV_aCIyi.js";
import "../../exec-BLi45_38.js";
import "../../logger-Bsnck4bK.js";
import "../../paths-OqPpu-UR.js";
import "../../auth-profiles-CuJtivJK.js";
import "../../profiles-CV7WLKIX.js";
import "../../fetch-D2ZOzaXt.js";
import "../../external-content-vZzOHxnd.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-l-LpSxGW.js";
import "../../pairing-token-DKpN4qO0.js";
import "../../query-expansion-txqQdNIf.js";
import "../../redact-BefI-5cC.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-BpDGEQsl.js";
import "../../typebox-BmZP6XXv.js";
import "../../web-search-plugin-factory-DStYVW2B.js";
import "../../compat-DDXNEdAm.js";
import "../../inbound-envelope-DsNRW6ln.js";
import "../../run-command-Psw08BkS.js";
import "../../device-pairing-DYWF-CWB.js";
import "../../line-iO245OTq.js";
import "../../upsert-with-lock-CLs2bE4R.js";
import "../../self-hosted-provider-setup-C4OZCxyb.js";
import "../../ollama-setup-BM-G12b6.js";
import { n as setTlonRuntime, t as tlonPlugin } from "../../channel-H9wthycs.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
/**
* Find the tlon binary from the skill package
*/
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
/**
* Shell-like argument splitter that respects quotes
*/
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
/**
* Run the tlon command and return the result
*/
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
			if (code !== 0) reject(new Error(stderr || `tlon exited with code ${code}`));
			else resolve(stdout);
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
		if (api.registrationMode !== "full") return;
		api.logger.debug?.("[tlon] Registering tlon tool");
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
					const tlonBinary = findTlonBinary();
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
							text: await runTlonCommand(tlonBinary, args)
						}],
						details: void 0
					};
				} catch (error) {
					return {
						content: [{
							type: "text",
							text: `Error: ${error.message}`
						}],
						details: { error: true }
					};
				}
			}
		});
	}
};
//#endregion
export { plugin as default };

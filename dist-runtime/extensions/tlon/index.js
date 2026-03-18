import "../../provider-env-vars-BfZUtZAn.js";
import { t as emptyPluginConfigSchema } from "../../config-schema-DpOJkOlS.js";
import "../../resolve-route-CQsiaDZO.js";
import "../../logger-BOdgfoqz.js";
import "../../tmp-openclaw-dir-DgEKZnX6.js";
import "../../paths-CbmqEZIn.js";
import "../../subsystem-CsPxmH8p.js";
import "../../utils-CMc9mmF8.js";
import "../../fetch-BgkAjqxB.js";
import "../../retry-CgLvWye-.js";
import "../../agent-scope-CM8plEdu.js";
import "../../exec-CWMR162-.js";
import "../../logger-C833gw0R.js";
import "../../paths-DAoqckDF.js";
import "../../auth-profiles-B70DPAVa.js";
import "../../profiles-BC4VpDll.js";
import "../../fetch-BX2RRCzB.js";
import "../../external-content-CxoN_TKD.js";
import "../../kilocode-shared-Ci8SRxXc.js";
import "../../models-config.providers.static-DRBnLpDj.js";
import "../../models-config.providers.discovery-gVOHvGnm.js";
import "../../pairing-token-Do-E3rL5.js";
import "../../query-expansion-Do6vyPvH.js";
import "../../redact-BZcL_gJG.js";
import "../../mime-33LCeGh-.js";
import "../../resolve-utils-D6VN4BvH.js";
import "../../typebox-B4kR5eyM.js";
import "../../web-search-plugin-factory-CeUlA68v.js";
import "../../compat-CwB8x8Tr.js";
import "../../inbound-envelope-DsYY1Vpm.js";
import "../../run-command-B9zmAfEF.js";
import "../../device-pairing-CsJif6Rb.js";
import "../../line-DvbTO_h3.js";
import "../../upsert-with-lock-BkGBN4WL.js";
import "../../self-hosted-provider-setup-Bgv4n1Xv.js";
import "../../ollama-setup-CXkNt6CA.js";
import { n as setTlonRuntime, t as tlonPlugin } from "../../channel-THfTR4g22.js";
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

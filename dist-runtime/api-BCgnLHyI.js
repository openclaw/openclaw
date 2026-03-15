import { i as __require, t as __commonJSMin } from "./chunk-DORXReHP.js";
import { g as normalizeAccountId } from "./session-key-BfFG0xOA.js";
import { $t as createAccountListHelpers, dr as applyAccountNameToChannelSection, fr as applySetupAccountConfigPatch, pr as migrateBaseNameToDefaultAccount } from "./resolve-route-BZ4hHpx2.js";
import { a as isSecretRef } from "./types.secrets-apkw3WZr.js";
import { Bl as splitSetupEntries, Cl as formatDocsLink, El as mergeAllowFromEntries, wl as addWildcardAllowFrom } from "./auth-profiles-CuJtivJK.js";
import { f as fetchWithSsrFGuard } from "./external-content-vZzOHxnd.js";
import { t as require_json_bigint } from "./json-bigint-fVriNVNM.js";
import { n as require_ecdsa_sig_formatter, t as require_jws } from "./jws-BKiq3PLu.js";
import crypto from "node:crypto";
//#region extensions/googlechat/src/setup-core.ts
const channel$1 = "googlechat";
const googlechatSetupAdapter = {
	resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
	applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
		cfg,
		channelKey: channel$1,
		accountId,
		name
	}),
	validateInput: ({ accountId, input }) => {
		if (input.useEnv && accountId !== "default") {return "GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.";}
		if (!input.useEnv && !input.token && !input.tokenFile) {return "Google Chat requires --token (service account JSON) or --token-file.";}
		return null;
	},
	applyAccountConfig: ({ cfg, accountId, input }) => {
		const namedConfig = applyAccountNameToChannelSection({
			cfg,
			channelKey: channel$1,
			accountId,
			name: input.name
		});
		const next = accountId !== "default" ? migrateBaseNameToDefaultAccount({
			cfg: namedConfig,
			channelKey: channel$1
		}) : namedConfig;
		const patch = input.useEnv ? {} : input.tokenFile ? { serviceAccountFile: input.tokenFile } : input.token ? { serviceAccount: input.token } : {};
		const audienceType = input.audienceType?.trim();
		const audience = input.audience?.trim();
		const webhookPath = input.webhookPath?.trim();
		const webhookUrl = input.webhookUrl?.trim();
		return applySetupAccountConfigPatch({
			cfg: next,
			channelKey: channel$1,
			accountId,
			patch: {
				...patch,
				...audienceType ? { audienceType } : {},
				...audience ? { audience } : {},
				...webhookPath ? { webhookPath } : {},
				...webhookUrl ? { webhookUrl } : {}
			}
		});
	}
};
//#endregion
//#region extensions/googlechat/src/accounts.ts
const ENV_SERVICE_ACCOUNT$1 = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE$1 = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const { listAccountIds: listGoogleChatAccountIds, resolveDefaultAccountId: resolveDefaultGoogleChatAccountId } = createAccountListHelpers("googlechat");
function resolveAccountConfig(cfg, accountId) {
	const accounts = cfg.channels?.["googlechat"]?.accounts;
	if (!accounts || typeof accounts !== "object") {return;}
	return accounts[accountId];
}
function mergeGoogleChatAccountConfig(cfg, accountId) {
	const { accounts: _ignored, defaultAccount: _ignored2, ...base } = cfg.channels?.["googlechat"] ?? {};
	const defaultAccountConfig = resolveAccountConfig(cfg, "default") ?? {};
	const account = resolveAccountConfig(cfg, accountId) ?? {};
	if (accountId === "default") {return {
		...base,
		...defaultAccountConfig
	};}
	const { enabled: _ignoredEnabled, dangerouslyAllowNameMatching: _ignoredDangerouslyAllowNameMatching, serviceAccount: _ignoredServiceAccount, serviceAccountRef: _ignoredServiceAccountRef, serviceAccountFile: _ignoredServiceAccountFile, ...defaultAccountShared } = defaultAccountConfig;
	return {
		...defaultAccountShared,
		...base,
		...account
	};
}
function parseServiceAccount(value) {
	if (value && typeof value === "object") {
		if (isSecretRef(value)) {return null;}
		return value;
	}
	if (typeof value !== "string") {return null;}
	const trimmed = value.trim();
	if (!trimmed) {return null;}
	try {
		return JSON.parse(trimmed);
	} catch {
		return null;
	}
}
function resolveCredentialsFromConfig(params) {
	const { account, accountId } = params;
	const inline = parseServiceAccount(account.serviceAccount);
	if (inline) {return {
		credentials: inline,
		source: "inline"
	};}
	if (isSecretRef(account.serviceAccount)) {throw new Error(`channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccount.source}:${account.serviceAccount.provider}:${account.serviceAccount.id}". Resolve this command against an active gateway runtime snapshot before reading it.`);}
	if (isSecretRef(account.serviceAccountRef)) {throw new Error(`channels.googlechat.accounts.${accountId}.serviceAccount: unresolved SecretRef "${account.serviceAccountRef.source}:${account.serviceAccountRef.provider}:${account.serviceAccountRef.id}". Resolve this command against an active gateway runtime snapshot before reading it.`);}
	const file = account.serviceAccountFile?.trim();
	if (file) {return {
		credentialsFile: file,
		source: "file"
	};}
	if (accountId === "default") {
		const envJson = process.env[ENV_SERVICE_ACCOUNT$1];
		const envInline = parseServiceAccount(envJson);
		if (envInline) {return {
			credentials: envInline,
			source: "env"
		};}
		const envFile = process.env[ENV_SERVICE_ACCOUNT_FILE$1]?.trim();
		if (envFile) {return {
			credentialsFile: envFile,
			source: "env"
		};}
	}
	return { source: "none" };
}
function resolveGoogleChatAccount(params) {
	const accountId = normalizeAccountId(params.accountId);
	const baseEnabled = params.cfg.channels?.["googlechat"]?.enabled !== false;
	const merged = mergeGoogleChatAccountConfig(params.cfg, accountId);
	const accountEnabled = merged.enabled !== false;
	const enabled = baseEnabled && accountEnabled;
	const credentials = resolveCredentialsFromConfig({
		accountId,
		account: merged
	});
	return {
		accountId,
		name: merged.name?.trim() || void 0,
		enabled,
		config: merged,
		credentialSource: credentials.source,
		credentials: credentials.credentials,
		credentialsFile: credentials.credentialsFile
	};
}
function listEnabledGoogleChatAccounts(cfg) {
	return listGoogleChatAccountIds(cfg).map((accountId) => resolveGoogleChatAccount({
		cfg,
		accountId
	})).filter((account) => account.enabled);
}
//#endregion
//#region extensions/googlechat/src/setup-surface.ts
const channel = "googlechat";
const ENV_SERVICE_ACCOUNT = "GOOGLE_CHAT_SERVICE_ACCOUNT";
const ENV_SERVICE_ACCOUNT_FILE = "GOOGLE_CHAT_SERVICE_ACCOUNT_FILE";
const USE_ENV_FLAG = "__googlechatUseEnv";
const AUTH_METHOD_FLAG = "__googlechatAuthMethod";
function setGoogleChatDmPolicy(cfg, policy) {
	const allowFrom = policy === "open" ? addWildcardAllowFrom(cfg.channels?.googlechat?.dm?.allowFrom) : void 0;
	return {
		...cfg,
		channels: {
			...cfg.channels,
			googlechat: {
				...cfg.channels?.googlechat,
				dm: {
					...cfg.channels?.googlechat?.dm,
					policy,
					...allowFrom ? { allowFrom } : {}
				}
			}
		}
	};
}
async function promptAllowFrom(params) {
	const current = params.cfg.channels?.googlechat?.dm?.allowFrom ?? [];
	const entry = await params.prompter.text({
		message: "Google Chat allowFrom (users/<id> or raw email; avoid users/<email>)",
		placeholder: "users/123456789, name@example.com",
		initialValue: current[0] ? String(current[0]) : void 0,
		validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
	});
	const unique = mergeAllowFromEntries(void 0, splitSetupEntries(String(entry)));
	return {
		...params.cfg,
		channels: {
			...params.cfg.channels,
			googlechat: {
				...params.cfg.channels?.googlechat,
				enabled: true,
				dm: {
					...params.cfg.channels?.googlechat?.dm,
					policy: "allowlist",
					allowFrom: unique
				}
			}
		}
	};
}
const googlechatDmPolicy = {
	label: "Google Chat",
	channel,
	policyKey: "channels.googlechat.dm.policy",
	allowFromKey: "channels.googlechat.dm.allowFrom",
	getCurrent: (cfg) => cfg.channels?.googlechat?.dm?.policy ?? "pairing",
	setPolicy: (cfg, policy) => setGoogleChatDmPolicy(cfg, policy),
	promptAllowFrom
};
const googlechatSetupWizard = {
	channel,
	status: {
		configuredLabel: "configured",
		unconfiguredLabel: "needs service account",
		configuredHint: "configured",
		unconfiguredHint: "needs auth",
		resolveConfigured: ({ cfg }) => listGoogleChatAccountIds(cfg).some((accountId) => resolveGoogleChatAccount({
			cfg,
			accountId
		}).credentialSource !== "none"),
		resolveStatusLines: ({ cfg }) => {
			return [`Google Chat: ${listGoogleChatAccountIds(cfg).some((accountId) => resolveGoogleChatAccount({
				cfg,
				accountId
			}).credentialSource !== "none") ? "configured" : "needs service account"}`];
		}
	},
	introNote: {
		title: "Google Chat setup",
		lines: [
			"Google Chat apps use service-account auth and an HTTPS webhook.",
			"Set the Chat API scopes in your service account and configure the Chat app URL.",
			"Webhook verification requires audience type + audience value.",
			`Docs: ${formatDocsLink("/channels/googlechat", "googlechat")}`
		]
	},
	prepare: async ({ cfg, accountId, credentialValues, prompter }) => {
		if (accountId === "default" && (Boolean(process.env[ENV_SERVICE_ACCOUNT]) || Boolean(process.env[ENV_SERVICE_ACCOUNT_FILE]))) {
			if (await prompter.confirm({
				message: "Use GOOGLE_CHAT_SERVICE_ACCOUNT env vars?",
				initialValue: true
			})) {return {
				cfg: applySetupAccountConfigPatch({
					cfg,
					channelKey: channel,
					accountId,
					patch: {}
				}),
				credentialValues: {
					...credentialValues,
					[USE_ENV_FLAG]: "1"
				}
			};}
		}
		const method = await prompter.select({
			message: "Google Chat auth method",
			options: [{
				value: "file",
				label: "Service account JSON file"
			}, {
				value: "inline",
				label: "Paste service account JSON"
			}],
			initialValue: "file"
		});
		return { credentialValues: {
			...credentialValues,
			[USE_ENV_FLAG]: "0",
			[AUTH_METHOD_FLAG]: String(method)
		} };
	},
	credentials: [],
	textInputs: [{
		inputKey: "tokenFile",
		message: "Service account JSON path",
		placeholder: "/path/to/service-account.json",
		shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1" && credentialValues[AUTH_METHOD_FLAG] === "file",
		validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
		normalizeValue: ({ value }) => String(value).trim(),
		applySet: async ({ cfg, accountId, value }) => applySetupAccountConfigPatch({
			cfg,
			channelKey: channel,
			accountId,
			patch: { serviceAccountFile: value }
		})
	}, {
		inputKey: "token",
		message: "Service account JSON (single line)",
		placeholder: "{\"type\":\"service_account\", ... }",
		shouldPrompt: ({ credentialValues }) => credentialValues[USE_ENV_FLAG] !== "1" && credentialValues[AUTH_METHOD_FLAG] === "inline",
		validate: ({ value }) => String(value ?? "").trim() ? void 0 : "Required",
		normalizeValue: ({ value }) => String(value).trim(),
		applySet: async ({ cfg, accountId, value }) => applySetupAccountConfigPatch({
			cfg,
			channelKey: channel,
			accountId,
			patch: { serviceAccount: value }
		})
	}],
	finalize: async ({ cfg, accountId, prompter }) => {
		const account = resolveGoogleChatAccount({
			cfg,
			accountId
		});
		const audienceType = await prompter.select({
			message: "Webhook audience type",
			options: [{
				value: "app-url",
				label: "App URL (recommended)"
			}, {
				value: "project-number",
				label: "Project number"
			}],
			initialValue: account.config.audienceType === "project-number" ? "project-number" : "app-url"
		});
		const audience = await prompter.text({
			message: audienceType === "project-number" ? "Project number" : "App URL",
			placeholder: audienceType === "project-number" ? "1234567890" : "https://your.host/googlechat",
			initialValue: account.config.audience || void 0,
			validate: (value) => String(value ?? "").trim() ? void 0 : "Required"
		});
		return { cfg: migrateBaseNameToDefaultAccount({
			cfg: applySetupAccountConfigPatch({
				cfg,
				channelKey: channel,
				accountId,
				patch: {
					audienceType,
					audience: String(audience).trim()
				}
			}),
			channelKey: channel
		}) };
	},
	dmPolicy: googlechatDmPolicy
};
//#endregion
//#region node_modules/.pnpm/gcp-metadata@8.1.2/node_modules/gcp-metadata/build/src/gcp-residency.js
var require_gcp_residency = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Copyright 2022 Google LLC
	*
	* Licensed under the Apache License, Version 2.0 (the "License");
	* you may not use this file except in compliance with the License.
	* You may obtain a copy of the License at
	*
	*      http://www.apache.org/licenses/LICENSE-2.0
	*
	* Unless required by applicable law or agreed to in writing, software
	* distributed under the License is distributed on an "AS IS" BASIS,
	* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	* See the License for the specific language governing permissions and
	* limitations under the License.
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GCE_LINUX_BIOS_PATHS = void 0;
	exports.isGoogleCloudServerless = isGoogleCloudServerless;
	exports.isGoogleComputeEngineLinux = isGoogleComputeEngineLinux;
	exports.isGoogleComputeEngineMACAddress = isGoogleComputeEngineMACAddress;
	exports.isGoogleComputeEngine = isGoogleComputeEngine;
	exports.detectGCPResidency = detectGCPResidency;
	const fs_1 = __require("fs");
	const os_1 = __require("os");
	/**
	* Known paths unique to Google Compute Engine Linux instances
	*/
	exports.GCE_LINUX_BIOS_PATHS = {
		BIOS_DATE: "/sys/class/dmi/id/bios_date",
		BIOS_VENDOR: "/sys/class/dmi/id/bios_vendor"
	};
	const GCE_MAC_ADDRESS_REGEX = /^42:01/;
	/**
	* Determines if the process is running on a Google Cloud Serverless environment (Cloud Run or Cloud Functions instance).
	*
	* Uses the:
	* - {@link https://cloud.google.com/run/docs/container-contract#env-vars Cloud Run environment variables}.
	* - {@link https://cloud.google.com/functions/docs/env-var Cloud Functions environment variables}.
	*
	* @returns {boolean} `true` if the process is running on GCP serverless, `false` otherwise.
	*/
	function isGoogleCloudServerless() {
		return !!(process.env.CLOUD_RUN_JOB || process.env.FUNCTION_NAME || process.env.K_SERVICE);
	}
	/**
	* Determines if the process is running on a Linux Google Compute Engine instance.
	*
	* @returns {boolean} `true` if the process is running on Linux GCE, `false` otherwise.
	*/
	function isGoogleComputeEngineLinux() {
		if ((0, os_1.platform)() !== "linux") {return false;}
		try {
			(0, fs_1.statSync)(exports.GCE_LINUX_BIOS_PATHS.BIOS_DATE);
			const biosVendor = (0, fs_1.readFileSync)(exports.GCE_LINUX_BIOS_PATHS.BIOS_VENDOR, "utf8");
			return /Google/.test(biosVendor);
		} catch {
			return false;
		}
	}
	/**
	* Determines if the process is running on a Google Compute Engine instance with a known
	* MAC address.
	*
	* @returns {boolean} `true` if the process is running on GCE (as determined by MAC address), `false` otherwise.
	*/
	function isGoogleComputeEngineMACAddress() {
		const interfaces = (0, os_1.networkInterfaces)();
		for (const item of Object.values(interfaces)) {
			if (!item) {continue;}
			for (const { mac } of item) {if (GCE_MAC_ADDRESS_REGEX.test(mac)) return true;}
		}
		return false;
	}
	/**
	* Determines if the process is running on a Google Compute Engine instance.
	*
	* @returns {boolean} `true` if the process is running on GCE, `false` otherwise.
	*/
	function isGoogleComputeEngine() {
		return isGoogleComputeEngineLinux() || isGoogleComputeEngineMACAddress();
	}
	/**
	* Determines if the process is running on Google Cloud Platform.
	*
	* @returns {boolean} `true` if the process is running on GCP, `false` otherwise.
	*/
	function detectGCPResidency() {
		return isGoogleCloudServerless() || isGoogleComputeEngine();
	}
}));
//#endregion
//#region node_modules/.pnpm/google-logging-utils@1.1.3/node_modules/google-logging-utils/build/src/colours.js
var require_colours = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Colours = void 0;
	/**
	* Handles figuring out if we can use ANSI colours and handing out the escape codes.
	*
	* This is for package-internal use only, and may change at any time.
	*
	* @private
	* @internal
	*/
	var Colours = class Colours {
		/**
		* @param stream The stream (e.g. process.stderr)
		* @returns true if the stream should have colourization enabled
		*/
		static isEnabled(stream) {
			return stream && stream.isTTY && (typeof stream.getColorDepth === "function" ? stream.getColorDepth() > 2 : true);
		}
		static refresh() {
			Colours.enabled = Colours.isEnabled(process === null || process === void 0 ? void 0 : process.stderr);
			if (!this.enabled) {
				Colours.reset = "";
				Colours.bright = "";
				Colours.dim = "";
				Colours.red = "";
				Colours.green = "";
				Colours.yellow = "";
				Colours.blue = "";
				Colours.magenta = "";
				Colours.cyan = "";
				Colours.white = "";
				Colours.grey = "";
			} else {
				Colours.reset = "\x1B[0m";
				Colours.bright = "\x1B[1m";
				Colours.dim = "\x1B[2m";
				Colours.red = "\x1B[31m";
				Colours.green = "\x1B[32m";
				Colours.yellow = "\x1B[33m";
				Colours.blue = "\x1B[34m";
				Colours.magenta = "\x1B[35m";
				Colours.cyan = "\x1B[36m";
				Colours.white = "\x1B[37m";
				Colours.grey = "\x1B[90m";
			}
		}
	};
	exports.Colours = Colours;
	Colours.enabled = false;
	Colours.reset = "";
	Colours.bright = "";
	Colours.dim = "";
	Colours.red = "";
	Colours.green = "";
	Colours.yellow = "";
	Colours.blue = "";
	Colours.magenta = "";
	Colours.cyan = "";
	Colours.white = "";
	Colours.grey = "";
	Colours.refresh();
}));
//#endregion
//#region node_modules/.pnpm/google-logging-utils@1.1.3/node_modules/google-logging-utils/build/src/logging-utils.js
var require_logging_utils = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};}
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) {if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;}
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) {return mod;}
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) {if (k[i] !== "default") __createBinding(result, mod, k[i]);}
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.env = exports.DebugLogBackendBase = exports.placeholder = exports.AdhocDebugLogger = exports.LogSeverity = void 0;
	exports.getNodeBackend = getNodeBackend;
	exports.getDebugBackend = getDebugBackend;
	exports.getStructuredBackend = getStructuredBackend;
	exports.setBackend = setBackend;
	exports.log = log;
	const events_1$1 = __require("events");
	const process$1 = __importStar(__require("process"));
	const util = __importStar(__require("util"));
	const colours_1 = require_colours();
	/**
	* This module defines an ad-hoc debug logger for Google Cloud Platform
	* client libraries in Node. An ad-hoc debug logger is a tool which lets
	* users use an external, unified interface (in this case, environment
	* variables) to determine what logging they want to see at runtime. This
	* isn't necessarily fed into the console, but is meant to be under the
	* control of the user. The kind of logging that will be produced by this
	* is more like "call retry happened", not "events you'd want to record
	* in Cloud Logger".
	*
	* More for Googlers implementing libraries with it:
	* go/cloud-client-logging-design
	*/
	/**
	* Possible log levels. These are a subset of Cloud Observability levels.
	* https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
	*/
	var LogSeverity;
	(function(LogSeverity) {
		LogSeverity["DEFAULT"] = "DEFAULT";
		LogSeverity["DEBUG"] = "DEBUG";
		LogSeverity["INFO"] = "INFO";
		LogSeverity["WARNING"] = "WARNING";
		LogSeverity["ERROR"] = "ERROR";
	})(LogSeverity || (exports.LogSeverity = LogSeverity = {}));
	/**
	* Our logger instance. This actually contains the meat of dealing
	* with log lines, including EventEmitter. This contains the function
	* that will be passed back to users of the package.
	*/
	var AdhocDebugLogger = class extends events_1$1.EventEmitter {
		/**
		* @param upstream The backend will pass a function that will be
		*   called whenever our logger function is invoked.
		*/
		constructor(namespace, upstream) {
			super();
			this.namespace = namespace;
			this.upstream = upstream;
			this.func = Object.assign(this.invoke.bind(this), {
				instance: this,
				on: (event, listener) => this.on(event, listener)
			});
			this.func.debug = (...args) => this.invokeSeverity(LogSeverity.DEBUG, ...args);
			this.func.info = (...args) => this.invokeSeverity(LogSeverity.INFO, ...args);
			this.func.warn = (...args) => this.invokeSeverity(LogSeverity.WARNING, ...args);
			this.func.error = (...args) => this.invokeSeverity(LogSeverity.ERROR, ...args);
			this.func.sublog = (namespace) => log(namespace, this.func);
		}
		invoke(fields, ...args) {
			if (this.upstream) {try {
				this.upstream(fields, ...args);
			} catch (e) {}}
			try {
				this.emit("log", fields, args);
			} catch (e) {}
		}
		invokeSeverity(severity, ...args) {
			this.invoke({ severity }, ...args);
		}
	};
	exports.AdhocDebugLogger = AdhocDebugLogger;
	/**
	* This can be used in place of a real logger while waiting for Promises or disabling logging.
	*/
	exports.placeholder = new AdhocDebugLogger("", () => {}).func;
	/**
	* The base class for debug logging backends. It's possible to use this, but the
	* same non-guarantees above still apply (unstable interface, etc).
	*
	* @private
	* @internal
	*/
	var DebugLogBackendBase = class {
		constructor() {
			var _a;
			this.cached = /* @__PURE__ */ new Map();
			this.filters = [];
			this.filtersSet = false;
			let nodeFlag = (_a = process$1.env[exports.env.nodeEnables]) !== null && _a !== void 0 ? _a : "*";
			if (nodeFlag === "all") {nodeFlag = "*";}
			this.filters = nodeFlag.split(",");
		}
		log(namespace, fields, ...args) {
			try {
				if (!this.filtersSet) {
					this.setFilters();
					this.filtersSet = true;
				}
				let logger = this.cached.get(namespace);
				if (!logger) {
					logger = this.makeLogger(namespace);
					this.cached.set(namespace, logger);
				}
				logger(fields, ...args);
			} catch (e) {
				console.error(e);
			}
		}
	};
	exports.DebugLogBackendBase = DebugLogBackendBase;
	var NodeBackend = class extends DebugLogBackendBase {
		constructor() {
			super(...arguments);
			this.enabledRegexp = /.*/g;
		}
		isEnabled(namespace) {
			return this.enabledRegexp.test(namespace);
		}
		makeLogger(namespace) {
			if (!this.enabledRegexp.test(namespace)) {return () => {};}
			return (fields, ...args) => {
				var _a;
				const nscolour = `${colours_1.Colours.green}${namespace}${colours_1.Colours.reset}`;
				const pid = `${colours_1.Colours.yellow}${process$1.pid}${colours_1.Colours.reset}`;
				let level;
				switch (fields.severity) {
					case LogSeverity.ERROR:
						level = `${colours_1.Colours.red}${fields.severity}${colours_1.Colours.reset}`;
						break;
					case LogSeverity.INFO:
						level = `${colours_1.Colours.magenta}${fields.severity}${colours_1.Colours.reset}`;
						break;
					case LogSeverity.WARNING:
						level = `${colours_1.Colours.yellow}${fields.severity}${colours_1.Colours.reset}`;
						break;
					default:
						level = (_a = fields.severity) !== null && _a !== void 0 ? _a : LogSeverity.DEFAULT;
						break;
				}
				const msg = util.formatWithOptions({ colors: colours_1.Colours.enabled }, ...args);
				const filteredFields = Object.assign({}, fields);
				delete filteredFields.severity;
				const fieldsJson = Object.getOwnPropertyNames(filteredFields).length ? JSON.stringify(filteredFields) : "";
				const fieldsColour = fieldsJson ? `${colours_1.Colours.grey}${fieldsJson}${colours_1.Colours.reset}` : "";
				console.error("%s [%s|%s] %s%s", pid, nscolour, level, msg, fieldsJson ? ` ${fieldsColour}` : "");
			};
		}
		setFilters() {
			const regexp = this.filters.join(",").replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replace(/\*/g, ".*").replace(/,/g, "$|^");
			this.enabledRegexp = new RegExp(`^${regexp}$`, "i");
		}
	};
	/**
	* @returns A backend based on Node util.debuglog; this is the default.
	*/
	function getNodeBackend() {
		return new NodeBackend();
	}
	var DebugBackend = class extends DebugLogBackendBase {
		constructor(pkg) {
			super();
			this.debugPkg = pkg;
		}
		makeLogger(namespace) {
			const debugLogger = this.debugPkg(namespace);
			return (fields, ...args) => {
				debugLogger(args[0], ...args.slice(1));
			};
		}
		setFilters() {
			var _a;
			const existingFilters = (_a = process$1.env["NODE_DEBUG"]) !== null && _a !== void 0 ? _a : "";
			process$1.env["NODE_DEBUG"] = `${existingFilters}${existingFilters ? "," : ""}${this.filters.join(",")}`;
		}
	};
	/**
	* Creates a "debug" package backend. The user must call require('debug') and pass
	* the resulting object to this function.
	*
	* ```
	*  setBackend(getDebugBackend(require('debug')))
	* ```
	*
	* https://www.npmjs.com/package/debug
	*
	* Note: Google does not explicitly endorse or recommend this package; it's just
	* being provided as an option.
	*
	* @returns A backend based on the npm "debug" package.
	*/
	function getDebugBackend(debugPkg) {
		return new DebugBackend(debugPkg);
	}
	/**
	* This pretty much works like the Node logger, but it outputs structured
	* logging JSON matching Google Cloud's ingestion specs. Rather than handling
	* its own output, it wraps another backend. The passed backend must be a subclass
	* of `DebugLogBackendBase` (any of the backends exposed by this package will work).
	*/
	var StructuredBackend = class extends DebugLogBackendBase {
		constructor(upstream) {
			var _a;
			super();
			this.upstream = (_a = upstream) !== null && _a !== void 0 ? _a : void 0;
		}
		makeLogger(namespace) {
			var _a;
			const debugLogger = (_a = this.upstream) === null || _a === void 0 ? void 0 : _a.makeLogger(namespace);
			return (fields, ...args) => {
				var _a;
				const severity = (_a = fields.severity) !== null && _a !== void 0 ? _a : LogSeverity.INFO;
				const json = Object.assign({
					severity,
					message: util.format(...args)
				}, fields);
				const jsonString = JSON.stringify(json);
				if (debugLogger) {debugLogger(fields, jsonString);}
				else {console.log("%s", jsonString);}
			};
		}
		setFilters() {
			var _a;
			(_a = this.upstream) === null || _a === void 0 || _a.setFilters();
		}
	};
	/**
	* Creates a "structured logging" backend. This pretty much works like the
	* Node logger, but it outputs structured logging JSON matching Google
	* Cloud's ingestion specs instead of plain text.
	*
	* ```
	*  setBackend(getStructuredBackend())
	* ```
	*
	* @param upstream If you want to use something besides the Node backend to
	*   write the actual log lines into, pass that here.
	* @returns A backend based on Google Cloud structured logging.
	*/
	function getStructuredBackend(upstream) {
		return new StructuredBackend(upstream);
	}
	/**
	* The environment variables that we standardized on, for all ad-hoc logging.
	*/
	exports.env = { nodeEnables: "GOOGLE_SDK_NODE_LOGGING" };
	const loggerCache = /* @__PURE__ */ new Map();
	let cachedBackend = void 0;
	/**
	* Set the backend to use for our log output.
	* - A backend object
	* - null to disable logging
	* - undefined for "nothing yet", defaults to the Node backend
	*
	* @param backend Results from one of the get*Backend() functions.
	*/
	function setBackend(backend) {
		cachedBackend = backend;
		loggerCache.clear();
	}
	/**
	* Creates a logging function. Multiple calls to this with the same namespace
	* will produce the same logger, with the same event emitter hooks.
	*
	* Namespaces can be a simple string ("system" name), or a qualified string
	* (system:subsystem), which can be used for filtering, or for "system:*".
	*
	* @param namespace The namespace, a descriptive text string.
	* @returns A function you can call that works similar to console.log().
	*/
	function log(namespace, parent) {
		if (!cachedBackend) {
			if (!process$1.env[exports.env.nodeEnables]) {return exports.placeholder;}
		}
		if (!namespace) {return exports.placeholder;}
		if (parent) {namespace = `${parent.instance.namespace}:${namespace}`;}
		const existing = loggerCache.get(namespace);
		if (existing) {return existing.func;}
		if (cachedBackend === null) {return exports.placeholder;}
		else if (cachedBackend === void 0) {cachedBackend = getNodeBackend();}
		const logger = (() => {
			let previousBackend = void 0;
			return new AdhocDebugLogger(namespace, (fields, ...args) => {
				if (previousBackend !== cachedBackend) {
					if (cachedBackend === null) {return;}
					else if (cachedBackend === void 0) {cachedBackend = getNodeBackend();}
					previousBackend = cachedBackend;
				}
				cachedBackend === null || cachedBackend === void 0 || cachedBackend.log(namespace, fields, ...args);
			});
		})();
		loggerCache.set(namespace, logger);
		return logger.func;
	}
}));
//#endregion
//#region node_modules/.pnpm/google-logging-utils@1.1.3/node_modules/google-logging-utils/build/src/index.js
var require_src$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};}
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$4) {
		for (var p in m) {if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$4, p)) __createBinding(exports$4, m, p);}
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_logging_utils(), exports);
}));
//#endregion
//#region node_modules/.pnpm/gcp-metadata@8.1.2/node_modules/gcp-metadata/build/src/index.js
var require_src$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};}
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) {if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;}
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) {return mod;}
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) {if (k[i] !== "default") __createBinding(result, mod, k[i]);}
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	var __exportStar = exports && exports.__exportStar || function(m, exports$3) {
		for (var p in m) {if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$3, p)) __createBinding(exports$3, m, p);}
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.gcpResidencyCache = exports.METADATA_SERVER_DETECTION = exports.HEADERS = exports.HEADER_VALUE = exports.HEADER_NAME = exports.SECONDARY_HOST_ADDRESS = exports.HOST_ADDRESS = exports.BASE_PATH = void 0;
	exports.instance = instance;
	exports.project = project;
	exports.universe = universe;
	exports.bulk = bulk;
	exports.isAvailable = isAvailable;
	exports.resetIsAvailableCache = resetIsAvailableCache;
	exports.getGCPResidency = getGCPResidency;
	exports.setGCPResidency = setGCPResidency;
	exports.requestTimeout = requestTimeout;
	/**
	* Copyright 2018 Google LLC
	*
	* Licensed under the Apache License, Version 2.0 (the "License");
	* you may not use this file except in compliance with the License.
	* You may obtain a copy of the License at
	*
	*      http://www.apache.org/licenses/LICENSE-2.0
	*
	* Unless required by applicable law or agreed to in writing, software
	* distributed under the License is distributed on an "AS IS" BASIS,
	* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	* See the License for the specific language governing permissions and
	* limitations under the License.
	*/
	const gaxios_1$14 = __require("gaxios");
	const jsonBigint = require_json_bigint();
	const gcp_residency_1 = require_gcp_residency();
	const logger = __importStar(require_src$2());
	exports.BASE_PATH = "/computeMetadata/v1";
	exports.HOST_ADDRESS = "http://169.254.169.254";
	exports.SECONDARY_HOST_ADDRESS = "http://metadata.google.internal.";
	exports.HEADER_NAME = "Metadata-Flavor";
	exports.HEADER_VALUE = "Google";
	exports.HEADERS = Object.freeze({ [exports.HEADER_NAME]: exports.HEADER_VALUE });
	const log = logger.log("gcp-metadata");
	/**
	* Metadata server detection override options.
	*
	* Available via `process.env.METADATA_SERVER_DETECTION`.
	*/
	exports.METADATA_SERVER_DETECTION = Object.freeze({
		"assume-present": "don't try to ping the metadata server, but assume it's present",
		none: "don't try to ping the metadata server, but don't try to use it either",
		"bios-only": "treat the result of a BIOS probe as canonical (don't fall back to pinging)",
		"ping-only": "skip the BIOS probe, and go straight to pinging"
	});
	/**
	* Returns the base URL while taking into account the GCE_METADATA_HOST
	* environment variable if it exists.
	*
	* @returns The base URL, e.g., http://169.254.169.254/computeMetadata/v1.
	*/
	function getBaseUrl(baseUrl) {
		if (!baseUrl) {baseUrl = process.env.GCE_METADATA_IP || process.env.GCE_METADATA_HOST || exports.HOST_ADDRESS;}
		if (!/^https?:\/\//.test(baseUrl)) {baseUrl = `http://${baseUrl}`;}
		return new URL(exports.BASE_PATH, baseUrl).href;
	}
	function validate(options) {
		Object.keys(options).forEach((key) => {
			switch (key) {
				case "params":
				case "property":
				case "headers": break;
				case "qs": throw new Error("'qs' is not a valid configuration option. Please use 'params' instead.");
				default: throw new Error(`'${key}' is not a valid configuration option.`);
			}
		});
	}
	async function metadataAccessor(type, options = {}, noResponseRetries = 3, fastFail = false) {
		const headers = new Headers(exports.HEADERS);
		let metadataKey = "";
		let params = {};
		if (typeof type === "object") {
			const metadataAccessor = type;
			new Headers(metadataAccessor.headers).forEach((value, key) => headers.set(key, value));
			metadataKey = metadataAccessor.metadataKey;
			params = metadataAccessor.params || params;
			noResponseRetries = metadataAccessor.noResponseRetries || noResponseRetries;
			fastFail = metadataAccessor.fastFail || fastFail;
		} else {metadataKey = type;}
		if (typeof options === "string") {metadataKey += `/${options}`;}
		else {
			validate(options);
			if (options.property) {metadataKey += `/${options.property}`;}
			new Headers(options.headers).forEach((value, key) => headers.set(key, value));
			params = options.params || params;
		}
		const requestMethod = fastFail ? fastFailMetadataRequest : gaxios_1$14.request;
		const req = {
			url: `${getBaseUrl()}/${metadataKey}`,
			headers,
			retryConfig: { noResponseRetries },
			params,
			responseType: "text",
			timeout: requestTimeout()
		};
		log.info("instance request %j", req);
		const res = await requestMethod(req);
		log.info("instance metadata is %s", res.data);
		const metadataFlavor = res.headers.get(exports.HEADER_NAME);
		if (metadataFlavor !== exports.HEADER_VALUE) {throw new RangeError(`Invalid response from metadata service: incorrect ${exports.HEADER_NAME} header. Expected '${exports.HEADER_VALUE}', got ${metadataFlavor ? `'${metadataFlavor}'` : "no header"}`);}
		if (typeof res.data === "string") {try {
			return jsonBigint.parse(res.data);
		} catch {}}
		return res.data;
	}
	async function fastFailMetadataRequest(options) {
		const secondaryOptions = {
			...options,
			url: options.url?.toString().replace(getBaseUrl(), getBaseUrl(exports.SECONDARY_HOST_ADDRESS))
		};
		const r1 = (0, gaxios_1$14.request)(options);
		const r2 = (0, gaxios_1$14.request)(secondaryOptions);
		return Promise.any([r1, r2]);
	}
	/**
	* Obtain metadata for the current GCE instance.
	*
	* @see {@link https://cloud.google.com/compute/docs/metadata/predefined-metadata-keys}
	*
	* @example
	* ```
	* const serviceAccount: {} = await instance('service-accounts/');
	* const serviceAccountEmail: string = await instance('service-accounts/default/email');
	* ```
	*/
	function instance(options) {
		return metadataAccessor("instance", options);
	}
	/**
	* Obtain metadata for the current GCP project.
	*
	* @see {@link https://cloud.google.com/compute/docs/metadata/predefined-metadata-keys}
	*
	* @example
	* ```
	* const projectId: string = await project('project-id');
	* const numericProjectId: number = await project('numeric-project-id');
	* ```
	*/
	function project(options) {
		return metadataAccessor("project", options);
	}
	/**
	* Obtain metadata for the current universe.
	*
	* @see {@link https://cloud.google.com/compute/docs/metadata/predefined-metadata-keys}
	*
	* @example
	* ```
	* const universeDomain: string = await universe('universe-domain');
	* ```
	*/
	function universe(options) {
		return metadataAccessor("universe", options);
	}
	/**
	* Retrieve metadata items in parallel.
	*
	* @see {@link https://cloud.google.com/compute/docs/metadata/predefined-metadata-keys}
	*
	* @example
	* ```
	* const data = await bulk([
	*   {
	*     metadataKey: 'instance',
	*   },
	*   {
	*     metadataKey: 'project/project-id',
	*   },
	* ] as const);
	*
	* // data.instance;
	* // data['project/project-id'];
	* ```
	*
	* @param properties The metadata properties to retrieve
	* @returns The metadata in `metadatakey:value` format
	*/
	async function bulk(properties) {
		const r = {};
		await Promise.all(properties.map((item) => {
			return (async () => {
				const res = await metadataAccessor(item);
				const key = item.metadataKey;
				r[key] = res;
			})();
		}));
		return r;
	}
	function detectGCPAvailableRetries() {
		return process.env.DETECT_GCP_RETRIES ? Number(process.env.DETECT_GCP_RETRIES) : 0;
	}
	let cachedIsAvailableResponse;
	/**
	* Determine if the metadata server is currently available.
	*/
	async function isAvailable() {
		if (process.env.METADATA_SERVER_DETECTION) {
			const value = process.env.METADATA_SERVER_DETECTION.trim().toLocaleLowerCase();
			if (!(value in exports.METADATA_SERVER_DETECTION)) {throw new RangeError(`Unknown \`METADATA_SERVER_DETECTION\` env variable. Got \`${value}\`, but it should be \`${Object.keys(exports.METADATA_SERVER_DETECTION).join("`, `")}\`, or unset`);}
			switch (value) {
				case "assume-present": return true;
				case "none": return false;
				case "bios-only": return getGCPResidency();
				case "ping-only":
			}
		}
		try {
			if (cachedIsAvailableResponse === void 0) {cachedIsAvailableResponse = metadataAccessor("instance", void 0, detectGCPAvailableRetries(), !(process.env.GCE_METADATA_IP || process.env.GCE_METADATA_HOST));}
			await cachedIsAvailableResponse;
			return true;
		} catch (e) {
			const err = e;
			if (process.env.DEBUG_AUTH) {console.info(err);}
			if (err.type === "request-timeout") {return false;}
			if (err.response && err.response.status === 404) {return false;}
			else {
				if (!(err.response && err.response.status === 404) && (!err.code || ![
					"EHOSTDOWN",
					"EHOSTUNREACH",
					"ENETUNREACH",
					"ENOENT",
					"ENOTFOUND",
					"ECONNREFUSED"
				].includes(err.code.toString()))) {
					let code = "UNKNOWN";
					if (err.code) {code = err.code.toString();}
					process.emitWarning(`received unexpected error = ${err.message} code = ${code}`, "MetadataLookupWarning");
				}
				return false;
			}
		}
	}
	/**
	* reset the memoized isAvailable() lookup.
	*/
	function resetIsAvailableCache() {
		cachedIsAvailableResponse = void 0;
	}
	/**
	* A cache for the detected GCP Residency.
	*/
	exports.gcpResidencyCache = null;
	/**
	* Detects GCP Residency.
	* Caches results to reduce costs for subsequent calls.
	*
	* @see setGCPResidency for setting
	*/
	function getGCPResidency() {
		if (exports.gcpResidencyCache === null) {setGCPResidency();}
		return exports.gcpResidencyCache;
	}
	/**
	* Sets the detected GCP Residency.
	* Useful for forcing metadata server detection behavior.
	*
	* Set `null` to autodetect the environment (default behavior).
	* @see getGCPResidency for getting
	*/
	function setGCPResidency(value = null) {
		exports.gcpResidencyCache = value !== null ? value : (0, gcp_residency_1.detectGCPResidency)();
	}
	/**
	* Obtain the timeout for requests to the metadata server.
	*
	* In certain environments and conditions requests can take longer than
	* the default timeout to complete. This function will determine the
	* appropriate timeout based on the environment.
	*
	* @returns {number} a request timeout duration in milliseconds.
	*/
	function requestTimeout() {
		return getGCPResidency() ? 0 : 3e3;
	}
	__exportStar(require_gcp_residency(), exports);
}));
//#endregion
//#region node_modules/.pnpm/base64-js@1.5.1/node_modules/base64-js/index.js
var require_base64_js = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.byteLength = byteLength;
	exports.toByteArray = toByteArray;
	exports.fromByteArray = fromByteArray;
	var lookup = [];
	var revLookup = [];
	var Arr = typeof Uint8Array !== "undefined" ? Uint8Array : Array;
	var code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	for (var i = 0, len = code.length; i < len; ++i) {
		lookup[i] = code[i];
		revLookup[code.charCodeAt(i)] = i;
	}
	revLookup["-".charCodeAt(0)] = 62;
	revLookup["_".charCodeAt(0)] = 63;
	function getLens(b64) {
		var len = b64.length;
		if (len % 4 > 0) {throw new Error("Invalid string. Length must be a multiple of 4");}
		var validLen = b64.indexOf("=");
		if (validLen === -1) {validLen = len;}
		var placeHoldersLen = validLen === len ? 0 : 4 - validLen % 4;
		return [validLen, placeHoldersLen];
	}
	function byteLength(b64) {
		var lens = getLens(b64);
		var validLen = lens[0];
		var placeHoldersLen = lens[1];
		return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
	}
	function _byteLength(b64, validLen, placeHoldersLen) {
		return (validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen;
	}
	function toByteArray(b64) {
		var tmp;
		var lens = getLens(b64);
		var validLen = lens[0];
		var placeHoldersLen = lens[1];
		var arr = new Arr(_byteLength(b64, validLen, placeHoldersLen));
		var curByte = 0;
		var len = placeHoldersLen > 0 ? validLen - 4 : validLen;
		var i;
		for (i = 0; i < len; i += 4) {
			tmp = revLookup[b64.charCodeAt(i)] << 18 | revLookup[b64.charCodeAt(i + 1)] << 12 | revLookup[b64.charCodeAt(i + 2)] << 6 | revLookup[b64.charCodeAt(i + 3)];
			arr[curByte++] = tmp >> 16 & 255;
			arr[curByte++] = tmp >> 8 & 255;
			arr[curByte++] = tmp & 255;
		}
		if (placeHoldersLen === 2) {
			tmp = revLookup[b64.charCodeAt(i)] << 2 | revLookup[b64.charCodeAt(i + 1)] >> 4;
			arr[curByte++] = tmp & 255;
		}
		if (placeHoldersLen === 1) {
			tmp = revLookup[b64.charCodeAt(i)] << 10 | revLookup[b64.charCodeAt(i + 1)] << 4 | revLookup[b64.charCodeAt(i + 2)] >> 2;
			arr[curByte++] = tmp >> 8 & 255;
			arr[curByte++] = tmp & 255;
		}
		return arr;
	}
	function tripletToBase64(num) {
		return lookup[num >> 18 & 63] + lookup[num >> 12 & 63] + lookup[num >> 6 & 63] + lookup[num & 63];
	}
	function encodeChunk(uint8, start, end) {
		var tmp;
		var output = [];
		for (var i = start; i < end; i += 3) {
			tmp = (uint8[i] << 16 & 16711680) + (uint8[i + 1] << 8 & 65280) + (uint8[i + 2] & 255);
			output.push(tripletToBase64(tmp));
		}
		return output.join("");
	}
	function fromByteArray(uint8) {
		var tmp;
		var len = uint8.length;
		var extraBytes = len % 3;
		var parts = [];
		var maxChunkLength = 16383;
		for (var i = 0, len2 = len - extraBytes; i < len2; i += maxChunkLength) {parts.push(encodeChunk(uint8, i, i + maxChunkLength > len2 ? len2 : i + maxChunkLength));}
		if (extraBytes === 1) {
			tmp = uint8[len - 1];
			parts.push(lookup[tmp >> 2] + lookup[tmp << 4 & 63] + "==");
		} else if (extraBytes === 2) {
			tmp = (uint8[len - 2] << 8) + uint8[len - 1];
			parts.push(lookup[tmp >> 10] + lookup[tmp >> 4 & 63] + lookup[tmp << 2 & 63] + "=");
		}
		return parts.join("");
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/crypto/shared.js
var require_shared$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.fromArrayBufferToHex = fromArrayBufferToHex;
	/**
	* Converts an ArrayBuffer to a hexadecimal string.
	* @param arrayBuffer The ArrayBuffer to convert to hexadecimal string.
	* @return The hexadecimal encoding of the ArrayBuffer.
	*/
	function fromArrayBufferToHex(arrayBuffer) {
		return Array.from(new Uint8Array(arrayBuffer)).map((byte) => {
			return byte.toString(16).padStart(2, "0");
		}).join("");
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/crypto/browser/crypto.js
var require_crypto$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.BrowserCrypto = void 0;
	const base64js = require_base64_js();
	const shared_1 = require_shared$1();
	exports.BrowserCrypto = class BrowserCrypto {
		constructor() {
			if (typeof window === "undefined" || window.crypto === void 0 || window.crypto.subtle === void 0) {throw new Error("SubtleCrypto not found. Make sure it's an https:// website.");}
		}
		async sha256DigestBase64(str) {
			const inputBuffer = new TextEncoder().encode(str);
			const outputBuffer = await window.crypto.subtle.digest("SHA-256", inputBuffer);
			return base64js.fromByteArray(new Uint8Array(outputBuffer));
		}
		randomBytesBase64(count) {
			const array = new Uint8Array(count);
			window.crypto.getRandomValues(array);
			return base64js.fromByteArray(array);
		}
		static padBase64(base64) {
			while (base64.length % 4 !== 0) {base64 += "=";}
			return base64;
		}
		async verify(pubkey, data, signature) {
			const algo = {
				name: "RSASSA-PKCS1-v1_5",
				hash: { name: "SHA-256" }
			};
			const dataArray = new TextEncoder().encode(data);
			const signatureArray = base64js.toByteArray(BrowserCrypto.padBase64(signature));
			const cryptoKey = await window.crypto.subtle.importKey("jwk", pubkey, algo, true, ["verify"]);
			return await window.crypto.subtle.verify(algo, cryptoKey, Buffer.from(signatureArray), dataArray);
		}
		async sign(privateKey, data) {
			const algo = {
				name: "RSASSA-PKCS1-v1_5",
				hash: { name: "SHA-256" }
			};
			const dataArray = new TextEncoder().encode(data);
			const cryptoKey = await window.crypto.subtle.importKey("jwk", privateKey, algo, true, ["sign"]);
			const result = await window.crypto.subtle.sign(algo, cryptoKey, dataArray);
			return base64js.fromByteArray(new Uint8Array(result));
		}
		decodeBase64StringUtf8(base64) {
			const uint8array = base64js.toByteArray(BrowserCrypto.padBase64(base64));
			return new TextDecoder().decode(uint8array);
		}
		encodeBase64StringUtf8(text) {
			const uint8array = new TextEncoder().encode(text);
			return base64js.fromByteArray(uint8array);
		}
		/**
		* Computes the SHA-256 hash of the provided string.
		* @param str The plain text string to hash.
		* @return A promise that resolves with the SHA-256 hash of the provided
		*   string in hexadecimal encoding.
		*/
		async sha256DigestHex(str) {
			const inputBuffer = new TextEncoder().encode(str);
			const outputBuffer = await window.crypto.subtle.digest("SHA-256", inputBuffer);
			return (0, shared_1.fromArrayBufferToHex)(outputBuffer);
		}
		/**
		* Computes the HMAC hash of a message using the provided crypto key and the
		* SHA-256 algorithm.
		* @param key The secret crypto key in utf-8 or ArrayBuffer format.
		* @param msg The plain text message.
		* @return A promise that resolves with the HMAC-SHA256 hash in ArrayBuffer
		*   format.
		*/
		async signWithHmacSha256(key, msg) {
			const rawKey = typeof key === "string" ? key : String.fromCharCode(...new Uint16Array(key));
			const enc = new TextEncoder();
			const cryptoKey = await window.crypto.subtle.importKey("raw", enc.encode(rawKey), {
				name: "HMAC",
				hash: { name: "SHA-256" }
			}, false, ["sign"]);
			return window.crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/crypto/node/crypto.js
var require_crypto$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.NodeCrypto = void 0;
	const crypto$1 = __require("crypto");
	var NodeCrypto = class {
		async sha256DigestBase64(str) {
			return crypto$1.createHash("sha256").update(str).digest("base64");
		}
		randomBytesBase64(count) {
			return crypto$1.randomBytes(count).toString("base64");
		}
		async verify(pubkey, data, signature) {
			const verifier = crypto$1.createVerify("RSA-SHA256");
			verifier.update(data);
			verifier.end();
			return verifier.verify(pubkey, signature, "base64");
		}
		async sign(privateKey, data) {
			const signer = crypto$1.createSign("RSA-SHA256");
			signer.update(data);
			signer.end();
			return signer.sign(privateKey, "base64");
		}
		decodeBase64StringUtf8(base64) {
			return Buffer.from(base64, "base64").toString("utf-8");
		}
		encodeBase64StringUtf8(text) {
			return Buffer.from(text, "utf-8").toString("base64");
		}
		/**
		* Computes the SHA-256 hash of the provided string.
		* @param str The plain text string to hash.
		* @return A promise that resolves with the SHA-256 hash of the provided
		*   string in hexadecimal encoding.
		*/
		async sha256DigestHex(str) {
			return crypto$1.createHash("sha256").update(str).digest("hex");
		}
		/**
		* Computes the HMAC hash of a message using the provided crypto key and the
		* SHA-256 algorithm.
		* @param key The secret crypto key in utf-8 or ArrayBuffer format.
		* @param msg The plain text message.
		* @return A promise that resolves with the HMAC-SHA256 hash in ArrayBuffer
		*   format.
		*/
		async signWithHmacSha256(key, msg) {
			const cryptoKey = typeof key === "string" ? key : toBuffer(key);
			return toArrayBuffer(crypto$1.createHmac("sha256", cryptoKey).update(msg).digest());
		}
	};
	exports.NodeCrypto = NodeCrypto;
	/**
	* Converts a Node.js Buffer to an ArrayBuffer.
	* https://stackoverflow.com/questions/8609289/convert-a-binary-nodejs-buffer-to-javascript-arraybuffer
	* @param buffer The Buffer input to covert.
	* @return The ArrayBuffer representation of the input.
	*/
	function toArrayBuffer(buffer) {
		const ab = new ArrayBuffer(buffer.length);
		const view = new Uint8Array(ab);
		for (let i = 0; i < buffer.length; ++i) {view[i] = buffer[i];}
		return ab;
	}
	/**
	* Converts an ArrayBuffer to a Node.js Buffer.
	* @param arrayBuffer The ArrayBuffer input to covert.
	* @return The Buffer representation of the input.
	*/
	function toBuffer(arrayBuffer) {
		return Buffer.from(arrayBuffer);
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/crypto/crypto.js
var require_crypto = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};}
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$2) {
		for (var p in m) {if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$2, p)) __createBinding(exports$2, m, p);}
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.createCrypto = createCrypto;
	exports.hasBrowserCrypto = hasBrowserCrypto;
	const crypto_1 = require_crypto$2();
	const crypto_2 = require_crypto$1();
	__exportStar(require_shared$1(), exports);
	function createCrypto() {
		if (hasBrowserCrypto()) {return new crypto_1.BrowserCrypto();}
		return new crypto_2.NodeCrypto();
	}
	function hasBrowserCrypto() {
		return typeof window !== "undefined" && typeof window.crypto !== "undefined" && typeof window.crypto.subtle !== "undefined";
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/util.js
var require_util = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.LRUCache = void 0;
	exports.snakeToCamel = snakeToCamel;
	exports.originalOrCamelOptions = originalOrCamelOptions;
	exports.removeUndefinedValuesInObject = removeUndefinedValuesInObject;
	exports.isValidFile = isValidFile;
	exports.getWellKnownCertificateConfigFileLocation = getWellKnownCertificateConfigFileLocation;
	const fs$5 = __require("fs");
	const os$1 = __require("os");
	const path$2 = __require("path");
	const WELL_KNOWN_CERTIFICATE_CONFIG_FILE = "certificate_config.json";
	const CLOUDSDK_CONFIG_DIRECTORY = "gcloud";
	/**
	* Returns the camel case of a provided string.
	*
	* @remarks
	*
	* Match any `_` and not `_` pair, then return the uppercase of the not `_`
	* character.
	*
	* @param str the string to convert
	* @returns the camelCase'd string
	*/
	function snakeToCamel(str) {
		return str.replace(/([_][^_])/g, (match) => match.slice(1).toUpperCase());
	}
	/**
	* Get the value of `obj[key]` or `obj[camelCaseKey]`, with a preference
	* for original, non-camelCase key.
	*
	* @param obj object to lookup a value in
	* @returns a `get` function for getting `obj[key || snakeKey]`, if available
	*/
	function originalOrCamelOptions(obj) {
		/**
		*
		* @param key an index of object, preferably snake_case
		* @returns the value `obj[key || snakeKey]`, if available
		*/
		function get(key) {
			const o = obj || {};
			return o[key] ?? o[snakeToCamel(key)];
		}
		return { get };
	}
	/**
	* A simple LRU cache utility.
	* Not meant for external usage.
	*
	* @experimental
	*/
	var LRUCache = class {
		capacity;
		/**
		* Maps are in order. Thus, the older item is the first item.
		*
		* {@link https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map}
		*/
		#cache = /* @__PURE__ */ new Map();
		maxAge;
		constructor(options) {
			this.capacity = options.capacity;
			this.maxAge = options.maxAge;
		}
		/**
		* Moves the key to the end of the cache.
		*
		* @param key the key to move
		* @param value the value of the key
		*/
		#moveToEnd(key, value) {
			this.#cache.delete(key);
			this.#cache.set(key, {
				value,
				lastAccessed: Date.now()
			});
		}
		/**
		* Add an item to the cache.
		*
		* @param key the key to upsert
		* @param value the value of the key
		*/
		set(key, value) {
			this.#moveToEnd(key, value);
			this.#evict();
		}
		/**
		* Get an item from the cache.
		*
		* @param key the key to retrieve
		*/
		get(key) {
			const item = this.#cache.get(key);
			if (!item) {return;}
			this.#moveToEnd(key, item.value);
			this.#evict();
			return item.value;
		}
		/**
		* Maintain the cache based on capacity and TTL.
		*/
		#evict() {
			const cutoffDate = this.maxAge ? Date.now() - this.maxAge : 0;
			/**
			* Because we know Maps are in order, this item is both the
			* last item in the list (capacity) and oldest (maxAge).
			*/
			let oldestItem = this.#cache.entries().next();
			while (!oldestItem.done && (this.#cache.size > this.capacity || oldestItem.value[1].lastAccessed < cutoffDate)) {
				this.#cache.delete(oldestItem.value[0]);
				oldestItem = this.#cache.entries().next();
			}
		}
	};
	exports.LRUCache = LRUCache;
	function removeUndefinedValuesInObject(object) {
		Object.entries(object).forEach(([key, value]) => {
			if (value === void 0 || value === "undefined") {delete object[key];}
		});
		return object;
	}
	/**
	* Helper to check if a path points to a valid file.
	*/
	async function isValidFile(filePath) {
		try {
			return (await fs$5.promises.lstat(filePath)).isFile();
		} catch (e) {
			return false;
		}
	}
	/**
	* Determines the well-known gcloud location for the certificate config file.
	* @returns The platform-specific path to the configuration file.
	* @internal
	*/
	function getWellKnownCertificateConfigFileLocation() {
		const configDir = process.env.CLOUDSDK_CONFIG || (_isWindows() ? path$2.join(process.env.APPDATA || "", CLOUDSDK_CONFIG_DIRECTORY) : path$2.join(process.env.HOME || "", ".config", CLOUDSDK_CONFIG_DIRECTORY));
		return path$2.join(configDir, WELL_KNOWN_CERTIFICATE_CONFIG_FILE);
	}
	/**
	* Checks if the current operating system is Windows.
	* @returns True if the OS is Windows, false otherwise.
	* @internal
	*/
	function _isWindows() {
		return os$1.platform().startsWith("win");
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/package.json
var require_package = /* @__PURE__ */ __commonJSMin(((exports, module) => {
	module.exports = {
		"name": "google-auth-library",
		"version": "10.6.1",
		"author": "Google Inc.",
		"description": "Google APIs Authentication Client Library for Node.js",
		"engines": { "node": ">=18" },
		"main": "./build/src/index.js",
		"types": "./build/src/index.d.ts",
		"repository": {
			"type": "git",
			"directory": "packages/google-auth-library-nodejs",
			"url": "https://github.com/googleapis/google-cloud-node-core.git"
		},
		"keywords": [
			"google",
			"api",
			"google apis",
			"client",
			"client library"
		],
		"dependencies": {
			"base64-js": "^1.3.0",
			"ecdsa-sig-formatter": "^1.0.11",
			"gaxios": "7.1.3",
			"gcp-metadata": "8.1.2",
			"google-logging-utils": "1.1.3",
			"jws": "^4.0.0"
		},
		"devDependencies": {
			"@types/base64-js": "^1.2.5",
			"@types/jws": "^3.1.0",
			"@types/mocha": "^10.0.10",
			"@types/mv": "^2.1.0",
			"@types/ncp": "^2.0.8",
			"@types/node": "^24.0.0",
			"@types/sinon": "^21.0.0",
			"assert-rejects": "^1.0.0",
			"c8": "^10.1.3",
			"codecov": "^3.8.3",
			"gts": "^6.0.2",
			"is-docker": "^3.0.0",
			"jsdoc": "^4.0.4",
			"jsdoc-fresh": "^5.0.0",
			"jsdoc-region-tag": "^4.0.0",
			"karma": "^6.0.0",
			"karma-chrome-launcher": "^3.0.0",
			"karma-coverage": "^2.0.0",
			"karma-firefox-launcher": "^2.0.0",
			"karma-mocha": "^2.0.0",
			"karma-sourcemap-loader": "^0.4.0",
			"karma-webpack": "^5.0.1",
			"keypair": "^1.0.4",
			"mocha": "^11.1.0",
			"mv": "^2.1.1",
			"ncp": "^2.0.0",
			"nock": "^14.0.5",
			"null-loader": "^4.0.1",
			"puppeteer": "^24.0.0",
			"sinon": "^21.0.0",
			"ts-loader": "^9.5.2",
			"typescript": "5.8.3",
			"webpack": "^5.97.1",
			"webpack-cli": "^6.0.1"
		},
		"files": ["build/src", "!build/src/**/*.map"],
		"scripts": {
			"test": "c8 mocha build/test",
			"clean": "gts clean",
			"prepare": "npm run compile",
			"lint": "gts check --no-inline-config",
			"compile": "tsc -p .",
			"fix": "gts fix",
			"pretest": "npm run compile -- --sourceMap",
			"docs": "jsdoc -c .jsdoc.js",
			"samples-setup": "cd samples/ && npm link ../ && npm run setup && cd ../",
			"samples-test": "cd samples/ && npm link ../ && npm test && cd ../",
			"system-test": "mocha build/system-test --timeout 60000",
			"presystem-test": "npm run compile -- --sourceMap",
			"webpack": "webpack",
			"browser-test": "karma start",
			"docs-test": "echo 'disabled until linkinator is fixed'",
			"predocs-test": "npm run docs",
			"prelint": "cd samples; npm link ../; npm install"
		},
		"license": "Apache-2.0",
		"homepage": "https://github.com/googleapis/google-cloud-node-core/tree/main/packages/google-auth-library-nodejs"
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/shared.cjs
var require_shared = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.USER_AGENT = exports.PRODUCT_NAME = exports.pkg = void 0;
	const pkg = require_package();
	exports.pkg = pkg;
	const PRODUCT_NAME = "google-api-nodejs-client";
	exports.PRODUCT_NAME = PRODUCT_NAME;
	exports.USER_AGENT = `${PRODUCT_NAME}/${pkg.version}`;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/authclient.js
var require_authclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.AuthClient = exports.DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS = exports.DEFAULT_UNIVERSE = void 0;
	const events_1 = __require("events");
	const gaxios_1$13 = __require("gaxios");
	const util_1 = require_util();
	const google_logging_utils_1 = require_src$2();
	const shared_cjs_1 = require_shared();
	/**
	* The default cloud universe
	*
	* @see {@link AuthJSONOptions.universe_domain}
	*/
	exports.DEFAULT_UNIVERSE = "googleapis.com";
	/**
	* The default {@link AuthClientOptions.eagerRefreshThresholdMillis}
	*/
	exports.DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS = 300 * 1e3;
	exports.AuthClient = class AuthClient extends events_1.EventEmitter {
		apiKey;
		projectId;
		/**
		* The quota project ID. The quota project can be used by client libraries for the billing purpose.
		* See {@link https://cloud.google.com/docs/quota Working with quotas}
		*/
		quotaProjectId;
		/**
		* The {@link Gaxios `Gaxios`} instance used for making requests.
		*/
		transporter;
		credentials = {};
		eagerRefreshThresholdMillis = exports.DEFAULT_EAGER_REFRESH_THRESHOLD_MILLIS;
		forceRefreshOnFailure = false;
		universeDomain = exports.DEFAULT_UNIVERSE;
		/**
		* Symbols that can be added to GaxiosOptions to specify the method name that is
		* making an RPC call, for logging purposes, as well as a string ID that can be
		* used to correlate calls and responses.
		*/
		static RequestMethodNameSymbol = Symbol("request method name");
		static RequestLogIdSymbol = Symbol("request log id");
		constructor(opts = {}) {
			super();
			const options = (0, util_1.originalOrCamelOptions)(opts);
			this.apiKey = opts.apiKey;
			this.projectId = options.get("project_id") ?? null;
			this.quotaProjectId = options.get("quota_project_id");
			this.credentials = options.get("credentials") ?? {};
			this.universeDomain = options.get("universe_domain") ?? exports.DEFAULT_UNIVERSE;
			this.transporter = opts.transporter ?? new gaxios_1$13.Gaxios(opts.transporterOptions);
			if (options.get("useAuthRequestParameters") !== false) {
				this.transporter.interceptors.request.add(AuthClient.DEFAULT_REQUEST_INTERCEPTOR);
				this.transporter.interceptors.response.add(AuthClient.DEFAULT_RESPONSE_INTERCEPTOR);
			}
			if (opts.eagerRefreshThresholdMillis) {this.eagerRefreshThresholdMillis = opts.eagerRefreshThresholdMillis;}
			this.forceRefreshOnFailure = opts.forceRefreshOnFailure ?? false;
		}
		/**
		* A {@link fetch `fetch`} compliant API for {@link AuthClient}.
		*
		* @see {@link AuthClient.request} for the classic method.
		*
		* @remarks
		*
		* This is useful as a drop-in replacement for `fetch` API usage.
		*
		* @example
		*
		* ```ts
		* const authClient = new AuthClient();
		* const fetchWithAuthClient: typeof fetch = (...args) => authClient.fetch(...args);
		* await fetchWithAuthClient('https://example.com');
		* ```
		*
		* @param args `fetch` API or {@link Gaxios.fetch `Gaxios#fetch`} parameters
		* @returns the {@link GaxiosResponse} with Gaxios-added properties
		*/
		fetch(...args) {
			const input = args[0];
			const init = args[1];
			let url = void 0;
			const headers = new Headers();
			if (typeof input === "string") {url = new URL(input);}
			else if (input instanceof URL) {url = input;}
			else if (input && input.url) {url = new URL(input.url);}
			if (input && typeof input === "object" && "headers" in input) {gaxios_1$13.Gaxios.mergeHeaders(headers, input.headers);}
			if (init) {gaxios_1$13.Gaxios.mergeHeaders(headers, new Headers(init.headers));}
			if (typeof input === "object" && !(input instanceof URL)) {return this.request({
				...init,
				...input,
				headers,
				url
			});}
			else {return this.request({
				...init,
				headers,
				url
			});}
		}
		/**
		* Sets the auth credentials.
		*/
		setCredentials(credentials) {
			this.credentials = credentials;
		}
		/**
		* Append additional headers, e.g., x-goog-user-project, shared across the
		* classes inheriting AuthClient. This method should be used by any method
		* that overrides getRequestMetadataAsync(), which is a shared helper for
		* setting request information in both gRPC and HTTP API calls.
		*
		* @param headers object to append additional headers to.
		*/
		addSharedMetadataHeaders(headers) {
			if (!headers.has("x-goog-user-project") && this.quotaProjectId) {headers.set("x-goog-user-project", this.quotaProjectId);}
			return headers;
		}
		/**
		* Adds the `x-goog-user-project` and `authorization` headers to the target Headers
		* object, if they exist on the source.
		*
		* @param target the headers to target
		* @param source the headers to source from
		* @returns the target headers
		*/
		addUserProjectAndAuthHeaders(target, source) {
			const xGoogUserProject = source.get("x-goog-user-project");
			const authorizationHeader = source.get("authorization");
			if (xGoogUserProject) {target.set("x-goog-user-project", xGoogUserProject);}
			if (authorizationHeader) {target.set("authorization", authorizationHeader);}
			return target;
		}
		static log = (0, google_logging_utils_1.log)("auth");
		static DEFAULT_REQUEST_INTERCEPTOR = { resolved: async (config) => {
			if (!config.headers.has("x-goog-api-client")) {
				const nodeVersion = process.version.replace(/^v/, "");
				config.headers.set("x-goog-api-client", `gl-node/${nodeVersion}`);
			}
			const userAgent = config.headers.get("User-Agent");
			if (!userAgent) {config.headers.set("User-Agent", shared_cjs_1.USER_AGENT);}
			else if (!userAgent.includes(`${shared_cjs_1.PRODUCT_NAME}/`)) {config.headers.set("User-Agent", `${userAgent} ${shared_cjs_1.USER_AGENT}`);}
			try {
				const symbols = config;
				const methodName = symbols[AuthClient.RequestMethodNameSymbol];
				const logId = `${Math.floor(Math.random() * 1e3)}`;
				symbols[AuthClient.RequestLogIdSymbol] = logId;
				const logObject = {
					url: config.url,
					headers: config.headers
				};
				if (methodName) {AuthClient.log.info("%s [%s] request %j", methodName, logId, logObject);}
				else {AuthClient.log.info("[%s] request %j", logId, logObject);}
			} catch (e) {}
			return config;
		} };
		static DEFAULT_RESPONSE_INTERCEPTOR = {
			resolved: async (response) => {
				try {
					const symbols = response.config;
					const methodName = symbols[AuthClient.RequestMethodNameSymbol];
					const logId = symbols[AuthClient.RequestLogIdSymbol];
					if (methodName) {AuthClient.log.info("%s [%s] response %j", methodName, logId, response.data);}
					else {AuthClient.log.info("[%s] response %j", logId, response.data);}
				} catch (e) {}
				return response;
			},
			rejected: async (error) => {
				try {
					const symbols = error.config;
					const methodName = symbols[AuthClient.RequestMethodNameSymbol];
					const logId = symbols[AuthClient.RequestLogIdSymbol];
					if (methodName) {AuthClient.log.info("%s [%s] error %j", methodName, logId, error.response?.data);}
					else {AuthClient.log.error("[%s] error %j", logId, error.response?.data);}
				} catch (e) {}
				throw error;
			}
		};
		/**
		* Sets the method name that is making a Gaxios request, so that logging may tag
		* log lines with the operation.
		* @param config A Gaxios request config
		* @param methodName The method name making the call
		*/
		static setMethodName(config, methodName) {
			try {
				const symbols = config;
				symbols[AuthClient.RequestMethodNameSymbol] = methodName;
			} catch (e) {}
		}
		/**
		* Retry config for Auth-related requests.
		*
		* @remarks
		*
		* This is not a part of the default {@link AuthClient.transporter transporter/gaxios}
		* config as some downstream APIs would prefer if customers explicitly enable retries,
		* such as GCS.
		*/
		static get RETRY_CONFIG() {
			return {
				retry: true,
				retryConfig: { httpMethodsToRetry: [
					"GET",
					"PUT",
					"POST",
					"HEAD",
					"OPTIONS",
					"DELETE"
				] }
			};
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/loginticket.js
var require_loginticket = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.LoginTicket = void 0;
	var LoginTicket = class {
		envelope;
		payload;
		/**
		* Create a simple class to extract user ID from an ID Token
		*
		* @param {string} env Envelope of the jwt
		* @param {TokenPayload} pay Payload of the jwt
		* @constructor
		*/
		constructor(env, pay) {
			this.envelope = env;
			this.payload = pay;
		}
		getEnvelope() {
			return this.envelope;
		}
		getPayload() {
			return this.payload;
		}
		/**
		* Create a simple class to extract user ID from an ID Token
		*
		* @return The user ID
		*/
		getUserId() {
			const payload = this.getPayload();
			if (payload && payload.sub) {return payload.sub;}
			return null;
		}
		/**
		* Returns attributes from the login ticket.  This can contain
		* various information about the user session.
		*
		* @return The envelope and payload
		*/
		getAttributes() {
			return {
				envelope: this.getEnvelope(),
				payload: this.getPayload()
			};
		}
	};
	exports.LoginTicket = LoginTicket;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/oauth2client.js
var require_oauth2client = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.OAuth2Client = exports.ClientAuthentication = exports.CertificateFormat = exports.CodeChallengeMethod = void 0;
	const gaxios_1$12 = __require("gaxios");
	const querystring = __require("querystring");
	const stream$3 = __require("stream");
	const formatEcdsa = require_ecdsa_sig_formatter();
	const util_1 = require_util();
	const crypto_1 = require_crypto();
	const authclient_1 = require_authclient();
	const loginticket_1 = require_loginticket();
	var CodeChallengeMethod;
	(function(CodeChallengeMethod) {
		CodeChallengeMethod["Plain"] = "plain";
		CodeChallengeMethod["S256"] = "S256";
	})(CodeChallengeMethod || (exports.CodeChallengeMethod = CodeChallengeMethod = {}));
	var CertificateFormat;
	(function(CertificateFormat) {
		CertificateFormat["PEM"] = "PEM";
		CertificateFormat["JWK"] = "JWK";
	})(CertificateFormat || (exports.CertificateFormat = CertificateFormat = {}));
	/**
	* The client authentication type. Supported values are basic, post, and none.
	* https://datatracker.ietf.org/doc/html/rfc7591#section-2
	*/
	var ClientAuthentication;
	(function(ClientAuthentication) {
		ClientAuthentication["ClientSecretPost"] = "ClientSecretPost";
		ClientAuthentication["ClientSecretBasic"] = "ClientSecretBasic";
		ClientAuthentication["None"] = "None";
	})(ClientAuthentication || (exports.ClientAuthentication = ClientAuthentication = {}));
	exports.OAuth2Client = class OAuth2Client extends authclient_1.AuthClient {
		redirectUri;
		certificateCache = {};
		certificateExpiry = null;
		certificateCacheFormat = CertificateFormat.PEM;
		refreshTokenPromises = /* @__PURE__ */ new Map();
		endpoints;
		issuers;
		clientAuthentication;
		_clientId;
		_clientSecret;
		refreshHandler;
		/**
		* An OAuth2 Client for Google APIs.
		*
		* @param options The OAuth2 Client Options. Passing an `clientId` directly is **@DEPRECATED**.
		* @param clientSecret **@DEPRECATED**. Provide a {@link OAuth2ClientOptions `OAuth2ClientOptions`} object in the first parameter instead.
		* @param redirectUri **@DEPRECATED**. Provide a {@link OAuth2ClientOptions `OAuth2ClientOptions`} object in the first parameter instead.
		*/
		constructor(options = {}, clientSecret, redirectUri) {
			super(typeof options === "object" ? options : {});
			if (typeof options !== "object") {options = {
				clientId: options,
				clientSecret,
				redirectUri
			};}
			this._clientId = options.clientId || options.client_id;
			this._clientSecret = options.clientSecret || options.client_secret;
			this.redirectUri = options.redirectUri || options.redirect_uris?.[0];
			this.endpoints = {
				tokenInfoUrl: "https://oauth2.googleapis.com/tokeninfo",
				oauth2AuthBaseUrl: "https://accounts.google.com/o/oauth2/v2/auth",
				oauth2TokenUrl: "https://oauth2.googleapis.com/token",
				oauth2RevokeUrl: "https://oauth2.googleapis.com/revoke",
				oauth2FederatedSignonPemCertsUrl: "https://www.googleapis.com/oauth2/v1/certs",
				oauth2FederatedSignonJwkCertsUrl: "https://www.googleapis.com/oauth2/v3/certs",
				oauth2IapPublicKeyUrl: "https://www.gstatic.com/iap/verify/public_key",
				...options.endpoints
			};
			this.clientAuthentication = options.clientAuthentication || ClientAuthentication.ClientSecretPost;
			this.issuers = options.issuers || [
				"accounts.google.com",
				"https://accounts.google.com",
				this.universeDomain
			];
		}
		/**
		* @deprecated use instance's {@link OAuth2Client.endpoints}
		*/
		static GOOGLE_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo";
		/**
		* Clock skew - five minutes in seconds
		*/
		static CLOCK_SKEW_SECS_ = 300;
		/**
		* The default max Token Lifetime is one day in seconds
		*/
		static DEFAULT_MAX_TOKEN_LIFETIME_SECS_ = 86400;
		/**
		* Generates URL for consent page landing.
		* @param opts Options.
		* @return URL to consent page.
		*/
		generateAuthUrl(opts = {}) {
			if (opts.code_challenge_method && !opts.code_challenge) {throw new Error("If a code_challenge_method is provided, code_challenge must be included.");}
			opts.response_type = opts.response_type || "code";
			opts.client_id = opts.client_id || this._clientId;
			opts.redirect_uri = opts.redirect_uri || this.redirectUri;
			if (Array.isArray(opts.scope)) {opts.scope = opts.scope.join(" ");}
			return this.endpoints.oauth2AuthBaseUrl.toString() + "?" + querystring.stringify(opts);
		}
		generateCodeVerifier() {
			throw new Error("generateCodeVerifier is removed, please use generateCodeVerifierAsync instead.");
		}
		/**
		* Convenience method to automatically generate a code_verifier, and its
		* resulting SHA256. If used, this must be paired with a S256
		* code_challenge_method.
		*
		* For a full example see:
		* https://github.com/googleapis/google-auth-library-nodejs/blob/main/samples/oauth2-codeVerifier.js
		*/
		async generateCodeVerifierAsync() {
			const crypto = (0, crypto_1.createCrypto)();
			const codeVerifier = crypto.randomBytesBase64(96).replace(/\+/g, "~").replace(/=/g, "_").replace(/\//g, "-");
			return {
				codeVerifier,
				codeChallenge: (await crypto.sha256DigestBase64(codeVerifier)).split("=")[0].replace(/\+/g, "-").replace(/\//g, "_")
			};
		}
		getToken(codeOrOptions, callback) {
			const options = typeof codeOrOptions === "string" ? { code: codeOrOptions } : codeOrOptions;
			if (callback) {this.getTokenAsync(options).then((r) => callback(null, r.tokens, r.res), (e) => callback(e, null, e.response));}
			else {return this.getTokenAsync(options);}
		}
		async getTokenAsync(options) {
			const url = this.endpoints.oauth2TokenUrl.toString();
			const headers = new Headers();
			const values = {
				client_id: options.client_id || this._clientId,
				code_verifier: options.codeVerifier,
				code: options.code,
				grant_type: "authorization_code",
				redirect_uri: options.redirect_uri || this.redirectUri
			};
			if (this.clientAuthentication === ClientAuthentication.ClientSecretBasic) {
				const basic = Buffer.from(`${this._clientId}:${this._clientSecret}`);
				headers.set("authorization", `Basic ${basic.toString("base64")}`);
			}
			if (this.clientAuthentication === ClientAuthentication.ClientSecretPost) {values.client_secret = this._clientSecret;}
			const opts = {
				...OAuth2Client.RETRY_CONFIG,
				method: "POST",
				url,
				data: new URLSearchParams((0, util_1.removeUndefinedValuesInObject)(values)),
				headers
			};
			authclient_1.AuthClient.setMethodName(opts, "getTokenAsync");
			const res = await this.transporter.request(opts);
			const tokens = res.data;
			if (res.data && res.data.expires_in) {
				tokens.expiry_date = (/* @__PURE__ */ new Date()).getTime() + res.data.expires_in * 1e3;
				delete tokens.expires_in;
			}
			this.emit("tokens", tokens);
			return {
				tokens,
				res
			};
		}
		/**
		* Refreshes the access token.
		* @param refresh_token Existing refresh token.
		* @private
		*/
		async refreshToken(refreshToken) {
			if (!refreshToken) {return this.refreshTokenNoCache(refreshToken);}
			if (this.refreshTokenPromises.has(refreshToken)) {return this.refreshTokenPromises.get(refreshToken);}
			const p = this.refreshTokenNoCache(refreshToken).then((r) => {
				this.refreshTokenPromises.delete(refreshToken);
				return r;
			}, (e) => {
				this.refreshTokenPromises.delete(refreshToken);
				throw e;
			});
			this.refreshTokenPromises.set(refreshToken, p);
			return p;
		}
		async refreshTokenNoCache(refreshToken) {
			if (!refreshToken) {throw new Error("No refresh token is set.");}
			const url = this.endpoints.oauth2TokenUrl.toString();
			const data = {
				refresh_token: refreshToken,
				client_id: this._clientId,
				client_secret: this._clientSecret,
				grant_type: "refresh_token"
			};
			let res;
			try {
				const opts = {
					...OAuth2Client.RETRY_CONFIG,
					method: "POST",
					url,
					data: new URLSearchParams((0, util_1.removeUndefinedValuesInObject)(data))
				};
				authclient_1.AuthClient.setMethodName(opts, "refreshTokenNoCache");
				res = await this.transporter.request(opts);
			} catch (e) {
				if (e instanceof gaxios_1$12.GaxiosError && e.message === "invalid_grant" && e.response?.data && /ReAuth/i.test(e.response.data.error_description)) {e.message = JSON.stringify(e.response.data);}
				throw e;
			}
			const tokens = res.data;
			if (res.data && res.data.expires_in) {
				tokens.expiry_date = (/* @__PURE__ */ new Date()).getTime() + res.data.expires_in * 1e3;
				delete tokens.expires_in;
			}
			this.emit("tokens", tokens);
			return {
				tokens,
				res
			};
		}
		refreshAccessToken(callback) {
			if (callback) {this.refreshAccessTokenAsync().then((r) => callback(null, r.credentials, r.res), callback);}
			else {return this.refreshAccessTokenAsync();}
		}
		async refreshAccessTokenAsync() {
			const r = await this.refreshToken(this.credentials.refresh_token);
			const tokens = r.tokens;
			tokens.refresh_token = this.credentials.refresh_token;
			this.credentials = tokens;
			return {
				credentials: this.credentials,
				res: r.res
			};
		}
		getAccessToken(callback) {
			if (callback) {this.getAccessTokenAsync().then((r) => callback(null, r.token, r.res), callback);}
			else {return this.getAccessTokenAsync();}
		}
		async getAccessTokenAsync() {
			if (!this.credentials.access_token || this.isTokenExpiring()) {
				if (!this.credentials.refresh_token) {if (this.refreshHandler) {
					const refreshedAccessToken = await this.processAndValidateRefreshHandler();
					if (refreshedAccessToken?.access_token) {
						this.setCredentials(refreshedAccessToken);
						return { token: this.credentials.access_token };
					}
				} else throw new Error("No refresh token or refresh handler callback is set.");}
				const r = await this.refreshAccessTokenAsync();
				if (!r.credentials || r.credentials && !r.credentials.access_token) {throw new Error("Could not refresh access token.");}
				return {
					token: r.credentials.access_token,
					res: r.res
				};
			} else {return { token: this.credentials.access_token };}
		}
		/**
		* The main authentication interface.  It takes an optional url which when
		* present is the endpoint being accessed, and returns a Promise which
		* resolves with authorization header fields.
		*
		* In OAuth2Client, the result has the form:
		* { authorization: 'Bearer <access_token_value>' }
		*/
		async getRequestHeaders(url) {
			return (await this.getRequestMetadataAsync(url)).headers;
		}
		async getRequestMetadataAsync(url) {
			const thisCreds = this.credentials;
			if (!thisCreds.access_token && !thisCreds.refresh_token && !this.apiKey && !this.refreshHandler) {throw new Error("No access, refresh token, API key or refresh handler callback is set.");}
			if (thisCreds.access_token && !this.isTokenExpiring()) {
				thisCreds.token_type = thisCreds.token_type || "Bearer";
				const headers = new Headers({ authorization: thisCreds.token_type + " " + thisCreds.access_token });
				return { headers: this.addSharedMetadataHeaders(headers) };
			}
			if (this.refreshHandler) {
				const refreshedAccessToken = await this.processAndValidateRefreshHandler();
				if (refreshedAccessToken?.access_token) {
					this.setCredentials(refreshedAccessToken);
					const headers = new Headers({ authorization: "Bearer " + this.credentials.access_token });
					return { headers: this.addSharedMetadataHeaders(headers) };
				}
			}
			if (this.apiKey) {return { headers: new Headers({ "X-Goog-Api-Key": this.apiKey }) };}
			let r = null;
			let tokens = null;
			try {
				r = await this.refreshToken(thisCreds.refresh_token);
				tokens = r.tokens;
			} catch (err) {
				const e = err;
				if (e.response && (e.response.status === 403 || e.response.status === 404)) {e.message = `Could not refresh access token: ${e.message}`;}
				throw e;
			}
			const credentials = this.credentials;
			credentials.token_type = credentials.token_type || "Bearer";
			tokens.refresh_token = credentials.refresh_token;
			this.credentials = tokens;
			const headers = new Headers({ authorization: credentials.token_type + " " + tokens.access_token });
			return {
				headers: this.addSharedMetadataHeaders(headers),
				res: r.res
			};
		}
		/**
		* Generates an URL to revoke the given token.
		* @param token The existing token to be revoked.
		*
		* @deprecated use instance method {@link OAuth2Client.getRevokeTokenURL}
		*/
		static getRevokeTokenUrl(token) {
			return new OAuth2Client().getRevokeTokenURL(token).toString();
		}
		/**
		* Generates a URL to revoke the given token.
		*
		* @param token The existing token to be revoked.
		*/
		getRevokeTokenURL(token) {
			const url = new URL(this.endpoints.oauth2RevokeUrl);
			url.searchParams.append("token", token);
			return url;
		}
		revokeToken(token, callback) {
			const opts = {
				...OAuth2Client.RETRY_CONFIG,
				url: this.getRevokeTokenURL(token).toString(),
				method: "POST"
			};
			authclient_1.AuthClient.setMethodName(opts, "revokeToken");
			if (callback) {this.transporter.request(opts).then((r) => callback(null, r), callback);}
			else {return this.transporter.request(opts);}
		}
		revokeCredentials(callback) {
			if (callback) {this.revokeCredentialsAsync().then((res) => callback(null, res), callback);}
			else {return this.revokeCredentialsAsync();}
		}
		async revokeCredentialsAsync() {
			const token = this.credentials.access_token;
			this.credentials = {};
			if (token) {return this.revokeToken(token);}
			else {throw new Error("No access token to revoke.");}
		}
		request(opts, callback) {
			if (callback) {this.requestAsync(opts).then((r) => callback(null, r), (e) => {
				return callback(e, e.response);
			});}
			else {return this.requestAsync(opts);}
		}
		async requestAsync(opts, reAuthRetried = false) {
			try {
				const r = await this.getRequestMetadataAsync();
				opts.headers = gaxios_1$12.Gaxios.mergeHeaders(opts.headers);
				this.addUserProjectAndAuthHeaders(opts.headers, r.headers);
				if (this.apiKey) {opts.headers.set("X-Goog-Api-Key", this.apiKey);}
				return await this.transporter.request(opts);
			} catch (e) {
				const res = e.response;
				if (res) {
					const statusCode = res.status;
					const mayRequireRefresh = this.credentials && this.credentials.access_token && this.credentials.refresh_token && (!this.credentials.expiry_date || this.forceRefreshOnFailure);
					const mayRequireRefreshWithNoRefreshToken = this.credentials && this.credentials.access_token && !this.credentials.refresh_token && (!this.credentials.expiry_date || this.forceRefreshOnFailure) && this.refreshHandler;
					const isReadableStream = res.config.data instanceof stream$3.Readable;
					const isAuthErr = statusCode === 401 || statusCode === 403;
					if (!reAuthRetried && isAuthErr && !isReadableStream && mayRequireRefresh) {
						await this.refreshAccessTokenAsync();
						return this.requestAsync(opts, true);
					} else if (!reAuthRetried && isAuthErr && !isReadableStream && mayRequireRefreshWithNoRefreshToken) {
						const refreshedAccessToken = await this.processAndValidateRefreshHandler();
						if (refreshedAccessToken?.access_token) {this.setCredentials(refreshedAccessToken);}
						return this.requestAsync(opts, true);
					}
				}
				throw e;
			}
		}
		verifyIdToken(options, callback) {
			if (callback && typeof callback !== "function") {throw new Error("This method accepts an options object as the first parameter, which includes the idToken, audience, and maxExpiry.");}
			if (callback) {this.verifyIdTokenAsync(options).then((r) => callback(null, r), callback);}
			else {return this.verifyIdTokenAsync(options);}
		}
		async verifyIdTokenAsync(options) {
			if (!options.idToken) {throw new Error("The verifyIdToken method requires an ID Token");}
			const response = await this.getFederatedSignonCertsAsync();
			return await this.verifySignedJwtWithCertsAsync(options.idToken, response.certs, options.audience, this.issuers, options.maxExpiry);
		}
		/**
		* Obtains information about the provisioned access token.  Especially useful
		* if you want to check the scopes that were provisioned to a given token.
		*
		* @param accessToken Required.  The Access Token for which you want to get
		* user info.
		*/
		async getTokenInfo(accessToken) {
			const { data } = await this.transporter.request({
				...OAuth2Client.RETRY_CONFIG,
				method: "POST",
				headers: {
					"content-type": "application/x-www-form-urlencoded;charset=UTF-8",
					authorization: `Bearer ${accessToken}`
				},
				url: this.endpoints.tokenInfoUrl.toString()
			});
			const info = Object.assign({
				expiry_date: (/* @__PURE__ */ new Date()).getTime() + data.expires_in * 1e3,
				scopes: data.scope.split(" ")
			}, data);
			delete info.expires_in;
			delete info.scope;
			return info;
		}
		getFederatedSignonCerts(callback) {
			if (callback) {this.getFederatedSignonCertsAsync().then((r) => callback(null, r.certs, r.res), callback);}
			else {return this.getFederatedSignonCertsAsync();}
		}
		async getFederatedSignonCertsAsync() {
			const nowTime = (/* @__PURE__ */ new Date()).getTime();
			const format = (0, crypto_1.hasBrowserCrypto)() ? CertificateFormat.JWK : CertificateFormat.PEM;
			if (this.certificateExpiry && nowTime < this.certificateExpiry.getTime() && this.certificateCacheFormat === format) {return {
				certs: this.certificateCache,
				format
			};}
			let res;
			let url;
			switch (format) {
				case CertificateFormat.PEM:
					url = this.endpoints.oauth2FederatedSignonPemCertsUrl.toString();
					break;
				case CertificateFormat.JWK:
					url = this.endpoints.oauth2FederatedSignonJwkCertsUrl.toString();
					break;
				default: throw new Error(`Unsupported certificate format ${format}`);
			}
			try {
				const opts = {
					...OAuth2Client.RETRY_CONFIG,
					url
				};
				authclient_1.AuthClient.setMethodName(opts, "getFederatedSignonCertsAsync");
				res = await this.transporter.request(opts);
			} catch (e) {
				if (e instanceof Error) {e.message = `Failed to retrieve verification certificates: ${e.message}`;}
				throw e;
			}
			const cacheControl = res?.headers.get("cache-control");
			let cacheAge = -1;
			if (cacheControl) {
				const maxAge = /max-age=(?<maxAge>[0-9]+)/.exec(cacheControl)?.groups?.maxAge;
				if (maxAge) {cacheAge = Number(maxAge) * 1e3;}
			}
			let certificates = {};
			switch (format) {
				case CertificateFormat.PEM:
					certificates = res.data;
					break;
				case CertificateFormat.JWK:
					for (const key of res.data.keys) {certificates[key.kid] = key;}
					break;
				default: throw new Error(`Unsupported certificate format ${format}`);
			}
			const now = /* @__PURE__ */ new Date();
			this.certificateExpiry = cacheAge === -1 ? null : new Date(now.getTime() + cacheAge);
			this.certificateCache = certificates;
			this.certificateCacheFormat = format;
			return {
				certs: certificates,
				format,
				res
			};
		}
		getIapPublicKeys(callback) {
			if (callback) {this.getIapPublicKeysAsync().then((r) => callback(null, r.pubkeys, r.res), callback);}
			else {return this.getIapPublicKeysAsync();}
		}
		async getIapPublicKeysAsync() {
			let res;
			const url = this.endpoints.oauth2IapPublicKeyUrl.toString();
			try {
				const opts = {
					...OAuth2Client.RETRY_CONFIG,
					url
				};
				authclient_1.AuthClient.setMethodName(opts, "getIapPublicKeysAsync");
				res = await this.transporter.request(opts);
			} catch (e) {
				if (e instanceof Error) {e.message = `Failed to retrieve verification certificates: ${e.message}`;}
				throw e;
			}
			return {
				pubkeys: res.data,
				res
			};
		}
		verifySignedJwtWithCerts() {
			throw new Error("verifySignedJwtWithCerts is removed, please use verifySignedJwtWithCertsAsync instead.");
		}
		/**
		* Verify the id token is signed with the correct certificate
		* and is from the correct audience.
		* @param jwt The jwt to verify (The ID Token in this case).
		* @param certs The array of certs to test the jwt against.
		* @param requiredAudience The audience to test the jwt against.
		* @param issuers The allowed issuers of the jwt (Optional).
		* @param maxExpiry The max expiry the certificate can be (Optional).
		* @return Returns a promise resolving to LoginTicket on verification.
		*/
		async verifySignedJwtWithCertsAsync(jwt, certs, requiredAudience, issuers, maxExpiry) {
			const crypto = (0, crypto_1.createCrypto)();
			if (!maxExpiry) {maxExpiry = OAuth2Client.DEFAULT_MAX_TOKEN_LIFETIME_SECS_;}
			const segments = jwt.split(".");
			if (segments.length !== 3) {throw new Error("Wrong number of segments in token: " + jwt);}
			const signed = segments[0] + "." + segments[1];
			let signature = segments[2];
			let envelope;
			let payload;
			try {
				envelope = JSON.parse(crypto.decodeBase64StringUtf8(segments[0]));
			} catch (err) {
				if (err instanceof Error) {err.message = `Can't parse token envelope: ${segments[0]}': ${err.message}`;}
				throw err;
			}
			if (!envelope) {throw new Error("Can't parse token envelope: " + segments[0]);}
			try {
				payload = JSON.parse(crypto.decodeBase64StringUtf8(segments[1]));
			} catch (err) {
				if (err instanceof Error) {err.message = `Can't parse token payload '${segments[0]}`;}
				throw err;
			}
			if (!payload) {throw new Error("Can't parse token payload: " + segments[1]);}
			if (!Object.prototype.hasOwnProperty.call(certs, envelope.kid)) {throw new Error("No pem found for envelope: " + JSON.stringify(envelope));}
			const cert = certs[envelope.kid];
			if (envelope.alg === "ES256") {signature = formatEcdsa.joseToDer(signature, "ES256").toString("base64");}
			if (!await crypto.verify(cert, signed, signature)) {throw new Error("Invalid token signature: " + jwt);}
			if (!payload.iat) {throw new Error("No issue time in token: " + JSON.stringify(payload));}
			if (!payload.exp) {throw new Error("No expiration time in token: " + JSON.stringify(payload));}
			const iat = Number(payload.iat);
			if (isNaN(iat)) {throw new Error("iat field using invalid format");}
			const exp = Number(payload.exp);
			if (isNaN(exp)) {throw new Error("exp field using invalid format");}
			const now = (/* @__PURE__ */ new Date()).getTime() / 1e3;
			if (exp >= now + maxExpiry) {throw new Error("Expiration time too far in future: " + JSON.stringify(payload));}
			const earliest = iat - OAuth2Client.CLOCK_SKEW_SECS_;
			const latest = exp + OAuth2Client.CLOCK_SKEW_SECS_;
			if (now < earliest) {throw new Error("Token used too early, " + now + " < " + earliest + ": " + JSON.stringify(payload));}
			if (now > latest) {throw new Error("Token used too late, " + now + " > " + latest + ": " + JSON.stringify(payload));}
			if (issuers && issuers.indexOf(payload.iss) < 0) {throw new Error("Invalid issuer, expected one of [" + issuers + "], but got " + payload.iss);}
			if (typeof requiredAudience !== "undefined" && requiredAudience !== null) {
				const aud = payload.aud;
				let audVerified = false;
				if (requiredAudience.constructor === Array) {audVerified = requiredAudience.indexOf(aud) > -1;}
				else {audVerified = aud === requiredAudience;}
				if (!audVerified) {throw new Error("Wrong recipient, payload audience != requiredAudience");}
			}
			return new loginticket_1.LoginTicket(envelope, payload);
		}
		/**
		* Returns a promise that resolves with AccessTokenResponse type if
		* refreshHandler is defined.
		* If not, nothing is returned.
		*/
		async processAndValidateRefreshHandler() {
			if (this.refreshHandler) {
				const accessTokenResponse = await this.refreshHandler();
				if (!accessTokenResponse.access_token) {throw new Error("No access token is returned by the refreshHandler callback.");}
				return accessTokenResponse;
			}
		}
		/**
		* Returns true if a token is expired or will expire within
		* eagerRefreshThresholdMillismilliseconds.
		* If there is no expiry time, assumes the token is not expired or expiring.
		*/
		isTokenExpiring() {
			const expiryDate = this.credentials.expiry_date;
			return expiryDate ? expiryDate <= (/* @__PURE__ */ new Date()).getTime() + this.eagerRefreshThresholdMillis : false;
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/computeclient.js
var require_computeclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Compute = void 0;
	const gaxios_1$11 = __require("gaxios");
	const gcpMetadata = require_src$1();
	const oauth2client_1 = require_oauth2client();
	var Compute = class extends oauth2client_1.OAuth2Client {
		serviceAccountEmail;
		scopes;
		/**
		* Google Compute Engine service account credentials.
		*
		* Retrieve access token from the metadata server.
		* See: https://cloud.google.com/compute/docs/access/authenticate-workloads#applications
		*/
		constructor(options = {}) {
			super(options);
			this.credentials = {
				expiry_date: 1,
				refresh_token: "compute-placeholder"
			};
			this.serviceAccountEmail = options.serviceAccountEmail || "default";
			this.scopes = Array.isArray(options.scopes) ? options.scopes : options.scopes ? [options.scopes] : [];
		}
		/**
		* Refreshes the access token.
		* @param refreshToken Unused parameter
		*/
		async refreshTokenNoCache() {
			const tokenPath = `service-accounts/${this.serviceAccountEmail}/token`;
			let data;
			try {
				const instanceOptions = { property: tokenPath };
				if (this.scopes.length > 0) {instanceOptions.params = { scopes: this.scopes.join(",") };}
				data = await gcpMetadata.instance(instanceOptions);
			} catch (e) {
				if (e instanceof gaxios_1$11.GaxiosError) {
					e.message = `Could not refresh access token: ${e.message}`;
					this.wrapError(e);
				}
				throw e;
			}
			const tokens = data;
			if (data && data.expires_in) {
				tokens.expiry_date = (/* @__PURE__ */ new Date()).getTime() + data.expires_in * 1e3;
				delete tokens.expires_in;
			}
			this.emit("tokens", tokens);
			return {
				tokens,
				res: null
			};
		}
		/**
		* Fetches an ID token.
		* @param targetAudience the audience for the fetched ID token.
		*/
		async fetchIdToken(targetAudience) {
			const idTokenPath = `service-accounts/${this.serviceAccountEmail}/identity?format=full&audience=${targetAudience}`;
			let idToken;
			try {
				const instanceOptions = { property: idTokenPath };
				idToken = await gcpMetadata.instance(instanceOptions);
			} catch (e) {
				if (e instanceof Error) {e.message = `Could not fetch ID token: ${e.message}`;}
				throw e;
			}
			return idToken;
		}
		wrapError(e) {
			const res = e.response;
			if (res && res.status) {
				e.status = res.status;
				if (res.status === 403) {e.message = "A Forbidden error was returned while attempting to retrieve an access token for the Compute Engine built-in service account. This may be because the Compute Engine instance does not have the correct permission scopes specified: " + e.message;}
				else if (res.status === 404) {e.message = "A Not Found error was returned while attempting to retrieve an accesstoken for the Compute Engine built-in service account. This may be because the Compute Engine instance does not have any permission scopes specified: " + e.message;}
			}
		}
	};
	exports.Compute = Compute;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/idtokenclient.js
var require_idtokenclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.IdTokenClient = void 0;
	const oauth2client_1 = require_oauth2client();
	var IdTokenClient = class extends oauth2client_1.OAuth2Client {
		targetAudience;
		idTokenProvider;
		/**
		* Google ID Token client
		*
		* Retrieve ID token from the metadata server.
		* See: https://cloud.google.com/docs/authentication/get-id-token#metadata-server
		*/
		constructor(options) {
			super(options);
			this.targetAudience = options.targetAudience;
			this.idTokenProvider = options.idTokenProvider;
		}
		async getRequestMetadataAsync() {
			if (!this.credentials.id_token || !this.credentials.expiry_date || this.isTokenExpiring()) {
				const idToken = await this.idTokenProvider.fetchIdToken(this.targetAudience);
				this.credentials = {
					id_token: idToken,
					expiry_date: this.getIdTokenExpiryDate(idToken)
				};
			}
			return { headers: new Headers({ authorization: "Bearer " + this.credentials.id_token }) };
		}
		getIdTokenExpiryDate(idToken) {
			const payloadB64 = idToken.split(".")[1];
			if (payloadB64) {return JSON.parse(Buffer.from(payloadB64, "base64").toString("ascii")).exp * 1e3;}
		}
	};
	exports.IdTokenClient = IdTokenClient;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/envDetect.js
var require_envDetect = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GCPEnv = void 0;
	exports.clear = clear;
	exports.getEnv = getEnv;
	const gcpMetadata = require_src$1();
	var GCPEnv;
	(function(GCPEnv) {
		GCPEnv["APP_ENGINE"] = "APP_ENGINE";
		GCPEnv["KUBERNETES_ENGINE"] = "KUBERNETES_ENGINE";
		GCPEnv["CLOUD_FUNCTIONS"] = "CLOUD_FUNCTIONS";
		GCPEnv["COMPUTE_ENGINE"] = "COMPUTE_ENGINE";
		GCPEnv["CLOUD_RUN"] = "CLOUD_RUN";
		GCPEnv["CLOUD_RUN_JOBS"] = "CLOUD_RUN_JOBS";
		GCPEnv["NONE"] = "NONE";
	})(GCPEnv || (exports.GCPEnv = GCPEnv = {}));
	let envPromise;
	function clear() {
		envPromise = void 0;
	}
	async function getEnv() {
		if (envPromise) {return envPromise;}
		envPromise = getEnvMemoized();
		return envPromise;
	}
	async function getEnvMemoized() {
		let env = GCPEnv.NONE;
		if (isAppEngine()) {env = GCPEnv.APP_ENGINE;}
		else if (isCloudFunction()) {env = GCPEnv.CLOUD_FUNCTIONS;}
		else if (await isComputeEngine()) {if (await isKubernetesEngine()) env = GCPEnv.KUBERNETES_ENGINE;
		else if (isCloudRun()) env = GCPEnv.CLOUD_RUN;
		else if (isCloudRunJob()) env = GCPEnv.CLOUD_RUN_JOBS;
		else env = GCPEnv.COMPUTE_ENGINE;}
		else {env = GCPEnv.NONE;}
		return env;
	}
	function isAppEngine() {
		return !!(process.env.GAE_SERVICE || process.env.GAE_MODULE_NAME);
	}
	function isCloudFunction() {
		return !!(process.env.FUNCTION_NAME || process.env.FUNCTION_TARGET);
	}
	/**
	* This check only verifies that the environment is running knative.
	* This must be run *after* checking for Kubernetes, otherwise it will
	* return a false positive.
	*/
	function isCloudRun() {
		return !!process.env.K_CONFIGURATION;
	}
	function isCloudRunJob() {
		return !!process.env.CLOUD_RUN_JOB;
	}
	async function isKubernetesEngine() {
		try {
			await gcpMetadata.instance("attributes/cluster-name");
			return true;
		} catch (e) {
			return false;
		}
	}
	async function isComputeEngine() {
		return gcpMetadata.isAvailable();
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/gtoken/jwsSign.js
var require_jwsSign = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.buildPayloadForJwsSign = buildPayloadForJwsSign;
	exports.getJwsSign = getJwsSign;
	const jws_1 = require_jws();
	/** The default algorithm for signing JWTs. */
	const ALG_RS256 = "RS256";
	/** The URL for Google's OAuth 2.0 token endpoint. */
	const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
	/**
	* Builds the JWT payload for signing.
	* @param tokenOptions The options for the token.
	* @returns The JWT payload.
	*/
	function buildPayloadForJwsSign(tokenOptions) {
		const iat = Math.floor((/* @__PURE__ */ new Date()).getTime() / 1e3);
		return {
			iss: tokenOptions.iss,
			scope: tokenOptions.scope,
			aud: GOOGLE_TOKEN_URL,
			exp: iat + 3600,
			iat,
			sub: tokenOptions.sub,
			...tokenOptions.additionalClaims
		};
	}
	/**
	* Creates a signed JWS (JSON Web Signature).
	* @param tokenOptions The options for the token.
	* @returns The signed JWS.
	*/
	function getJwsSign(tokenOptions) {
		const payload = buildPayloadForJwsSign(tokenOptions);
		return (0, jws_1.sign)({
			header: { alg: ALG_RS256 },
			payload,
			secret: tokenOptions.key
		});
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/gtoken/getToken.js
var require_getToken = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getToken = getToken;
	const jwsSign_1 = require_jwsSign();
	/** The URL for Google's OAuth 2.0 token endpoint. */
	const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
	/** The grant type for JWT-based authorization. */
	const GOOGLE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
	/**
	* Generates the request options for fetching a token.
	* @param tokenOptions The options for the token.
	* @returns The Gaxios options for the request.
	*/
	const generateRequestOptions = (tokenOptions) => {
		return {
			method: "POST",
			url: GOOGLE_TOKEN_URL,
			data: new URLSearchParams({
				grant_type: GOOGLE_GRANT_TYPE,
				assertion: (0, jwsSign_1.getJwsSign)(tokenOptions)
			}),
			responseType: "json",
			retryConfig: { httpMethodsToRetry: ["POST"] }
		};
	};
	/**
	* Fetches an access token.
	* @param tokenOptions The options for the token.
	* @returns A promise that resolves with the token data.
	*/
	async function getToken(tokenOptions) {
		if (!tokenOptions.transporter) {throw new Error("No transporter set.");}
		try {
			const gaxiosOptions = generateRequestOptions(tokenOptions);
			return (await tokenOptions.transporter.request(gaxiosOptions)).data;
		} catch (e) {
			const err = e;
			const errorData = err.response?.data;
			if (errorData?.error) {err.message = `${errorData.error}: ${errorData.error_description}`;}
			throw err;
		}
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/gtoken/errorWithCode.js
var require_errorWithCode = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ErrorWithCode = void 0;
	var ErrorWithCode = class extends Error {
		code;
		constructor(message, code) {
			super(message);
			this.code = code;
		}
	};
	exports.ErrorWithCode = ErrorWithCode;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/gtoken/getCredentials.js
var require_getCredentials = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getCredentials = getCredentials;
	const path$1 = __require("path");
	const fs$4 = __require("fs");
	const util_1$1 = __require("util");
	const errorWithCode_1 = require_errorWithCode();
	const readFile = fs$4.readFile ? (0, util_1$1.promisify)(fs$4.readFile) : async () => {
		throw new errorWithCode_1.ErrorWithCode("use key rather than keyFile.", "MISSING_CREDENTIALS");
	};
	var ExtensionFiles;
	(function(ExtensionFiles) {
		ExtensionFiles["JSON"] = ".json";
		ExtensionFiles["DER"] = ".der";
		ExtensionFiles["CRT"] = ".crt";
		ExtensionFiles["PEM"] = ".pem";
		ExtensionFiles["P12"] = ".p12";
		ExtensionFiles["PFX"] = ".pfx";
	})(ExtensionFiles || (ExtensionFiles = {}));
	/**
	* Provides credentials from a JSON key file.
	*/
	var JsonCredentialsProvider = class {
		keyFilePath;
		constructor(keyFilePath) {
			this.keyFilePath = keyFilePath;
		}
		/**
		* Reads a JSON key file and extracts the private key and client email.
		* @returns A promise that resolves with the credentials.
		*/
		async getCredentials() {
			const key = await readFile(this.keyFilePath, "utf8");
			let body;
			try {
				body = JSON.parse(key);
			} catch (error) {
				const err = error;
				throw new Error(`Invalid JSON key file: ${err.message}`, { cause: error });
			}
			const privateKey = body.private_key;
			const clientEmail = body.client_email;
			if (!privateKey || !clientEmail) {throw new errorWithCode_1.ErrorWithCode("private_key and client_email are required.", "MISSING_CREDENTIALS");}
			return {
				privateKey,
				clientEmail
			};
		}
	};
	/**
	* Provides credentials from a PEM-like key file.
	*/
	var PemCredentialsProvider = class {
		keyFilePath;
		constructor(keyFilePath) {
			this.keyFilePath = keyFilePath;
		}
		/**
		* Reads a PEM-like key file.
		* @returns A promise that resolves with the private key.
		*/
		async getCredentials() {
			return { privateKey: await readFile(this.keyFilePath, "utf8") };
		}
	};
	/**
	* Handles unsupported P12/PFX certificate types.
	*/
	var P12CredentialsProvider = class {
		/**
		* Throws an error as P12/PFX certificates are not supported.
		* @returns A promise that rejects with an error.
		*/
		async getCredentials() {
			throw new errorWithCode_1.ErrorWithCode("*.p12 certificates are not supported after v6.1.2. Consider utilizing *.json format or converting *.p12 to *.pem using the OpenSSL CLI.", "UNKNOWN_CERTIFICATE_TYPE");
		}
	};
	/**
	* Factory class to create the appropriate credentials provider.
	*/
	var CredentialsProviderFactory = class {
		/**
		* Creates a credential provider based on the key file extension.
		* @param keyFilePath The path to the key file.
		* @returns An instance of a class that implements ICredentialsProvider.
		*/
		static create(keyFilePath) {
			switch (path$1.extname(keyFilePath)) {
				case ExtensionFiles.JSON: return new JsonCredentialsProvider(keyFilePath);
				case ExtensionFiles.DER:
				case ExtensionFiles.CRT:
				case ExtensionFiles.PEM: return new PemCredentialsProvider(keyFilePath);
				case ExtensionFiles.P12:
				case ExtensionFiles.PFX: return new P12CredentialsProvider();
				default: throw new errorWithCode_1.ErrorWithCode("Unknown certificate type. Type is determined based on file extension. Current supported extensions are *.json, and *.pem.", "UNKNOWN_CERTIFICATE_TYPE");
			}
		}
	};
	/**
	* Given a keyFile, extract the key and client email if available
	* @param keyFile Path to a json, pem, or p12 file that contains the key.
	* @returns an object with privateKey and clientEmail properties
	*/
	async function getCredentials(keyFilePath) {
		return CredentialsProviderFactory.create(keyFilePath).getCredentials();
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/gtoken/tokenHandler.js
var require_tokenHandler = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.TokenHandler = void 0;
	const getToken_1 = require_getToken();
	const getCredentials_1 = require_getCredentials();
	/**
	* Manages the fetching and caching of access tokens.
	*/
	var TokenHandler = class {
		/** The cached access token. */
		token;
		/** The expiration time of the cached access token. */
		tokenExpiresAt;
		/** A promise for an in-flight token request. */
		inFlightRequest;
		tokenOptions;
		/**
		* Creates an instance of TokenHandler.
		* @param tokenOptions The options for fetching tokens.
		* @param transporter The transporter to use for making requests.
		*/
		constructor(tokenOptions) {
			this.tokenOptions = tokenOptions;
		}
		/**
		* Processes the credentials, loading them from a key file if necessary.
		* This method is called before any token request.
		*/
		async processCredentials() {
			if (!this.tokenOptions.key && !this.tokenOptions.keyFile) {throw new Error("No key or keyFile set.");}
			if (!this.tokenOptions.key && this.tokenOptions.keyFile) {
				const credentials = await (0, getCredentials_1.getCredentials)(this.tokenOptions.keyFile);
				this.tokenOptions.key = credentials.privateKey;
				this.tokenOptions.email = credentials.clientEmail;
			}
		}
		/**
		* Checks if the cached token is expired or close to expiring.
		* @returns True if the token is expiring, false otherwise.
		*/
		isTokenExpiring() {
			if (!this.token || !this.tokenExpiresAt) {return true;}
			const now = (/* @__PURE__ */ new Date()).getTime();
			const eagerRefreshThresholdMillis = this.tokenOptions.eagerRefreshThresholdMillis ?? 0;
			return this.tokenExpiresAt <= now + eagerRefreshThresholdMillis;
		}
		/**
		* Returns whether the token has completely expired.
		*
		* @returns true if the token has expired, false otherwise.
		*/
		hasExpired() {
			(/* @__PURE__ */ new Date()).getTime();
			if (this.token && this.tokenExpiresAt) {return (/* @__PURE__ */ new Date()).getTime() >= this.tokenExpiresAt;}
			return true;
		}
		/**
		* Fetches an access token, using a cached one if available and not expired.
		* @param forceRefresh If true, forces a new token to be fetched.
		* @returns A promise that resolves with the token data.
		*/
		async getToken(forceRefresh) {
			await this.processCredentials();
			if (this.inFlightRequest && !forceRefresh) {return this.inFlightRequest;}
			if (this.token && !this.isTokenExpiring() && !forceRefresh) {return this.token;}
			try {
				this.inFlightRequest = (0, getToken_1.getToken)(this.tokenOptions);
				const token = await this.inFlightRequest;
				this.token = token;
				this.tokenExpiresAt = (/* @__PURE__ */ new Date()).getTime() + (token.expires_in ?? 0) * 1e3;
				return token;
			} finally {
				this.inFlightRequest = void 0;
			}
		}
	};
	exports.TokenHandler = TokenHandler;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/gtoken/revokeToken.js
var require_revokeToken = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.revokeToken = revokeToken;
	/** The URL for Google's OAuth 2.0 token revocation endpoint. */
	const GOOGLE_REVOKE_TOKEN_URL = "https://oauth2.googleapis.com/revoke?token=";
	/** The default retry behavior for the revoke token request. */
	const DEFAULT_RETRY_VALUE = true;
	/**
	* Revokes a given access token.
	* @param accessToken The access token to revoke.
	* @param transporter The transporter to make the request with.
	* @returns A promise that resolves with the revocation response.
	*/
	async function revokeToken(accessToken, transporter) {
		const url = GOOGLE_REVOKE_TOKEN_URL + accessToken;
		return await transporter.request({
			url,
			retry: DEFAULT_RETRY_VALUE
		});
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/gtoken/googleToken.js
var require_googleToken = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GoogleToken = void 0;
	const gaxios_1$10 = __require("gaxios");
	const tokenHandler_1 = require_tokenHandler();
	const revokeToken_1 = require_revokeToken();
	/**
	* The GoogleToken class is used to manage authentication with Google's OAuth 2.0 authorization server.
	* It handles fetching, caching, and refreshing of access tokens.
	*/
	var GoogleToken = class {
		/** The configuration options for this token instance. */
		tokenOptions;
		/** The handler for token fetching and caching logic. */
		tokenHandler;
		/**
		* Create a GoogleToken.
		*
		* @param options  Configuration object.
		*/
		constructor(options) {
			this.tokenOptions = options || {};
			this.tokenOptions.transporter = this.tokenOptions.transporter || { request: (opts) => (0, gaxios_1$10.request)(opts) };
			if (!this.tokenOptions.iss) {this.tokenOptions.iss = this.tokenOptions.email;}
			if (typeof this.tokenOptions.scope === "object") {this.tokenOptions.scope = this.tokenOptions.scope.join(" ");}
			this.tokenHandler = new tokenHandler_1.TokenHandler(this.tokenOptions);
		}
		get expiresAt() {
			return this.tokenHandler.tokenExpiresAt;
		}
		/**
		* The most recent access token obtained by this client.
		*/
		get accessToken() {
			return this.tokenHandler.token?.access_token;
		}
		/**
		* The most recent ID token obtained by this client.
		*/
		get idToken() {
			return this.tokenHandler.token?.id_token;
		}
		/**
		* The token type of the most recent access token.
		*/
		get tokenType() {
			return this.tokenHandler.token?.token_type;
		}
		/**
		* The refresh token for the current credentials.
		*/
		get refreshToken() {
			return this.tokenHandler.token?.refresh_token;
		}
		/**
		* A boolean indicating if the current token has expired.
		*/
		hasExpired() {
			return this.tokenHandler.hasExpired();
		}
		/**
		* A boolean indicating if the current token is expiring soon,
		* based on the `eagerRefreshThresholdMillis` option.
		*/
		isTokenExpiring() {
			return this.tokenHandler.isTokenExpiring();
		}
		getToken(callbackOrOptions, opts = { forceRefresh: false }) {
			let callback;
			if (typeof callbackOrOptions === "function") {callback = callbackOrOptions;}
			else if (typeof callbackOrOptions === "object") {opts = callbackOrOptions;}
			const promise = this.tokenHandler.getToken(opts.forceRefresh ?? false);
			if (callback) {promise.then((token) => callback(null, token), callback);}
			return promise;
		}
		revokeToken(callback) {
			if (!this.accessToken) {return Promise.reject(/* @__PURE__ */ new Error("No token to revoke."));}
			const promise = (0, revokeToken_1.revokeToken)(this.accessToken, this.tokenOptions.transporter);
			if (callback) {promise.then(() => callback(), callback);}
			this.tokenHandler = new tokenHandler_1.TokenHandler(this.tokenOptions);
		}
		/**
		* Returns the configuration options for this token instance.
		*/
		get googleTokenOptions() {
			return this.tokenOptions;
		}
	};
	exports.GoogleToken = GoogleToken;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/jwtaccess.js
var require_jwtaccess = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.JWTAccess = void 0;
	const jws = require_jws();
	const util_1 = require_util();
	const DEFAULT_HEADER = {
		alg: "RS256",
		typ: "JWT"
	};
	exports.JWTAccess = class JWTAccess {
		email;
		key;
		keyId;
		projectId;
		eagerRefreshThresholdMillis;
		cache = new util_1.LRUCache({
			capacity: 500,
			maxAge: 3600 * 1e3
		});
		/**
		* JWTAccess service account credentials.
		*
		* Create a new access token by using the credential to create a new JWT token
		* that's recognized as the access token.
		*
		* @param email the service account email address.
		* @param key the private key that will be used to sign the token.
		* @param keyId the ID of the private key used to sign the token.
		*/
		constructor(email, key, keyId, eagerRefreshThresholdMillis) {
			this.email = email;
			this.key = key;
			this.keyId = keyId;
			this.eagerRefreshThresholdMillis = eagerRefreshThresholdMillis ?? 300 * 1e3;
		}
		/**
		* Ensures that we're caching a key appropriately, giving precedence to scopes vs. url
		*
		* @param url The URI being authorized.
		* @param scopes The scope or scopes being authorized
		* @returns A string that returns the cached key.
		*/
		getCachedKey(url, scopes) {
			let cacheKey = url;
			if (scopes && Array.isArray(scopes) && scopes.length) {cacheKey = url ? `${url}_${scopes.join("_")}` : `${scopes.join("_")}`;}
			else if (typeof scopes === "string") {cacheKey = url ? `${url}_${scopes}` : scopes;}
			if (!cacheKey) {throw Error("Scopes or url must be provided");}
			return cacheKey;
		}
		/**
		* Get a non-expired access token, after refreshing if necessary.
		*
		* @param url The URI being authorized.
		* @param additionalClaims An object with a set of additional claims to
		* include in the payload.
		* @returns An object that includes the authorization header.
		*/
		getRequestHeaders(url, additionalClaims, scopes) {
			const key = this.getCachedKey(url, scopes);
			const cachedToken = this.cache.get(key);
			const now = Date.now();
			if (cachedToken && cachedToken.expiration - now > this.eagerRefreshThresholdMillis) {return new Headers(cachedToken.headers);}
			const iat = Math.floor(Date.now() / 1e3);
			const exp = JWTAccess.getExpirationTime(iat);
			let defaultClaims;
			if (Array.isArray(scopes)) {scopes = scopes.join(" ");}
			if (scopes) {defaultClaims = {
				iss: this.email,
				sub: this.email,
				scope: scopes,
				exp,
				iat
			};}
			else {defaultClaims = {
				iss: this.email,
				sub: this.email,
				aud: url,
				exp,
				iat
			};}
			if (additionalClaims) {
				for (const claim in defaultClaims) {if (additionalClaims[claim]) throw new Error(`The '${claim}' property is not allowed when passing additionalClaims. This claim is included in the JWT by default.`);}
			}
			const header = this.keyId ? {
				...DEFAULT_HEADER,
				kid: this.keyId
			} : DEFAULT_HEADER;
			const payload = Object.assign(defaultClaims, additionalClaims);
			const signedJWT = jws.sign({
				header,
				payload,
				secret: this.key
			});
			const headers = new Headers({ authorization: `Bearer ${signedJWT}` });
			this.cache.set(key, {
				expiration: exp * 1e3,
				headers
			});
			return headers;
		}
		/**
		* Returns an expiration time for the JWT token.
		*
		* @param iat The issued at time for the JWT.
		* @returns An expiration time for the JWT.
		*/
		static getExpirationTime(iat) {
			return iat + 3600;
		}
		/**
		* Create a JWTAccess credentials instance using the given input options.
		* @param json The input object.
		*/
		fromJSON(json) {
			if (!json) {throw new Error("Must pass in a JSON object containing the service account auth settings.");}
			if (!json.client_email) {throw new Error("The incoming JSON object does not contain a client_email field");}
			if (!json.private_key) {throw new Error("The incoming JSON object does not contain a private_key field");}
			this.email = json.client_email;
			this.key = json.private_key;
			this.keyId = json.private_key_id;
			this.projectId = json.project_id;
		}
		fromStream(inputStream, callback) {
			if (callback) {this.fromStreamAsync(inputStream).then(() => callback(), callback);}
			else {return this.fromStreamAsync(inputStream);}
		}
		fromStreamAsync(inputStream) {
			return new Promise((resolve, reject) => {
				if (!inputStream) {reject(/* @__PURE__ */ new Error("Must pass in a stream containing the service account auth settings."));}
				let s = "";
				inputStream.setEncoding("utf8").on("data", (chunk) => s += chunk).on("error", reject).on("end", () => {
					try {
						const data = JSON.parse(s);
						this.fromJSON(data);
						resolve();
					} catch (err) {
						reject(err);
					}
				});
			});
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/jwtclient.js
var require_jwtclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.JWT = void 0;
	const googleToken_1 = require_googleToken();
	const getCredentials_1 = require_getCredentials();
	const jwtaccess_1 = require_jwtaccess();
	const oauth2client_1 = require_oauth2client();
	const authclient_1 = require_authclient();
	exports.JWT = class JWT extends oauth2client_1.OAuth2Client {
		email;
		keyFile;
		key;
		keyId;
		defaultScopes;
		scopes;
		scope;
		subject;
		gtoken;
		additionalClaims;
		useJWTAccessWithScope;
		defaultServicePath;
		access;
		/**
		* JWT service account credentials.
		*
		* Retrieve access token using gtoken.
		*
		* @param options the
		*/
		constructor(options = {}) {
			super(options);
			this.email = options.email;
			this.keyFile = options.keyFile;
			this.key = options.key;
			this.keyId = options.keyId;
			this.scopes = options.scopes;
			this.subject = options.subject;
			this.additionalClaims = options.additionalClaims;
			this.credentials = {
				refresh_token: "jwt-placeholder",
				expiry_date: 1
			};
		}
		/**
		* Creates a copy of the credential with the specified scopes.
		* @param scopes List of requested scopes or a single scope.
		* @return The cloned instance.
		*/
		createScoped(scopes) {
			const jwt = new JWT(this);
			jwt.scopes = scopes;
			return jwt;
		}
		/**
		* Obtains the metadata to be sent with the request.
		*
		* @param url the URI being authorized.
		*/
		async getRequestMetadataAsync(url) {
			url = this.defaultServicePath ? `https://${this.defaultServicePath}/` : url;
			const useSelfSignedJWT = !this.hasUserScopes() && url || this.useJWTAccessWithScope && this.hasAnyScopes() || this.universeDomain !== authclient_1.DEFAULT_UNIVERSE;
			if (this.subject && this.universeDomain !== authclient_1.DEFAULT_UNIVERSE) {throw new RangeError(`Service Account user is configured for the credential. Domain-wide delegation is not supported in universes other than ${authclient_1.DEFAULT_UNIVERSE}`);}
			if (!this.apiKey && useSelfSignedJWT) {if (this.additionalClaims && this.additionalClaims.target_audience) {
				const { tokens } = await this.refreshToken();
				return { headers: this.addSharedMetadataHeaders(new Headers({ authorization: `Bearer ${tokens.id_token}` })) };
			} else {
				if (!this.access) this.access = new jwtaccess_1.JWTAccess(this.email, this.key, this.keyId, this.eagerRefreshThresholdMillis);
				let scopes;
				if (this.hasUserScopes()) scopes = this.scopes;
				else if (!url) scopes = this.defaultScopes;
				const useScopes = this.useJWTAccessWithScope || this.universeDomain !== authclient_1.DEFAULT_UNIVERSE;
				const headers = await this.access.getRequestHeaders(url ?? void 0, this.additionalClaims, useScopes ? scopes : void 0);
				return { headers: this.addSharedMetadataHeaders(headers) };
			}}
			else if (this.hasAnyScopes() || this.apiKey) {return super.getRequestMetadataAsync(url);}
			else {return { headers: new Headers() };}
		}
		/**
		* Fetches an ID token.
		* @param targetAudience the audience for the fetched ID token.
		*/
		async fetchIdToken(targetAudience) {
			const gtoken = new googleToken_1.GoogleToken({
				iss: this.email,
				sub: this.subject,
				scope: this.scopes || this.defaultScopes,
				keyFile: this.keyFile,
				key: this.key,
				additionalClaims: { target_audience: targetAudience },
				transporter: this.transporter
			});
			await gtoken.getToken({ forceRefresh: true });
			if (!gtoken.idToken) {throw new Error("Unknown error: Failed to fetch ID token");}
			return gtoken.idToken;
		}
		/**
		* Determine if there are currently scopes available.
		*/
		hasUserScopes() {
			if (!this.scopes) {return false;}
			return this.scopes.length > 0;
		}
		/**
		* Are there any default or user scopes defined.
		*/
		hasAnyScopes() {
			if (this.scopes && this.scopes.length > 0) {return true;}
			if (this.defaultScopes && this.defaultScopes.length > 0) {return true;}
			return false;
		}
		authorize(callback) {
			if (callback) {this.authorizeAsync().then((r) => callback(null, r), callback);}
			else {return this.authorizeAsync();}
		}
		async authorizeAsync() {
			const result = await this.refreshToken();
			if (!result) {throw new Error("No result returned");}
			this.credentials = result.tokens;
			this.credentials.refresh_token = "jwt-placeholder";
			this.key = this.gtoken.googleTokenOptions?.key;
			this.email = this.gtoken.googleTokenOptions?.iss;
			return result.tokens;
		}
		/**
		* Refreshes the access token.
		* @param refreshToken ignored
		* @private
		*/
		async refreshTokenNoCache() {
			const gtoken = this.createGToken();
			const tokens = {
				access_token: (await gtoken.getToken({ forceRefresh: this.isTokenExpiring() })).access_token,
				token_type: "Bearer",
				expiry_date: gtoken.expiresAt,
				id_token: gtoken.idToken
			};
			this.emit("tokens", tokens);
			return {
				res: null,
				tokens
			};
		}
		/**
		* Create a gToken if it doesn't already exist.
		*/
		createGToken() {
			if (!this.gtoken) {this.gtoken = new googleToken_1.GoogleToken({
				iss: this.email,
				sub: this.subject,
				scope: this.scopes || this.defaultScopes,
				keyFile: this.keyFile,
				key: this.key,
				additionalClaims: this.additionalClaims,
				transporter: this.transporter
			});}
			return this.gtoken;
		}
		/**
		* Create a JWT credentials instance using the given input options.
		* @param json The input object.
		*
		* @remarks
		*
		* **Important**: If you accept a credential configuration (credential JSON/File/Stream) from an external source for authentication to Google Cloud, you must validate it before providing it to any Google API or library. Providing an unvalidated credential configuration to Google APIs can compromise the security of your systems and data. For more information, refer to {@link https://cloud.google.com/docs/authentication/external/externally-sourced-credentials Validate credential configurations from external sources}.
		*/
		fromJSON(json) {
			if (!json) {throw new Error("Must pass in a JSON object containing the service account auth settings.");}
			if (!json.client_email) {throw new Error("The incoming JSON object does not contain a client_email field");}
			if (!json.private_key) {throw new Error("The incoming JSON object does not contain a private_key field");}
			this.email = json.client_email;
			this.key = json.private_key;
			this.keyId = json.private_key_id;
			this.projectId = json.project_id;
			this.quotaProjectId = json.quota_project_id;
			this.universeDomain = json.universe_domain || this.universeDomain;
		}
		fromStream(inputStream, callback) {
			if (callback) {this.fromStreamAsync(inputStream).then(() => callback(), callback);}
			else {return this.fromStreamAsync(inputStream);}
		}
		fromStreamAsync(inputStream) {
			return new Promise((resolve, reject) => {
				if (!inputStream) {throw new Error("Must pass in a stream containing the service account auth settings.");}
				let s = "";
				inputStream.setEncoding("utf8").on("error", reject).on("data", (chunk) => s += chunk).on("end", () => {
					try {
						const data = JSON.parse(s);
						this.fromJSON(data);
						resolve();
					} catch (e) {
						reject(e);
					}
				});
			});
		}
		/**
		* Creates a JWT credentials instance using an API Key for authentication.
		* @param apiKey The API Key in string form.
		*/
		fromAPIKey(apiKey) {
			if (typeof apiKey !== "string") {throw new Error("Must provide an API Key string.");}
			this.apiKey = apiKey;
		}
		/**
		* Using the key or keyFile on the JWT client, obtain an object that contains
		* the key and the client email.
		*/
		async getCredentials() {
			if (this.key) {return {
				private_key: this.key,
				client_email: this.email
			};}
			else if (this.keyFile) {
				this.createGToken();
				const creds = await (0, getCredentials_1.getCredentials)(this.keyFile);
				return {
					private_key: creds.privateKey,
					client_email: creds.clientEmail
				};
			}
			throw new Error("A key or a keyFile must be provided to getCredentials.");
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/refreshclient.js
var require_refreshclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.UserRefreshClient = exports.USER_REFRESH_ACCOUNT_TYPE = void 0;
	const oauth2client_1 = require_oauth2client();
	const authclient_1 = require_authclient();
	exports.USER_REFRESH_ACCOUNT_TYPE = "authorized_user";
	exports.UserRefreshClient = class UserRefreshClient extends oauth2client_1.OAuth2Client {
		_refreshToken;
		/**
		* The User Refresh Token client.
		*
		* @param optionsOrClientId The User Refresh Token client options. Passing an `clientId` directly is **@DEPRECATED**.
		* @param clientSecret **@DEPRECATED**. Provide a {@link UserRefreshClientOptions `UserRefreshClientOptions`} object in the first parameter instead.
		* @param refreshToken **@DEPRECATED**. Provide a {@link UserRefreshClientOptions `UserRefreshClientOptions`} object in the first parameter instead.
		* @param eagerRefreshThresholdMillis **@DEPRECATED**. Provide a {@link UserRefreshClientOptions `UserRefreshClientOptions`} object in the first parameter instead.
		* @param forceRefreshOnFailure **@DEPRECATED**. Provide a {@link UserRefreshClientOptions `UserRefreshClientOptions`} object in the first parameter instead.
		*/
		constructor(optionsOrClientId, clientSecret, refreshToken, eagerRefreshThresholdMillis, forceRefreshOnFailure) {
			const opts = optionsOrClientId && typeof optionsOrClientId === "object" ? optionsOrClientId : {
				clientId: optionsOrClientId,
				clientSecret,
				refreshToken,
				eagerRefreshThresholdMillis,
				forceRefreshOnFailure
			};
			super(opts);
			this._refreshToken = opts.refreshToken;
			this.credentials.refresh_token = opts.refreshToken;
		}
		/**
		* Refreshes the access token.
		* @param refreshToken An ignored refreshToken..
		* @param callback Optional callback.
		*/
		async refreshTokenNoCache() {
			return super.refreshTokenNoCache(this._refreshToken);
		}
		async fetchIdToken(targetAudience) {
			const opts = {
				...UserRefreshClient.RETRY_CONFIG,
				url: this.endpoints.oauth2TokenUrl,
				method: "POST",
				data: new URLSearchParams({
					client_id: this._clientId,
					client_secret: this._clientSecret,
					grant_type: "refresh_token",
					refresh_token: this._refreshToken,
					target_audience: targetAudience
				}),
				responseType: "json"
			};
			authclient_1.AuthClient.setMethodName(opts, "fetchIdToken");
			return (await this.transporter.request(opts)).data.id_token;
		}
		/**
		* Create a UserRefreshClient credentials instance using the given input
		* options.
		* @param json The input object.
		*/
		fromJSON(json) {
			if (!json) {throw new Error("Must pass in a JSON object containing the user refresh token");}
			if (json.type !== "authorized_user") {throw new Error("The incoming JSON object does not have the \"authorized_user\" type");}
			if (!json.client_id) {throw new Error("The incoming JSON object does not contain a client_id field");}
			if (!json.client_secret) {throw new Error("The incoming JSON object does not contain a client_secret field");}
			if (!json.refresh_token) {throw new Error("The incoming JSON object does not contain a refresh_token field");}
			this._clientId = json.client_id;
			this._clientSecret = json.client_secret;
			this._refreshToken = json.refresh_token;
			this.credentials.refresh_token = json.refresh_token;
			this.quotaProjectId = json.quota_project_id;
			this.universeDomain = json.universe_domain || this.universeDomain;
		}
		fromStream(inputStream, callback) {
			if (callback) {this.fromStreamAsync(inputStream).then(() => callback(), callback);}
			else {return this.fromStreamAsync(inputStream);}
		}
		async fromStreamAsync(inputStream) {
			return new Promise((resolve, reject) => {
				if (!inputStream) {return reject(/* @__PURE__ */ new Error("Must pass in a stream containing the user refresh token."));}
				let s = "";
				inputStream.setEncoding("utf8").on("error", reject).on("data", (chunk) => s += chunk).on("end", () => {
					try {
						const data = JSON.parse(s);
						this.fromJSON(data);
						return resolve();
					} catch (err) {
						return reject(err);
					}
				});
			});
		}
		/**
		* Create a UserRefreshClient credentials instance using the given input
		* options.
		* @param json The input object.
		*/
		static fromJSON(json) {
			const client = new UserRefreshClient();
			client.fromJSON(json);
			return client;
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/impersonated.js
var require_impersonated = /* @__PURE__ */ __commonJSMin(((exports) => {
	/**
	* Copyright 2021 Google LLC
	*
	* Licensed under the Apache License, Version 2.0 (the "License");
	* you may not use this file except in compliance with the License.
	* You may obtain a copy of the License at
	*
	*      http://www.apache.org/licenses/LICENSE-2.0
	*
	* Unless required by applicable law or agreed to in writing, software
	* distributed under the License is distributed on an "AS IS" BASIS,
	* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
	* See the License for the specific language governing permissions and
	* limitations under the License.
	*/
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Impersonated = exports.IMPERSONATED_ACCOUNT_TYPE = void 0;
	const oauth2client_1 = require_oauth2client();
	const gaxios_1$9 = __require("gaxios");
	const util_1 = require_util();
	exports.IMPERSONATED_ACCOUNT_TYPE = "impersonated_service_account";
	exports.Impersonated = class Impersonated extends oauth2client_1.OAuth2Client {
		sourceClient;
		targetPrincipal;
		targetScopes;
		delegates;
		lifetime;
		endpoint;
		/**
		* Impersonated service account credentials.
		*
		* Create a new access token by impersonating another service account.
		*
		* Impersonated Credentials allowing credentials issued to a user or
		* service account to impersonate another. The source project using
		* Impersonated Credentials must enable the "IAMCredentials" API.
		* Also, the target service account must grant the orginating principal
		* the "Service Account Token Creator" IAM role.
		*
		* **IMPORTANT**: This method does not validate the credential configuration.
		* A security risk occurs when a credential configuration configured with
		* malicious URLs is used. When the credential configuration is accepted from
		* an untrusted source, you should validate it before using it with this
		* method. For more details, see
		* https://cloud.google.com/docs/authentication/external/externally-sourced-credentials.
		*
		* @param {object} options - The configuration object.
		* @param {object} [options.sourceClient] the source credential used as to
		* acquire the impersonated credentials.
		* @param {string} [options.targetPrincipal] the service account to
		* impersonate.
		* @param {string[]} [options.delegates] the chained list of delegates
		* required to grant the final access_token. If set, the sequence of
		* identities must have "Service Account Token Creator" capability granted to
		* the preceding identity. For example, if set to [serviceAccountB,
		* serviceAccountC], the sourceCredential must have the Token Creator role on
		* serviceAccountB. serviceAccountB must have the Token Creator on
		* serviceAccountC. Finally, C must have Token Creator on target_principal.
		* If left unset, sourceCredential must have that role on targetPrincipal.
		* @param {string[]} [options.targetScopes] scopes to request during the
		* authorization grant.
		* @param {number} [options.lifetime] number of seconds the delegated
		* credential should be valid for up to 3600 seconds by default, or 43,200
		* seconds by extending the token's lifetime, see:
		* https://cloud.google.com/iam/docs/creating-short-lived-service-account-credentials#sa-credentials-oauth
		* @param {string} [options.endpoint] api endpoint override.
		*/
		constructor(options = {}) {
			super(options);
			this.credentials = {
				expiry_date: 1,
				refresh_token: "impersonated-placeholder"
			};
			this.sourceClient = options.sourceClient ?? new oauth2client_1.OAuth2Client();
			this.targetPrincipal = options.targetPrincipal ?? "";
			this.delegates = options.delegates ?? [];
			this.targetScopes = options.targetScopes ?? [];
			this.lifetime = options.lifetime ?? 3600;
			if (!!!(0, util_1.originalOrCamelOptions)(options).get("universe_domain")) {this.universeDomain = this.sourceClient.universeDomain;}
			else if (this.sourceClient.universeDomain !== this.universeDomain) {throw new RangeError(`Universe domain ${this.sourceClient.universeDomain} in source credentials does not match ${this.universeDomain} universe domain set for impersonated credentials.`);}
			this.endpoint = options.endpoint ?? `https://iamcredentials.${this.universeDomain}`;
		}
		/**
		* Signs some bytes.
		*
		* {@link https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/signBlob Reference Documentation}
		* @param blobToSign String to sign.
		*
		* @returns A {@link SignBlobResponse} denoting the keyID and signedBlob in base64 string
		*/
		async sign(blobToSign) {
			await this.sourceClient.getAccessToken();
			const name = `projects/-/serviceAccounts/${this.targetPrincipal}`;
			const u = `${this.endpoint}/v1/${name}:signBlob`;
			const body = {
				delegates: this.delegates,
				payload: Buffer.from(blobToSign).toString("base64")
			};
			return (await this.sourceClient.request({
				...Impersonated.RETRY_CONFIG,
				url: u,
				data: body,
				method: "POST"
			})).data;
		}
		/** The service account email to be impersonated. */
		getTargetPrincipal() {
			return this.targetPrincipal;
		}
		/**
		* Refreshes the access token.
		*/
		async refreshToken() {
			try {
				await this.sourceClient.getAccessToken();
				const name = "projects/-/serviceAccounts/" + this.targetPrincipal;
				const u = `${this.endpoint}/v1/${name}:generateAccessToken`;
				const body = {
					delegates: this.delegates,
					scope: this.targetScopes,
					lifetime: this.lifetime + "s"
				};
				const res = await this.sourceClient.request({
					...Impersonated.RETRY_CONFIG,
					url: u,
					data: body,
					method: "POST"
				});
				const tokenResponse = res.data;
				this.credentials.access_token = tokenResponse.accessToken;
				this.credentials.expiry_date = Date.parse(tokenResponse.expireTime);
				return {
					tokens: this.credentials,
					res
				};
			} catch (error) {
				if (!(error instanceof Error)) {throw error;}
				let status = 0;
				let message = "";
				if (error instanceof gaxios_1$9.GaxiosError) {
					status = error?.response?.data?.error?.status;
					message = error?.response?.data?.error?.message;
				}
				if (status && message) {
					error.message = `${status}: unable to impersonate: ${message}`;
					throw error;
				} else {
					error.message = `unable to impersonate: ${error}`;
					throw error;
				}
			}
		}
		/**
		* Generates an OpenID Connect ID token for a service account.
		*
		* {@link https://cloud.google.com/iam/docs/reference/credentials/rest/v1/projects.serviceAccounts/generateIdToken Reference Documentation}
		*
		* @param targetAudience the audience for the fetched ID token.
		* @param options the for the request
		* @return an OpenID Connect ID token
		*/
		async fetchIdToken(targetAudience, options) {
			await this.sourceClient.getAccessToken();
			const name = `projects/-/serviceAccounts/${this.targetPrincipal}`;
			const u = `${this.endpoint}/v1/${name}:generateIdToken`;
			const body = {
				delegates: this.delegates,
				audience: targetAudience,
				includeEmail: options?.includeEmail ?? true,
				useEmailAzp: options?.includeEmail ?? true
			};
			return (await this.sourceClient.request({
				...Impersonated.RETRY_CONFIG,
				url: u,
				data: body,
				method: "POST"
			})).data.token;
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/oauth2common.js
var require_oauth2common = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.OAuthClientAuthHandler = void 0;
	exports.getErrorFromOAuthErrorResponse = getErrorFromOAuthErrorResponse;
	const gaxios_1$8 = __require("gaxios");
	const crypto_1 = require_crypto();
	/** List of HTTP methods that accept request bodies. */
	const METHODS_SUPPORTING_REQUEST_BODY = new Set([
		"PUT",
		"POST",
		"PATCH"
	]);
	/**
	* Abstract class for handling client authentication in OAuth-based
	* operations.
	* When request-body client authentication is used, only application/json and
	* application/x-www-form-urlencoded content types for HTTP methods that support
	* request bodies are supported.
	*/
	var OAuthClientAuthHandler = class {
		#crypto = (0, crypto_1.createCrypto)();
		#clientAuthentication;
		transporter;
		/**
		* Instantiates an OAuth client authentication handler.
		* @param options The OAuth Client Auth Handler instance options. Passing an `ClientAuthentication` directly is **@DEPRECATED**.
		*/
		constructor(options) {
			if (options && "clientId" in options) {
				this.#clientAuthentication = options;
				this.transporter = new gaxios_1$8.Gaxios();
			} else {
				this.#clientAuthentication = options?.clientAuthentication;
				this.transporter = options?.transporter || new gaxios_1$8.Gaxios();
			}
		}
		/**
		* Applies client authentication on the OAuth request's headers or POST
		* body but does not process the request.
		* @param opts The GaxiosOptions whose headers or data are to be modified
		*   depending on the client authentication mechanism to be used.
		* @param bearerToken The optional bearer token to use for authentication.
		*   When this is used, no client authentication credentials are needed.
		*/
		applyClientAuthenticationOptions(opts, bearerToken) {
			opts.headers = gaxios_1$8.Gaxios.mergeHeaders(opts.headers);
			this.injectAuthenticatedHeaders(opts, bearerToken);
			if (!bearerToken) this.injectAuthenticatedRequestBody(opts);
		}
		/**
		* Applies client authentication on the request's header if either
		* basic authentication or bearer token authentication is selected.
		*
		* @param opts The GaxiosOptions whose headers or data are to be modified
		*   depending on the client authentication mechanism to be used.
		* @param bearerToken The optional bearer token to use for authentication.
		*   When this is used, no client authentication credentials are needed.
		*/
		injectAuthenticatedHeaders(opts, bearerToken) {
			if (bearerToken) opts.headers = gaxios_1$8.Gaxios.mergeHeaders(opts.headers, { authorization: `Bearer ${bearerToken}` });
			else if (this.#clientAuthentication?.confidentialClientType === "basic") {
				opts.headers = gaxios_1$8.Gaxios.mergeHeaders(opts.headers);
				const clientId = this.#clientAuthentication.clientId;
				const clientSecret = this.#clientAuthentication.clientSecret || "";
				const base64EncodedCreds = this.#crypto.encodeBase64StringUtf8(`${clientId}:${clientSecret}`);
				gaxios_1$8.Gaxios.mergeHeaders(opts.headers, { authorization: `Basic ${base64EncodedCreds}` });
			}
		}
		/**
		* Applies client authentication on the request's body if request-body
		* client authentication is selected.
		*
		* @param opts The GaxiosOptions whose headers or data are to be modified
		*   depending on the client authentication mechanism to be used.
		*/
		injectAuthenticatedRequestBody(opts) {
			if (this.#clientAuthentication?.confidentialClientType === "request-body") {
				const method = (opts.method || "GET").toUpperCase();
				if (!METHODS_SUPPORTING_REQUEST_BODY.has(method)) {throw new Error(`${method} HTTP method does not support ${this.#clientAuthentication.confidentialClientType} client authentication`);}
				const contentType = new Headers(opts.headers).get("content-type");
				if (contentType?.startsWith("application/x-www-form-urlencoded") || opts.data instanceof URLSearchParams) {
					const data = new URLSearchParams(opts.data ?? "");
					data.append("client_id", this.#clientAuthentication.clientId);
					data.append("client_secret", this.#clientAuthentication.clientSecret || "");
					opts.data = data;
				} else if (contentType?.startsWith("application/json")) {
					opts.data = opts.data || {};
					Object.assign(opts.data, {
						client_id: this.#clientAuthentication.clientId,
						client_secret: this.#clientAuthentication.clientSecret || ""
					});
				} else {throw new Error(`${contentType} content-types are not supported with ${this.#clientAuthentication.confidentialClientType} client authentication`);}
			}
		}
		/**
		* Retry config for Auth-related requests.
		*
		* @remarks
		*
		* This is not a part of the default {@link AuthClient.transporter transporter/gaxios}
		* config as some downstream APIs would prefer if customers explicitly enable retries,
		* such as GCS.
		*/
		static get RETRY_CONFIG() {
			return {
				retry: true,
				retryConfig: { httpMethodsToRetry: [
					"GET",
					"PUT",
					"POST",
					"HEAD",
					"OPTIONS",
					"DELETE"
				] }
			};
		}
	};
	exports.OAuthClientAuthHandler = OAuthClientAuthHandler;
	/**
	* Converts an OAuth error response to a native JavaScript Error.
	* @param resp The OAuth error response to convert to a native Error object.
	* @param err The optional original error. If provided, the error properties
	*   will be copied to the new error.
	* @return The converted native Error object.
	*/
	function getErrorFromOAuthErrorResponse(resp, err) {
		const errorCode = resp.error;
		const errorDescription = resp.error_description;
		const errorUri = resp.error_uri;
		let message = `Error code ${errorCode}`;
		if (typeof errorDescription !== "undefined") {message += `: ${errorDescription}`;}
		if (typeof errorUri !== "undefined") {message += ` - ${errorUri}`;}
		const newError = new Error(message);
		if (err) {
			const keys = Object.keys(err);
			if (err.stack) {keys.push("stack");}
			keys.forEach((key) => {
				if (key !== "message") {Object.defineProperty(newError, key, {
					value: err[key],
					writable: false,
					enumerable: true
				});}
			});
		}
		return newError;
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/stscredentials.js
var require_stscredentials = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.StsCredentials = void 0;
	const gaxios_1$7 = __require("gaxios");
	const authclient_1 = require_authclient();
	const oauth2common_1 = require_oauth2common();
	const util_1 = require_util();
	exports.StsCredentials = class StsCredentials extends oauth2common_1.OAuthClientAuthHandler {
		#tokenExchangeEndpoint;
		/**
		* Initializes an STS credentials instance.
		*
		* @param options The STS credentials instance options. Passing an `tokenExchangeEndpoint` directly is **@DEPRECATED**.
		* @param clientAuthentication **@DEPRECATED**. Provide a {@link StsCredentialsConstructionOptions `StsCredentialsConstructionOptions`} object in the first parameter instead.
		*/
		constructor(options = { tokenExchangeEndpoint: "" }, clientAuthentication) {
			if (typeof options !== "object" || options instanceof URL) {options = {
				tokenExchangeEndpoint: options,
				clientAuthentication
			};}
			super(options);
			this.#tokenExchangeEndpoint = options.tokenExchangeEndpoint;
		}
		/**
		* Exchanges the provided token for another type of token based on the
		* rfc8693 spec.
		* @param stsCredentialsOptions The token exchange options used to populate
		*   the token exchange request.
		* @param additionalHeaders Optional additional headers to pass along the
		*   request.
		* @param options Optional additional GCP-specific non-spec defined options
		*   to send with the request.
		*   Example: `&options=${encodeUriComponent(JSON.stringified(options))}`
		* @return A promise that resolves with the token exchange response containing
		*   the requested token and its expiration time.
		*/
		async exchangeToken(stsCredentialsOptions, headers, options) {
			const values = {
				grant_type: stsCredentialsOptions.grantType,
				resource: stsCredentialsOptions.resource,
				audience: stsCredentialsOptions.audience,
				scope: stsCredentialsOptions.scope?.join(" "),
				requested_token_type: stsCredentialsOptions.requestedTokenType,
				subject_token: stsCredentialsOptions.subjectToken,
				subject_token_type: stsCredentialsOptions.subjectTokenType,
				actor_token: stsCredentialsOptions.actingParty?.actorToken,
				actor_token_type: stsCredentialsOptions.actingParty?.actorTokenType,
				options: options && JSON.stringify(options)
			};
			const opts = {
				...StsCredentials.RETRY_CONFIG,
				url: this.#tokenExchangeEndpoint.toString(),
				method: "POST",
				headers,
				data: new URLSearchParams((0, util_1.removeUndefinedValuesInObject)(values)),
				responseType: "json"
			};
			authclient_1.AuthClient.setMethodName(opts, "exchangeToken");
			this.applyClientAuthenticationOptions(opts);
			try {
				const response = await this.transporter.request(opts);
				const stsSuccessfulResponse = response.data;
				stsSuccessfulResponse.res = response;
				return stsSuccessfulResponse;
			} catch (error) {
				if (error instanceof gaxios_1$7.GaxiosError && error.response) {throw (0, oauth2common_1.getErrorFromOAuthErrorResponse)(error.response.data, error);}
				throw error;
			}
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/baseexternalclient.js
var require_baseexternalclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.BaseExternalAccountClient = exports.CLOUD_RESOURCE_MANAGER = exports.EXTERNAL_ACCOUNT_TYPE = exports.EXPIRATION_TIME_OFFSET = void 0;
	const gaxios_1$6 = __require("gaxios");
	const stream$2 = __require("stream");
	const authclient_1 = require_authclient();
	const sts = require_stscredentials();
	const util_1 = require_util();
	const shared_cjs_1 = require_shared();
	/**
	* The required token exchange grant_type: rfc8693#section-2.1
	*/
	const STS_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
	/**
	* The requested token exchange requested_token_type: rfc8693#section-2.1
	*/
	const STS_REQUEST_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
	/** The default OAuth scope to request when none is provided. */
	const DEFAULT_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
	/** Default impersonated token lifespan in seconds.*/
	const DEFAULT_TOKEN_LIFESPAN = 3600;
	/**
	* Offset to take into account network delays and server clock skews.
	*/
	exports.EXPIRATION_TIME_OFFSET = 300 * 1e3;
	/**
	* The credentials JSON file type for external account clients.
	* There are 3 types of JSON configs:
	* 1. authorized_user => Google end user credential
	* 2. service_account => Google service account credential
	* 3. external_Account => non-GCP service (eg. AWS, Azure, K8s)
	*/
	exports.EXTERNAL_ACCOUNT_TYPE = "external_account";
	/**
	* Cloud resource manager URL used to retrieve project information.
	*
	* @deprecated use {@link BaseExternalAccountClient.cloudResourceManagerURL} instead
	**/
	exports.CLOUD_RESOURCE_MANAGER = "https://cloudresourcemanager.googleapis.com/v1/projects/";
	/** The workforce audience pattern. */
	const WORKFORCE_AUDIENCE_PATTERN = "//iam\\.googleapis\\.com/locations/[^/]+/workforcePools/[^/]+/providers/.+";
	const DEFAULT_TOKEN_URL = "https://sts.{universeDomain}/v1/token";
	exports.BaseExternalAccountClient = class BaseExternalAccountClient extends authclient_1.AuthClient {
		/**
		* OAuth scopes for the GCP access token to use. When not provided,
		* the default https://www.googleapis.com/auth/cloud-platform is
		* used.
		*/
		scopes;
		projectNumber;
		audience;
		subjectTokenType;
		stsCredential;
		clientAuth;
		credentialSourceType;
		cachedAccessToken;
		serviceAccountImpersonationUrl;
		serviceAccountImpersonationLifetime;
		workforcePoolUserProject;
		configLifetimeRequested;
		tokenUrl;
		/**
		* @example
		* ```ts
		* new URL('https://cloudresourcemanager.googleapis.com/v1/projects/');
		* ```
		*/
		cloudResourceManagerURL;
		supplierContext;
		/**
		* A pending access token request. Used for concurrent calls.
		*/
		#pendingAccessToken = null;
		/**
		* Instantiate a BaseExternalAccountClient instance using the provided JSON
		* object loaded from an external account credentials file.
		* @param options The external account options object typically loaded
		*   from the external account JSON credential file. The camelCased options
		*   are aliases for the snake_cased options.
		*/
		constructor(options) {
			super(options);
			const opts = (0, util_1.originalOrCamelOptions)(options);
			const type = opts.get("type");
			if (type && type !== exports.EXTERNAL_ACCOUNT_TYPE) {throw new Error(`Expected "${exports.EXTERNAL_ACCOUNT_TYPE}" type but received "${options.type}"`);}
			const clientId = opts.get("client_id");
			const clientSecret = opts.get("client_secret");
			this.tokenUrl = opts.get("token_url") ?? DEFAULT_TOKEN_URL.replace("{universeDomain}", this.universeDomain);
			const subjectTokenType = opts.get("subject_token_type");
			const workforcePoolUserProject = opts.get("workforce_pool_user_project");
			const serviceAccountImpersonationUrl = opts.get("service_account_impersonation_url");
			const serviceAccountImpersonation = opts.get("service_account_impersonation");
			const serviceAccountImpersonationLifetime = (0, util_1.originalOrCamelOptions)(serviceAccountImpersonation).get("token_lifetime_seconds");
			this.cloudResourceManagerURL = new URL(opts.get("cloud_resource_manager_url") || `https://cloudresourcemanager.${this.universeDomain}/v1/projects/`);
			if (clientId) {this.clientAuth = {
				confidentialClientType: "basic",
				clientId,
				clientSecret
			};}
			this.stsCredential = new sts.StsCredentials({
				tokenExchangeEndpoint: this.tokenUrl,
				clientAuthentication: this.clientAuth
			});
			this.scopes = opts.get("scopes") || [DEFAULT_OAUTH_SCOPE];
			this.cachedAccessToken = null;
			this.audience = opts.get("audience");
			this.subjectTokenType = subjectTokenType;
			this.workforcePoolUserProject = workforcePoolUserProject;
			const workforceAudiencePattern = new RegExp(WORKFORCE_AUDIENCE_PATTERN);
			if (this.workforcePoolUserProject && !this.audience.match(workforceAudiencePattern)) {throw new Error("workforcePoolUserProject should not be set for non-workforce pool credentials.");}
			this.serviceAccountImpersonationUrl = serviceAccountImpersonationUrl;
			this.serviceAccountImpersonationLifetime = serviceAccountImpersonationLifetime;
			if (this.serviceAccountImpersonationLifetime) {this.configLifetimeRequested = true;}
			else {
				this.configLifetimeRequested = false;
				this.serviceAccountImpersonationLifetime = DEFAULT_TOKEN_LIFESPAN;
			}
			this.projectNumber = this.getProjectNumber(this.audience);
			this.supplierContext = {
				audience: this.audience,
				subjectTokenType: this.subjectTokenType,
				transporter: this.transporter
			};
		}
		/** The service account email to be impersonated, if available. */
		getServiceAccountEmail() {
			if (this.serviceAccountImpersonationUrl) {
				if (this.serviceAccountImpersonationUrl.length > 256)
 /**
				* Prevents DOS attacks.
				* @see {@link https://github.com/googleapis/google-auth-library-nodejs/security/code-scanning/84}
				**/
				{throw new RangeError(`URL is too long: ${this.serviceAccountImpersonationUrl}`);}
				return /serviceAccounts\/(?<email>[^:]+):generateAccessToken$/.exec(this.serviceAccountImpersonationUrl)?.groups?.email || null;
			}
			return null;
		}
		/**
		* Provides a mechanism to inject GCP access tokens directly.
		* When the provided credential expires, a new credential, using the
		* external account options, is retrieved.
		* @param credentials The Credentials object to set on the current client.
		*/
		setCredentials(credentials) {
			super.setCredentials(credentials);
			this.cachedAccessToken = credentials;
		}
		/**
		* @return A promise that resolves with the current GCP access token
		*   response. If the current credential is expired, a new one is retrieved.
		*/
		async getAccessToken() {
			if (!this.cachedAccessToken || this.isExpired(this.cachedAccessToken)) {await this.refreshAccessTokenAsync();}
			return {
				token: this.cachedAccessToken.access_token,
				res: this.cachedAccessToken.res
			};
		}
		/**
		* The main authentication interface. It takes an optional url which when
		* present is the endpoint being accessed, and returns a Promise which
		* resolves with authorization header fields.
		*
		* The result has the form:
		* { authorization: 'Bearer <access_token_value>' }
		*/
		async getRequestHeaders() {
			const accessTokenResponse = await this.getAccessToken();
			const headers = new Headers({ authorization: `Bearer ${accessTokenResponse.token}` });
			return this.addSharedMetadataHeaders(headers);
		}
		request(opts, callback) {
			if (callback) {this.requestAsync(opts).then((r) => callback(null, r), (e) => {
				return callback(e, e.response);
			});}
			else {return this.requestAsync(opts);}
		}
		/**
		* @return A promise that resolves with the project ID corresponding to the
		*   current workload identity pool or current workforce pool if
		*   determinable. For workforce pool credential, it returns the project ID
		*   corresponding to the workforcePoolUserProject.
		*   This is introduced to match the current pattern of using the Auth
		*   library:
		*   const projectId = await auth.getProjectId();
		*   const url = `https://dns.googleapis.com/dns/v1/projects/${projectId}`;
		*   const res = await client.request({ url });
		*   The resource may not have permission
		*   (resourcemanager.projects.get) to call this API or the required
		*   scopes may not be selected:
		*   https://cloud.google.com/resource-manager/reference/rest/v1/projects/get#authorization-scopes
		*/
		async getProjectId() {
			const projectNumber = this.projectNumber || this.workforcePoolUserProject;
			if (this.projectId) {return this.projectId;}
			else if (projectNumber) {
				const headers = await this.getRequestHeaders();
				const opts = {
					...BaseExternalAccountClient.RETRY_CONFIG,
					headers,
					url: `${this.cloudResourceManagerURL.toString()}${projectNumber}`,
					responseType: "json"
				};
				authclient_1.AuthClient.setMethodName(opts, "getProjectId");
				this.projectId = (await this.transporter.request(opts)).data.projectId;
				return this.projectId;
			}
			return null;
		}
		/**
		* Authenticates the provided HTTP request, processes it and resolves with the
		* returned response.
		* @param opts The HTTP request options.
		* @param reAuthRetried Whether the current attempt is a retry after a failed attempt due to an auth failure.
		* @return A promise that resolves with the successful response.
		*/
		async requestAsync(opts, reAuthRetried = false) {
			let response;
			try {
				const requestHeaders = await this.getRequestHeaders();
				opts.headers = gaxios_1$6.Gaxios.mergeHeaders(opts.headers);
				this.addUserProjectAndAuthHeaders(opts.headers, requestHeaders);
				response = await this.transporter.request(opts);
			} catch (e) {
				const res = e.response;
				if (res) {
					const statusCode = res.status;
					const isReadableStream = res.config.data instanceof stream$2.Readable;
					if (!reAuthRetried && (statusCode === 401 || statusCode === 403) && !isReadableStream && this.forceRefreshOnFailure) {
						await this.refreshAccessTokenAsync();
						return await this.requestAsync(opts, true);
					}
				}
				throw e;
			}
			return response;
		}
		/**
		* Forces token refresh, even if unexpired tokens are currently cached.
		* External credentials are exchanged for GCP access tokens via the token
		* exchange endpoint and other settings provided in the client options
		* object.
		* If the service_account_impersonation_url is provided, an additional
		* step to exchange the external account GCP access token for a service
		* account impersonated token is performed.
		* @return A promise that resolves with the fresh GCP access tokens.
		*/
		async refreshAccessTokenAsync() {
			this.#pendingAccessToken = this.#pendingAccessToken || this.#internalRefreshAccessTokenAsync();
			try {
				return await this.#pendingAccessToken;
			} finally {
				this.#pendingAccessToken = null;
			}
		}
		async #internalRefreshAccessTokenAsync() {
			const subjectToken = await this.retrieveSubjectToken();
			const stsCredentialsOptions = {
				grantType: STS_GRANT_TYPE,
				audience: this.audience,
				requestedTokenType: STS_REQUEST_TOKEN_TYPE,
				subjectToken,
				subjectTokenType: this.subjectTokenType,
				scope: this.serviceAccountImpersonationUrl ? [DEFAULT_OAUTH_SCOPE] : this.getScopesArray()
			};
			const additionalOptions = !this.clientAuth && this.workforcePoolUserProject ? { userProject: this.workforcePoolUserProject } : void 0;
			const additionalHeaders = new Headers({ "x-goog-api-client": this.getMetricsHeaderValue() });
			const stsResponse = await this.stsCredential.exchangeToken(stsCredentialsOptions, additionalHeaders, additionalOptions);
			if (this.serviceAccountImpersonationUrl) {this.cachedAccessToken = await this.getImpersonatedAccessToken(stsResponse.access_token);}
			else if (stsResponse.expires_in) {this.cachedAccessToken = {
				access_token: stsResponse.access_token,
				expiry_date: (/* @__PURE__ */ new Date()).getTime() + stsResponse.expires_in * 1e3,
				res: stsResponse.res
			};}
			else {this.cachedAccessToken = {
				access_token: stsResponse.access_token,
				res: stsResponse.res
			};}
			this.credentials = {};
			Object.assign(this.credentials, this.cachedAccessToken);
			delete this.credentials.res;
			this.emit("tokens", {
				refresh_token: null,
				expiry_date: this.cachedAccessToken.expiry_date,
				access_token: this.cachedAccessToken.access_token,
				token_type: "Bearer",
				id_token: null
			});
			return this.cachedAccessToken;
		}
		/**
		* Returns the workload identity pool project number if it is determinable
		* from the audience resource name.
		* @param audience The STS audience used to determine the project number.
		* @return The project number associated with the workload identity pool, if
		*   this can be determined from the STS audience field. Otherwise, null is
		*   returned.
		*/
		getProjectNumber(audience) {
			const match = audience.match(/\/projects\/([^/]+)/);
			if (!match) {return null;}
			return match[1];
		}
		/**
		* Exchanges an external account GCP access token for a service
		* account impersonated access token using iamcredentials
		* GenerateAccessToken API.
		* @param token The access token to exchange for a service account access
		*   token.
		* @return A promise that resolves with the service account impersonated
		*   credentials response.
		*/
		async getImpersonatedAccessToken(token) {
			const opts = {
				...BaseExternalAccountClient.RETRY_CONFIG,
				url: this.serviceAccountImpersonationUrl,
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${token}`
				},
				data: {
					scope: this.getScopesArray(),
					lifetime: this.serviceAccountImpersonationLifetime + "s"
				},
				responseType: "json"
			};
			authclient_1.AuthClient.setMethodName(opts, "getImpersonatedAccessToken");
			const response = await this.transporter.request(opts);
			const successResponse = response.data;
			return {
				access_token: successResponse.accessToken,
				expiry_date: new Date(successResponse.expireTime).getTime(),
				res: response
			};
		}
		/**
		* Returns whether the provided credentials are expired or not.
		* If there is no expiry time, assumes the token is not expired or expiring.
		* @param accessToken The credentials to check for expiration.
		* @return Whether the credentials are expired or not.
		*/
		isExpired(accessToken) {
			const now = (/* @__PURE__ */ new Date()).getTime();
			return accessToken.expiry_date ? now >= accessToken.expiry_date - this.eagerRefreshThresholdMillis : false;
		}
		/**
		* @return The list of scopes for the requested GCP access token.
		*/
		getScopesArray() {
			if (typeof this.scopes === "string") {return [this.scopes];}
			return this.scopes || [DEFAULT_OAUTH_SCOPE];
		}
		getMetricsHeaderValue() {
			const nodeVersion = process.version.replace(/^v/, "");
			const saImpersonation = this.serviceAccountImpersonationUrl !== void 0;
			const credentialSourceType = this.credentialSourceType ? this.credentialSourceType : "unknown";
			return `gl-node/${nodeVersion} auth/${shared_cjs_1.pkg.version} google-byoid-sdk source/${credentialSourceType} sa-impersonation/${saImpersonation} config-lifetime/${this.configLifetimeRequested}`;
		}
		getTokenUrl() {
			return this.tokenUrl;
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/filesubjecttokensupplier.js
var require_filesubjecttokensupplier = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.FileSubjectTokenSupplier = void 0;
	const util_1 = __require("util");
	const fs$3 = __require("fs");
	const readFile = (0, util_1.promisify)(fs$3.readFile ?? (() => {}));
	const realpath = (0, util_1.promisify)(fs$3.realpath ?? (() => {}));
	const lstat = (0, util_1.promisify)(fs$3.lstat ?? (() => {}));
	/**
	* Internal subject token supplier implementation used when a file location
	* is configured in the credential configuration used to build an {@link IdentityPoolClient}
	*/
	var FileSubjectTokenSupplier = class {
		filePath;
		formatType;
		subjectTokenFieldName;
		/**
		* Instantiates a new file based subject token supplier.
		* @param opts The file subject token supplier options to build the supplier
		*   with.
		*/
		constructor(opts) {
			this.filePath = opts.filePath;
			this.formatType = opts.formatType;
			this.subjectTokenFieldName = opts.subjectTokenFieldName;
		}
		/**
		* Returns the subject token stored at the file specified in the constructor.
		* @param context {@link ExternalAccountSupplierContext} from the calling
		*   {@link IdentityPoolClient}, contains the requested audience and subject
		*   token type for the external account identity. Not used.
		*/
		async getSubjectToken() {
			let parsedFilePath = this.filePath;
			try {
				parsedFilePath = await realpath(parsedFilePath);
				if (!(await lstat(parsedFilePath)).isFile()) {throw new Error();}
			} catch (err) {
				if (err instanceof Error) {err.message = `The file at ${parsedFilePath} does not exist, or it is not a file. ${err.message}`;}
				throw err;
			}
			let subjectToken;
			const rawText = await readFile(parsedFilePath, { encoding: "utf8" });
			if (this.formatType === "text") {subjectToken = rawText;}
			else if (this.formatType === "json" && this.subjectTokenFieldName) {subjectToken = JSON.parse(rawText)[this.subjectTokenFieldName];}
			if (!subjectToken) {throw new Error("Unable to parse the subject_token from the credential_source file");}
			return subjectToken;
		}
	};
	exports.FileSubjectTokenSupplier = FileSubjectTokenSupplier;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/urlsubjecttokensupplier.js
var require_urlsubjecttokensupplier = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.UrlSubjectTokenSupplier = void 0;
	const authclient_1 = require_authclient();
	/**
	* Internal subject token supplier implementation used when a URL
	* is configured in the credential configuration used to build an {@link IdentityPoolClient}
	*/
	var UrlSubjectTokenSupplier = class {
		url;
		headers;
		formatType;
		subjectTokenFieldName;
		additionalGaxiosOptions;
		/**
		* Instantiates a URL subject token supplier.
		* @param opts The URL subject token supplier options to build the supplier with.
		*/
		constructor(opts) {
			this.url = opts.url;
			this.formatType = opts.formatType;
			this.subjectTokenFieldName = opts.subjectTokenFieldName;
			this.headers = opts.headers;
			this.additionalGaxiosOptions = opts.additionalGaxiosOptions;
		}
		/**
		* Sends a GET request to the URL provided in the constructor and resolves
		* with the returned external subject token.
		* @param context {@link ExternalAccountSupplierContext} from the calling
		*   {@link IdentityPoolClient}, contains the requested audience and subject
		*   token type for the external account identity. Not used.
		*/
		async getSubjectToken(context) {
			const opts = {
				...this.additionalGaxiosOptions,
				url: this.url,
				method: "GET",
				headers: this.headers,
				responseType: this.formatType
			};
			authclient_1.AuthClient.setMethodName(opts, "getSubjectToken");
			let subjectToken;
			if (this.formatType === "text") {subjectToken = (await context.transporter.request(opts)).data;}
			else if (this.formatType === "json" && this.subjectTokenFieldName) {subjectToken = (await context.transporter.request(opts)).data[this.subjectTokenFieldName];}
			if (!subjectToken) {throw new Error("Unable to parse the subject_token from the credential_source URL");}
			return subjectToken;
		}
	};
	exports.UrlSubjectTokenSupplier = UrlSubjectTokenSupplier;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/certificatesubjecttokensupplier.js
var require_certificatesubjecttokensupplier = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CertificateSubjectTokenSupplier = exports.InvalidConfigurationError = exports.CertificateSourceUnavailableError = exports.CERTIFICATE_CONFIGURATION_ENV_VARIABLE = void 0;
	const util_1 = require_util();
	const fs$2 = __require("fs");
	const crypto_1 = __require("crypto");
	const https = __require("https");
	exports.CERTIFICATE_CONFIGURATION_ENV_VARIABLE = "GOOGLE_API_CERTIFICATE_CONFIG";
	/**
	* Thrown when the certificate source cannot be located or accessed.
	*/
	var CertificateSourceUnavailableError = class extends Error {
		constructor(message) {
			super(message);
			this.name = "CertificateSourceUnavailableError";
		}
	};
	exports.CertificateSourceUnavailableError = CertificateSourceUnavailableError;
	/**
	* Thrown for invalid configuration that is not related to file availability.
	*/
	var InvalidConfigurationError = class extends Error {
		constructor(message) {
			super(message);
			this.name = "InvalidConfigurationError";
		}
	};
	exports.InvalidConfigurationError = InvalidConfigurationError;
	/**
	* A subject token supplier that uses a client certificate for authentication.
	* It provides the certificate chain as the subject token for identity federation.
	*/
	var CertificateSubjectTokenSupplier = class {
		certificateConfigPath;
		trustChainPath;
		cert;
		key;
		/**
		* Initializes a new instance of the CertificateSubjectTokenSupplier.
		* @param opts The configuration options for the supplier.
		*/
		constructor(opts) {
			if (!opts.useDefaultCertificateConfig && !opts.certificateConfigLocation) {throw new InvalidConfigurationError("Either `useDefaultCertificateConfig` must be true or a `certificateConfigLocation` must be provided.");}
			if (opts.useDefaultCertificateConfig && opts.certificateConfigLocation) {throw new InvalidConfigurationError("Both `useDefaultCertificateConfig` and `certificateConfigLocation` cannot be provided.");}
			this.trustChainPath = opts.trustChainPath;
			this.certificateConfigPath = opts.certificateConfigLocation ?? "";
		}
		/**
		* Creates an HTTPS agent configured with the client certificate and private key for mTLS.
		* @returns An mTLS-configured https.Agent.
		*/
		async createMtlsHttpsAgent() {
			if (!this.key || !this.cert) {throw new InvalidConfigurationError("Cannot create mTLS Agent with missing certificate or key");}
			return new https.Agent({
				key: this.key,
				cert: this.cert
			});
		}
		/**
		* Constructs the subject token, which is the base64-encoded certificate chain.
		* @returns A promise that resolves with the subject token.
		*/
		async getSubjectToken() {
			this.certificateConfigPath = await this.#resolveCertificateConfigFilePath();
			const { certPath, keyPath } = await this.#getCertAndKeyPaths();
			({cert: this.cert, key: this.key} = await this.#getKeyAndCert(certPath, keyPath));
			return await this.#processChainFromPaths(this.cert);
		}
		/**
		* Resolves the absolute path to the certificate configuration file
		* by checking the "certificate_config_location" provided in the ADC file,
		* or the "GOOGLE_API_CERTIFICATE_CONFIG" environment variable
		* or in the default gcloud path.
		* @param overridePath An optional path to check first.
		* @returns The resolved file path.
		*/
		async #resolveCertificateConfigFilePath() {
			const overridePath = this.certificateConfigPath;
			if (overridePath) {
				if (await (0, util_1.isValidFile)(overridePath)) {return overridePath;}
				throw new CertificateSourceUnavailableError(`Provided certificate config path is invalid: ${overridePath}`);
			}
			const envPath = process.env[exports.CERTIFICATE_CONFIGURATION_ENV_VARIABLE];
			if (envPath) {
				if (await (0, util_1.isValidFile)(envPath)) {return envPath;}
				throw new CertificateSourceUnavailableError(`Path from environment variable "${exports.CERTIFICATE_CONFIGURATION_ENV_VARIABLE}" is invalid: ${envPath}`);
			}
			const wellKnownPath = (0, util_1.getWellKnownCertificateConfigFileLocation)();
			if (await (0, util_1.isValidFile)(wellKnownPath)) {return wellKnownPath;}
			throw new CertificateSourceUnavailableError(`Could not find certificate configuration file. Searched override path, the "${exports.CERTIFICATE_CONFIGURATION_ENV_VARIABLE}" env var, and the gcloud path (${wellKnownPath}).`);
		}
		/**
		* Reads and parses the certificate config JSON file to extract the certificate and key paths.
		* @returns An object containing the certificate and key paths.
		*/
		async #getCertAndKeyPaths() {
			const configPath = this.certificateConfigPath;
			let fileContents;
			try {
				fileContents = await fs$2.promises.readFile(configPath, "utf8");
			} catch (err) {
				throw new CertificateSourceUnavailableError(`Failed to read certificate config file at: ${configPath}`);
			}
			try {
				const config = JSON.parse(fileContents);
				const certPath = config?.cert_configs?.workload?.cert_path;
				const keyPath = config?.cert_configs?.workload?.key_path;
				if (!certPath || !keyPath) {throw new InvalidConfigurationError(`Certificate config file (${configPath}) is missing required "cert_path" or "key_path" in the workload config.`);}
				return {
					certPath,
					keyPath
				};
			} catch (e) {
				if (e instanceof InvalidConfigurationError) {throw e;}
				throw new InvalidConfigurationError(`Failed to parse certificate config from ${configPath}: ${e.message}`);
			}
		}
		/**
		* Reads and parses the cert and key files get their content and check valid format.
		* @returns An object containing the cert content and key content in buffer format.
		*/
		async #getKeyAndCert(certPath, keyPath) {
			let cert, key;
			try {
				cert = await fs$2.promises.readFile(certPath);
				new crypto_1.X509Certificate(cert);
			} catch (err) {
				throw new CertificateSourceUnavailableError(`Failed to read certificate file at ${certPath}: ${err instanceof Error ? err.message : String(err)}`);
			}
			try {
				key = await fs$2.promises.readFile(keyPath);
				(0, crypto_1.createPrivateKey)(key);
			} catch (err) {
				throw new CertificateSourceUnavailableError(`Failed to read private key file at ${keyPath}: ${err instanceof Error ? err.message : String(err)}`);
			}
			return {
				cert,
				key
			};
		}
		/**
		* Reads the leaf certificate and trust chain, combines them,
		* and returns a JSON array of base64-encoded certificates.
		* @returns A stringified JSON array of the certificate chain.
		*/
		async #processChainFromPaths(leafCertBuffer) {
			const leafCert = new crypto_1.X509Certificate(leafCertBuffer);
			if (!this.trustChainPath) {return JSON.stringify([leafCert.raw.toString("base64")]);}
			try {
				const chainCerts = ((await fs$2.promises.readFile(this.trustChainPath, "utf8")).match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? []).map((pem, index) => {
					try {
						return new crypto_1.X509Certificate(pem);
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err);
						throw new InvalidConfigurationError(`Failed to parse certificate at index ${index} in trust chain file ${this.trustChainPath}: ${message}`);
					}
				});
				const leafIndex = chainCerts.findIndex((chainCert) => leafCert.raw.equals(chainCert.raw));
				let finalChain;
				if (leafIndex === -1) {finalChain = [leafCert, ...chainCerts];}
				else if (leafIndex === 0) {finalChain = chainCerts;}
				else {throw new InvalidConfigurationError(`Leaf certificate exists in the trust chain but is not the first entry (found at index ${leafIndex}).`);}
				return JSON.stringify(finalChain.map((cert) => cert.raw.toString("base64")));
			} catch (err) {
				if (err instanceof InvalidConfigurationError) {throw err;}
				const message = err instanceof Error ? err.message : String(err);
				throw new CertificateSourceUnavailableError(`Failed to process certificate chain from ${this.trustChainPath}: ${message}`);
			}
		}
	};
	exports.CertificateSubjectTokenSupplier = CertificateSubjectTokenSupplier;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/identitypoolclient.js
var require_identitypoolclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.IdentityPoolClient = void 0;
	const baseexternalclient_1 = require_baseexternalclient();
	const util_1 = require_util();
	const filesubjecttokensupplier_1 = require_filesubjecttokensupplier();
	const urlsubjecttokensupplier_1 = require_urlsubjecttokensupplier();
	const certificatesubjecttokensupplier_1 = require_certificatesubjecttokensupplier();
	const stscredentials_1 = require_stscredentials();
	const gaxios_1$5 = __require("gaxios");
	exports.IdentityPoolClient = class IdentityPoolClient extends baseexternalclient_1.BaseExternalAccountClient {
		subjectTokenSupplier;
		/**
		* Instantiate an IdentityPoolClient instance using the provided JSON
		* object loaded from an external account credentials file.
		* An error is thrown if the credential is not a valid file-sourced or
		* url-sourced credential or a workforce pool user project is provided
		* with a non workforce audience.
		* @param options The external account options object typically loaded
		*   from the external account JSON credential file. The camelCased options
		*   are aliases for the snake_cased options.
		*/
		constructor(options) {
			super(options);
			const opts = (0, util_1.originalOrCamelOptions)(options);
			const credentialSource = opts.get("credential_source");
			const subjectTokenSupplier = opts.get("subject_token_supplier");
			if (!credentialSource && !subjectTokenSupplier) {throw new Error("A credential source or subject token supplier must be specified.");}
			if (credentialSource && subjectTokenSupplier) {throw new Error("Only one of credential source or subject token supplier can be specified.");}
			if (subjectTokenSupplier) {
				this.subjectTokenSupplier = subjectTokenSupplier;
				this.credentialSourceType = "programmatic";
			} else {
				const credentialSourceOpts = (0, util_1.originalOrCamelOptions)(credentialSource);
				const formatOpts = (0, util_1.originalOrCamelOptions)(credentialSourceOpts.get("format"));
				const formatType = formatOpts.get("type") || "text";
				const formatSubjectTokenFieldName = formatOpts.get("subject_token_field_name");
				if (formatType !== "json" && formatType !== "text") {throw new Error(`Invalid credential_source format "${formatType}"`);}
				if (formatType === "json" && !formatSubjectTokenFieldName) {throw new Error("Missing subject_token_field_name for JSON credential_source format");}
				const file = credentialSourceOpts.get("file");
				const url = credentialSourceOpts.get("url");
				const certificate = credentialSourceOpts.get("certificate");
				const headers = credentialSourceOpts.get("headers");
				if (file && url || url && certificate || file && certificate) {throw new Error("No valid Identity Pool \"credential_source\" provided, must be either file, url, or certificate.");}
				else if (file) {
					this.credentialSourceType = "file";
					this.subjectTokenSupplier = new filesubjecttokensupplier_1.FileSubjectTokenSupplier({
						filePath: file,
						formatType,
						subjectTokenFieldName: formatSubjectTokenFieldName
					});
				} else if (url) {
					this.credentialSourceType = "url";
					this.subjectTokenSupplier = new urlsubjecttokensupplier_1.UrlSubjectTokenSupplier({
						url,
						formatType,
						subjectTokenFieldName: formatSubjectTokenFieldName,
						headers,
						additionalGaxiosOptions: IdentityPoolClient.RETRY_CONFIG
					});
				} else if (certificate) {
					this.credentialSourceType = "certificate";
					this.subjectTokenSupplier = new certificatesubjecttokensupplier_1.CertificateSubjectTokenSupplier({
						useDefaultCertificateConfig: certificate.use_default_certificate_config,
						certificateConfigLocation: certificate.certificate_config_location,
						trustChainPath: certificate.trust_chain_path
					});
				} else {throw new Error("No valid Identity Pool \"credential_source\" provided, must be either file, url, or certificate.");}
			}
		}
		/**
		* Triggered when a external subject token is needed to be exchanged for a GCP
		* access token via GCP STS endpoint. Gets a subject token by calling
		* the configured {@link SubjectTokenSupplier}
		* @return A promise that resolves with the external subject token.
		*/
		async retrieveSubjectToken() {
			const subjectToken = await this.subjectTokenSupplier.getSubjectToken(this.supplierContext);
			if (this.subjectTokenSupplier instanceof certificatesubjecttokensupplier_1.CertificateSubjectTokenSupplier) {
				const mtlsAgent = await this.subjectTokenSupplier.createMtlsHttpsAgent();
				this.stsCredential = new stscredentials_1.StsCredentials({
					tokenExchangeEndpoint: this.getTokenUrl(),
					clientAuthentication: this.clientAuth,
					transporter: new gaxios_1$5.Gaxios({ agent: mtlsAgent })
				});
				this.transporter = new gaxios_1$5.Gaxios({
					...this.transporter.defaults,
					agent: mtlsAgent
				});
			}
			return subjectToken;
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/awsrequestsigner.js
var require_awsrequestsigner = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.AwsRequestSigner = void 0;
	const gaxios_1$4 = __require("gaxios");
	const crypto_1 = require_crypto();
	/** AWS Signature Version 4 signing algorithm identifier.  */
	const AWS_ALGORITHM = "AWS4-HMAC-SHA256";
	/**
	* The termination string for the AWS credential scope value as defined in
	* https://docs.aws.amazon.com/general/latest/gr/sigv4-create-string-to-sign.html
	*/
	const AWS_REQUEST_TYPE = "aws4_request";
	/**
	* Implements an AWS API request signer based on the AWS Signature Version 4
	* signing process.
	* https://docs.aws.amazon.com/general/latest/gr/signature-version-4.html
	*/
	var AwsRequestSigner = class {
		getCredentials;
		region;
		crypto;
		/**
		* Instantiates an AWS API request signer used to send authenticated signed
		* requests to AWS APIs based on the AWS Signature Version 4 signing process.
		* This also provides a mechanism to generate the signed request without
		* sending it.
		* @param getCredentials A mechanism to retrieve AWS security credentials
		*   when needed.
		* @param region The AWS region to use.
		*/
		constructor(getCredentials, region) {
			this.getCredentials = getCredentials;
			this.region = region;
			this.crypto = (0, crypto_1.createCrypto)();
		}
		/**
		* Generates the signed request for the provided HTTP request for calling
		* an AWS API. This follows the steps described at:
		* https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
		* @param amzOptions The AWS request options that need to be signed.
		* @return A promise that resolves with the GaxiosOptions containing the
		*   signed HTTP request parameters.
		*/
		async getRequestOptions(amzOptions) {
			if (!amzOptions.url) {throw new RangeError("\"url\" is required in \"amzOptions\"");}
			const requestPayloadData = typeof amzOptions.data === "object" ? JSON.stringify(amzOptions.data) : amzOptions.data;
			const url = amzOptions.url;
			const method = amzOptions.method || "GET";
			const requestPayload = amzOptions.body || requestPayloadData;
			const additionalAmzHeaders = amzOptions.headers;
			const awsSecurityCredentials = await this.getCredentials();
			const uri = new URL(url);
			if (typeof requestPayload !== "string" && requestPayload !== void 0) {throw new TypeError(`'requestPayload' is expected to be a string if provided. Got: ${requestPayload}`);}
			const headerMap = await generateAuthenticationHeaderMap({
				crypto: this.crypto,
				host: uri.host,
				canonicalUri: uri.pathname,
				canonicalQuerystring: uri.search.slice(1),
				method,
				region: this.region,
				securityCredentials: awsSecurityCredentials,
				requestPayload,
				additionalAmzHeaders
			});
			const headers = gaxios_1$4.Gaxios.mergeHeaders(headerMap.amzDate ? { "x-amz-date": headerMap.amzDate } : {}, {
				authorization: headerMap.authorizationHeader,
				host: uri.host
			}, additionalAmzHeaders || {});
			if (awsSecurityCredentials.token) {gaxios_1$4.Gaxios.mergeHeaders(headers, { "x-amz-security-token": awsSecurityCredentials.token });}
			const awsSignedReq = {
				url,
				method,
				headers
			};
			if (requestPayload !== void 0) {awsSignedReq.body = requestPayload;}
			return awsSignedReq;
		}
	};
	exports.AwsRequestSigner = AwsRequestSigner;
	/**
	* Creates the HMAC-SHA256 hash of the provided message using the
	* provided key.
	*
	* @param crypto The crypto instance used to facilitate cryptographic
	*   operations.
	* @param key The HMAC-SHA256 key to use.
	* @param msg The message to hash.
	* @return The computed hash bytes.
	*/
	async function sign(crypto, key, msg) {
		return await crypto.signWithHmacSha256(key, msg);
	}
	/**
	* Calculates the signing key used to calculate the signature for
	* AWS Signature Version 4 based on:
	* https://docs.aws.amazon.com/general/latest/gr/sigv4-calculate-signature.html
	*
	* @param crypto The crypto instance used to facilitate cryptographic
	*   operations.
	* @param key The AWS secret access key.
	* @param dateStamp The '%Y%m%d' date format.
	* @param region The AWS region.
	* @param serviceName The AWS service name, eg. sts.
	* @return The signing key bytes.
	*/
	async function getSigningKey(crypto, key, dateStamp, region, serviceName) {
		return await sign(crypto, await sign(crypto, await sign(crypto, await sign(crypto, `AWS4${key}`, dateStamp), region), serviceName), "aws4_request");
	}
	/**
	* Generates the authentication header map needed for generating the AWS
	* Signature Version 4 signed request.
	*
	* @param option The options needed to compute the authentication header map.
	* @return The AWS authentication header map which constitutes of the following
	*   components: amz-date, authorization header and canonical query string.
	*/
	async function generateAuthenticationHeaderMap(options) {
		const additionalAmzHeaders = gaxios_1$4.Gaxios.mergeHeaders(options.additionalAmzHeaders);
		const requestPayload = options.requestPayload || "";
		const serviceName = options.host.split(".")[0];
		const now = /* @__PURE__ */ new Date();
		const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.[0-9]+/, "");
		const dateStamp = now.toISOString().replace(/[-]/g, "").replace(/T.*/, "");
		if (options.securityCredentials.token) {additionalAmzHeaders.set("x-amz-security-token", options.securityCredentials.token);}
		const amzHeaders = gaxios_1$4.Gaxios.mergeHeaders({ host: options.host }, additionalAmzHeaders.has("date") ? {} : { "x-amz-date": amzDate }, additionalAmzHeaders);
		let canonicalHeaders = "";
		const signedHeadersList = [...amzHeaders.keys()].toSorted();
		signedHeadersList.forEach((key) => {
			canonicalHeaders += `${key}:${amzHeaders.get(key)}\n`;
		});
		const signedHeaders = signedHeadersList.join(";");
		const payloadHash = await options.crypto.sha256DigestHex(requestPayload);
		const canonicalRequest = `${options.method.toUpperCase()}\n${options.canonicalUri}\n${options.canonicalQuerystring}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
		const credentialScope = `${dateStamp}/${options.region}/${serviceName}/${AWS_REQUEST_TYPE}`;
		const stringToSign = `${AWS_ALGORITHM}\n${amzDate}\n${credentialScope}\n` + await options.crypto.sha256DigestHex(canonicalRequest);
		const signingKey = await getSigningKey(options.crypto, options.securityCredentials.secretAccessKey, dateStamp, options.region, serviceName);
		const signature = await sign(options.crypto, signingKey, stringToSign);
		const authorizationHeader = `${AWS_ALGORITHM} Credential=${options.securityCredentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${(0, crypto_1.fromArrayBufferToHex)(signature)}`;
		return {
			amzDate: additionalAmzHeaders.has("date") ? void 0 : amzDate,
			authorizationHeader,
			canonicalQuerystring: options.canonicalQuerystring
		};
	}
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/defaultawssecuritycredentialssupplier.js
var require_defaultawssecuritycredentialssupplier = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.DefaultAwsSecurityCredentialsSupplier = void 0;
	const authclient_1 = require_authclient();
	/**
	* Internal AWS security credentials supplier implementation used by {@link AwsClient}
	* when a credential source is provided instead of a user defined supplier.
	* The logic is summarized as:
	* 1. If imdsv2_session_token_url is provided in the credential source, then
	*    fetch the aws session token and include it in the headers of the
	*    metadata requests. This is a requirement for IDMSv2 but optional
	*    for IDMSv1.
	* 2. Retrieve AWS region from availability-zone.
	* 3a. Check AWS credentials in environment variables. If not found, get
	*     from security-credentials endpoint.
	* 3b. Get AWS credentials from security-credentials endpoint. In order
	*     to retrieve this, the AWS role needs to be determined by calling
	*     security-credentials endpoint without any argument. Then the
	*     credentials can be retrieved via: security-credentials/role_name
	* 4. Generate the signed request to AWS STS GetCallerIdentity action.
	* 5. Inject x-goog-cloud-target-resource into header and serialize the
	*    signed request. This will be the subject-token to pass to GCP STS.
	*/
	var DefaultAwsSecurityCredentialsSupplier = class {
		regionUrl;
		securityCredentialsUrl;
		imdsV2SessionTokenUrl;
		additionalGaxiosOptions;
		/**
		* Instantiates a new DefaultAwsSecurityCredentialsSupplier using information
		* from the credential_source stored in the ADC file.
		* @param opts The default aws security credentials supplier options object to
		*   build the supplier with.
		*/
		constructor(opts) {
			this.regionUrl = opts.regionUrl;
			this.securityCredentialsUrl = opts.securityCredentialsUrl;
			this.imdsV2SessionTokenUrl = opts.imdsV2SessionTokenUrl;
			this.additionalGaxiosOptions = opts.additionalGaxiosOptions;
		}
		/**
		* Returns the active AWS region. This first checks to see if the region
		* is available as an environment variable. If it is not, then the supplier
		* will call the region URL.
		* @param context {@link ExternalAccountSupplierContext} from the calling
		*   {@link AwsClient}, contains the requested audience and subject token type
		*   for the external account identity.
		* @return A promise that resolves with the AWS region string.
		*/
		async getAwsRegion(context) {
			if (this.#regionFromEnv) {return this.#regionFromEnv;}
			const metadataHeaders = new Headers();
			if (!this.#regionFromEnv && this.imdsV2SessionTokenUrl) {metadataHeaders.set("x-aws-ec2-metadata-token", await this.#getImdsV2SessionToken(context.transporter));}
			if (!this.regionUrl) {throw new RangeError("Unable to determine AWS region due to missing \"options.credential_source.region_url\"");}
			const opts = {
				...this.additionalGaxiosOptions,
				url: this.regionUrl,
				method: "GET",
				responseType: "text",
				headers: metadataHeaders
			};
			authclient_1.AuthClient.setMethodName(opts, "getAwsRegion");
			const response = await context.transporter.request(opts);
			return response.data.substr(0, response.data.length - 1);
		}
		/**
		* Returns AWS security credentials. This first checks to see if the credentials
		* is available as environment variables. If it is not, then the supplier
		* will call the security credentials URL.
		* @param context {@link ExternalAccountSupplierContext} from the calling
		*   {@link AwsClient}, contains the requested audience and subject token type
		*   for the external account identity.
		* @return A promise that resolves with the AWS security credentials.
		*/
		async getAwsSecurityCredentials(context) {
			if (this.#securityCredentialsFromEnv) {return this.#securityCredentialsFromEnv;}
			const metadataHeaders = new Headers();
			if (this.imdsV2SessionTokenUrl) {metadataHeaders.set("x-aws-ec2-metadata-token", await this.#getImdsV2SessionToken(context.transporter));}
			const roleName = await this.#getAwsRoleName(metadataHeaders, context.transporter);
			const awsCreds = await this.#retrieveAwsSecurityCredentials(roleName, metadataHeaders, context.transporter);
			return {
				accessKeyId: awsCreds.AccessKeyId,
				secretAccessKey: awsCreds.SecretAccessKey,
				token: awsCreds.Token
			};
		}
		/**
		* @param transporter The transporter to use for requests.
		* @return A promise that resolves with the IMDSv2 Session Token.
		*/
		async #getImdsV2SessionToken(transporter) {
			const opts = {
				...this.additionalGaxiosOptions,
				url: this.imdsV2SessionTokenUrl,
				method: "PUT",
				responseType: "text",
				headers: { "x-aws-ec2-metadata-token-ttl-seconds": "300" }
			};
			authclient_1.AuthClient.setMethodName(opts, "#getImdsV2SessionToken");
			return (await transporter.request(opts)).data;
		}
		/**
		* @param headers The headers to be used in the metadata request.
		* @param transporter The transporter to use for requests.
		* @return A promise that resolves with the assigned role to the current
		*   AWS VM. This is needed for calling the security-credentials endpoint.
		*/
		async #getAwsRoleName(headers, transporter) {
			if (!this.securityCredentialsUrl) {throw new Error("Unable to determine AWS role name due to missing \"options.credential_source.url\"");}
			const opts = {
				...this.additionalGaxiosOptions,
				url: this.securityCredentialsUrl,
				method: "GET",
				responseType: "text",
				headers
			};
			authclient_1.AuthClient.setMethodName(opts, "#getAwsRoleName");
			return (await transporter.request(opts)).data;
		}
		/**
		* Retrieves the temporary AWS credentials by calling the security-credentials
		* endpoint as specified in the `credential_source` object.
		* @param roleName The role attached to the current VM.
		* @param headers The headers to be used in the metadata request.
		* @param transporter The transporter to use for requests.
		* @return A promise that resolves with the temporary AWS credentials
		*   needed for creating the GetCallerIdentity signed request.
		*/
		async #retrieveAwsSecurityCredentials(roleName, headers, transporter) {
			const opts = {
				...this.additionalGaxiosOptions,
				url: `${this.securityCredentialsUrl}/${roleName}`,
				headers,
				responseType: "json"
			};
			authclient_1.AuthClient.setMethodName(opts, "#retrieveAwsSecurityCredentials");
			return (await transporter.request(opts)).data;
		}
		get #regionFromEnv() {
			return process.env["AWS_REGION"] || process.env["AWS_DEFAULT_REGION"] || null;
		}
		get #securityCredentialsFromEnv() {
			if (process.env["AWS_ACCESS_KEY_ID"] && process.env["AWS_SECRET_ACCESS_KEY"]) {return {
				accessKeyId: process.env["AWS_ACCESS_KEY_ID"],
				secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"],
				token: process.env["AWS_SESSION_TOKEN"]
			};}
			return null;
		}
	};
	exports.DefaultAwsSecurityCredentialsSupplier = DefaultAwsSecurityCredentialsSupplier;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/awsclient.js
var require_awsclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.AwsClient = void 0;
	const awsrequestsigner_1 = require_awsrequestsigner();
	const baseexternalclient_1 = require_baseexternalclient();
	const defaultawssecuritycredentialssupplier_1 = require_defaultawssecuritycredentialssupplier();
	const util_1 = require_util();
	const gaxios_1$3 = __require("gaxios");
	exports.AwsClient = class AwsClient extends baseexternalclient_1.BaseExternalAccountClient {
		environmentId;
		awsSecurityCredentialsSupplier;
		regionalCredVerificationUrl;
		awsRequestSigner;
		region;
		static #DEFAULT_AWS_REGIONAL_CREDENTIAL_VERIFICATION_URL = "https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15";
		/**
		* @deprecated AWS client no validates the EC2 metadata address.
		**/
		static AWS_EC2_METADATA_IPV4_ADDRESS = "169.254.169.254";
		/**
		* @deprecated AWS client no validates the EC2 metadata address.
		**/
		static AWS_EC2_METADATA_IPV6_ADDRESS = "fd00:ec2::254";
		/**
		* Instantiates an AwsClient instance using the provided JSON
		* object loaded from an external account credentials file.
		* An error is thrown if the credential is not a valid AWS credential.
		* @param options The external account options object typically loaded
		*   from the external account JSON credential file.
		*/
		constructor(options) {
			super(options);
			const opts = (0, util_1.originalOrCamelOptions)(options);
			const credentialSource = opts.get("credential_source");
			const awsSecurityCredentialsSupplier = opts.get("aws_security_credentials_supplier");
			if (!credentialSource && !awsSecurityCredentialsSupplier) {throw new Error("A credential source or AWS security credentials supplier must be specified.");}
			if (credentialSource && awsSecurityCredentialsSupplier) {throw new Error("Only one of credential source or AWS security credentials supplier can be specified.");}
			if (awsSecurityCredentialsSupplier) {
				this.awsSecurityCredentialsSupplier = awsSecurityCredentialsSupplier;
				this.regionalCredVerificationUrl = AwsClient.#DEFAULT_AWS_REGIONAL_CREDENTIAL_VERIFICATION_URL;
				this.credentialSourceType = "programmatic";
			} else {
				const credentialSourceOpts = (0, util_1.originalOrCamelOptions)(credentialSource);
				this.environmentId = credentialSourceOpts.get("environment_id");
				const regionUrl = credentialSourceOpts.get("region_url");
				const securityCredentialsUrl = credentialSourceOpts.get("url");
				const imdsV2SessionTokenUrl = credentialSourceOpts.get("imdsv2_session_token_url");
				this.awsSecurityCredentialsSupplier = new defaultawssecuritycredentialssupplier_1.DefaultAwsSecurityCredentialsSupplier({
					regionUrl,
					securityCredentialsUrl,
					imdsV2SessionTokenUrl
				});
				this.regionalCredVerificationUrl = credentialSourceOpts.get("regional_cred_verification_url");
				this.credentialSourceType = "aws";
				this.validateEnvironmentId();
			}
			this.awsRequestSigner = null;
			this.region = "";
		}
		validateEnvironmentId() {
			const match = this.environmentId?.match(/^(aws)(\d+)$/);
			if (!match || !this.regionalCredVerificationUrl) {throw new Error("No valid AWS \"credential_source\" provided");}
			else if (parseInt(match[2], 10) !== 1) {throw new Error(`aws version "${match[2]}" is not supported in the current build.`);}
		}
		/**
		* Triggered when an external subject token is needed to be exchanged for a
		* GCP access token via GCP STS endpoint. This will call the
		* {@link AwsSecurityCredentialsSupplier} to retrieve an AWS region and AWS
		* Security Credentials, then use them to create a signed AWS STS request that
		* can be exchanged for a GCP access token.
		* @return A promise that resolves with the external subject token.
		*/
		async retrieveSubjectToken() {
			if (!this.awsRequestSigner) {
				this.region = await this.awsSecurityCredentialsSupplier.getAwsRegion(this.supplierContext);
				this.awsRequestSigner = new awsrequestsigner_1.AwsRequestSigner(async () => {
					return this.awsSecurityCredentialsSupplier.getAwsSecurityCredentials(this.supplierContext);
				}, this.region);
			}
			const options = await this.awsRequestSigner.getRequestOptions({
				...AwsClient.RETRY_CONFIG,
				url: this.regionalCredVerificationUrl.replace("{region}", this.region),
				method: "POST"
			});
			const reformattedHeader = [];
			gaxios_1$3.Gaxios.mergeHeaders({ "x-goog-cloud-target-resource": this.audience }, options.headers).forEach((value, key) => reformattedHeader.push({
				key,
				value
			}));
			return encodeURIComponent(JSON.stringify({
				url: options.url,
				method: options.method,
				headers: reformattedHeader
			}));
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/executable-response.js
var require_executable_response = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.InvalidSubjectTokenError = exports.InvalidMessageFieldError = exports.InvalidCodeFieldError = exports.InvalidTokenTypeFieldError = exports.InvalidExpirationTimeFieldError = exports.InvalidSuccessFieldError = exports.InvalidVersionFieldError = exports.ExecutableResponseError = exports.ExecutableResponse = void 0;
	const SAML_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:saml2";
	const OIDC_SUBJECT_TOKEN_TYPE1 = "urn:ietf:params:oauth:token-type:id_token";
	const OIDC_SUBJECT_TOKEN_TYPE2 = "urn:ietf:params:oauth:token-type:jwt";
	/**
	* Defines the response of a 3rd party executable run by the pluggable auth client.
	*/
	var ExecutableResponse = class {
		/**
		* The version of the Executable response. Only version 1 is currently supported.
		*/
		version;
		/**
		* Whether the executable ran successfully.
		*/
		success;
		/**
		* The epoch time for expiration of the token in seconds.
		*/
		expirationTime;
		/**
		* The type of subject token in the response, currently supported values are:
		* urn:ietf:params:oauth:token-type:saml2
		* urn:ietf:params:oauth:token-type:id_token
		* urn:ietf:params:oauth:token-type:jwt
		*/
		tokenType;
		/**
		* The error code from the executable.
		*/
		errorCode;
		/**
		* The error message from the executable.
		*/
		errorMessage;
		/**
		* The subject token from the executable, format depends on tokenType.
		*/
		subjectToken;
		/**
		* Instantiates an ExecutableResponse instance using the provided JSON object
		* from the output of the executable.
		* @param responseJson Response from a 3rd party executable, loaded from a
		* run of the executable or a cached output file.
		*/
		constructor(responseJson) {
			if (!responseJson.version) {throw new InvalidVersionFieldError("Executable response must contain a 'version' field.");}
			if (responseJson.success === void 0) {throw new InvalidSuccessFieldError("Executable response must contain a 'success' field.");}
			this.version = responseJson.version;
			this.success = responseJson.success;
			if (this.success) {
				this.expirationTime = responseJson.expiration_time;
				this.tokenType = responseJson.token_type;
				if (this.tokenType !== SAML_SUBJECT_TOKEN_TYPE && this.tokenType !== OIDC_SUBJECT_TOKEN_TYPE1 && this.tokenType !== OIDC_SUBJECT_TOKEN_TYPE2) {throw new InvalidTokenTypeFieldError(`Executable response must contain a 'token_type' field when successful and it must be one of ${OIDC_SUBJECT_TOKEN_TYPE1}, ${OIDC_SUBJECT_TOKEN_TYPE2}, or ${SAML_SUBJECT_TOKEN_TYPE}.`);}
				if (this.tokenType === SAML_SUBJECT_TOKEN_TYPE) {
					if (!responseJson.saml_response) {throw new InvalidSubjectTokenError(`Executable response must contain a 'saml_response' field when token_type=${SAML_SUBJECT_TOKEN_TYPE}.`);}
					this.subjectToken = responseJson.saml_response;
				} else {
					if (!responseJson.id_token) {throw new InvalidSubjectTokenError(`Executable response must contain a 'id_token' field when token_type=${OIDC_SUBJECT_TOKEN_TYPE1} or ${OIDC_SUBJECT_TOKEN_TYPE2}.`);}
					this.subjectToken = responseJson.id_token;
				}
			} else {
				if (!responseJson.code) {throw new InvalidCodeFieldError("Executable response must contain a 'code' field when unsuccessful.");}
				if (!responseJson.message) {throw new InvalidMessageFieldError("Executable response must contain a 'message' field when unsuccessful.");}
				this.errorCode = responseJson.code;
				this.errorMessage = responseJson.message;
			}
		}
		/**
		* @return A boolean representing if the response has a valid token. Returns
		* true when the response was successful and the token is not expired.
		*/
		isValid() {
			return !this.isExpired() && this.success;
		}
		/**
		* @return A boolean representing if the response is expired. Returns true if the
		* provided timeout has passed.
		*/
		isExpired() {
			return this.expirationTime !== void 0 && this.expirationTime < Math.round(Date.now() / 1e3);
		}
	};
	exports.ExecutableResponse = ExecutableResponse;
	/**
	* An error thrown by the ExecutableResponse class.
	*/
	var ExecutableResponseError = class extends Error {
		constructor(message) {
			super(message);
			Object.setPrototypeOf(this, new.target.prototype);
		}
	};
	exports.ExecutableResponseError = ExecutableResponseError;
	/**
	* An error thrown when the 'version' field in an executable response is missing or invalid.
	*/
	var InvalidVersionFieldError = class extends ExecutableResponseError {};
	exports.InvalidVersionFieldError = InvalidVersionFieldError;
	/**
	* An error thrown when the 'success' field in an executable response is missing or invalid.
	*/
	var InvalidSuccessFieldError = class extends ExecutableResponseError {};
	exports.InvalidSuccessFieldError = InvalidSuccessFieldError;
	/**
	* An error thrown when the 'expiration_time' field in an executable response is missing or invalid.
	*/
	var InvalidExpirationTimeFieldError = class extends ExecutableResponseError {};
	exports.InvalidExpirationTimeFieldError = InvalidExpirationTimeFieldError;
	/**
	* An error thrown when the 'token_type' field in an executable response is missing or invalid.
	*/
	var InvalidTokenTypeFieldError = class extends ExecutableResponseError {};
	exports.InvalidTokenTypeFieldError = InvalidTokenTypeFieldError;
	/**
	* An error thrown when the 'code' field in an executable response is missing or invalid.
	*/
	var InvalidCodeFieldError = class extends ExecutableResponseError {};
	exports.InvalidCodeFieldError = InvalidCodeFieldError;
	/**
	* An error thrown when the 'message' field in an executable response is missing or invalid.
	*/
	var InvalidMessageFieldError = class extends ExecutableResponseError {};
	exports.InvalidMessageFieldError = InvalidMessageFieldError;
	/**
	* An error thrown when the subject token in an executable response is missing or invalid.
	*/
	var InvalidSubjectTokenError = class extends ExecutableResponseError {};
	exports.InvalidSubjectTokenError = InvalidSubjectTokenError;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/pluggable-auth-handler.js
var require_pluggable_auth_handler = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PluggableAuthHandler = exports.ExecutableError = void 0;
	const executable_response_1 = require_executable_response();
	const childProcess = __require("child_process");
	const fs$1 = __require("fs");
	/**
	* Error thrown from the executable run by PluggableAuthClient.
	*/
	var ExecutableError = class extends Error {
		/**
		* The exit code returned by the executable.
		*/
		code;
		constructor(message, code) {
			super(`The executable failed with exit code: ${code} and error message: ${message}.`);
			this.code = code;
			Object.setPrototypeOf(this, new.target.prototype);
		}
	};
	exports.ExecutableError = ExecutableError;
	exports.PluggableAuthHandler = class PluggableAuthHandler {
		commandComponents;
		timeoutMillis;
		outputFile;
		/**
		* Instantiates a PluggableAuthHandler instance using the provided
		* PluggableAuthHandlerOptions object.
		*/
		constructor(options) {
			if (!options.command) {throw new Error("No command provided.");}
			this.commandComponents = PluggableAuthHandler.parseCommand(options.command);
			this.timeoutMillis = options.timeoutMillis;
			if (!this.timeoutMillis) {throw new Error("No timeoutMillis provided.");}
			this.outputFile = options.outputFile;
		}
		/**
		* Calls user provided executable to get a 3rd party subject token and
		* returns the response.
		* @param envMap a Map of additional Environment Variables required for
		*   the executable.
		* @return A promise that resolves with the executable response.
		*/
		retrieveResponseFromExecutable(envMap) {
			return new Promise((resolve, reject) => {
				const child = childProcess.spawn(this.commandComponents[0], this.commandComponents.slice(1), { env: {
					...process.env,
					...Object.fromEntries(envMap)
				} });
				let output = "";
				child.stdout.on("data", (data) => {
					output += data;
				});
				child.stderr.on("data", (err) => {
					output += err;
				});
				const timeout = setTimeout(() => {
					child.removeAllListeners();
					child.kill();
					return reject(/* @__PURE__ */ new Error("The executable failed to finish within the timeout specified."));
				}, this.timeoutMillis);
				child.on("close", (code) => {
					clearTimeout(timeout);
					if (code === 0) {try {
						const responseJson = JSON.parse(output);
						return resolve(new executable_response_1.ExecutableResponse(responseJson));
					} catch (error) {
						if (error instanceof executable_response_1.ExecutableResponseError) return reject(error);
						return reject(new executable_response_1.ExecutableResponseError(`The executable returned an invalid response: ${output}`));
					}}
					else {return reject(new ExecutableError(output, code.toString()));}
				});
			});
		}
		/**
		* Checks user provided output file for response from previous run of
		* executable and return the response if it exists, is formatted correctly, and is not expired.
		*/
		async retrieveCachedResponse() {
			if (!this.outputFile || this.outputFile.length === 0) {return;}
			let filePath;
			try {
				filePath = await fs$1.promises.realpath(this.outputFile);
			} catch {
				return;
			}
			if (!(await fs$1.promises.lstat(filePath)).isFile()) {return;}
			const responseString = await fs$1.promises.readFile(filePath, { encoding: "utf8" });
			if (responseString === "") {return;}
			try {
				const responseJson = JSON.parse(responseString);
				if (new executable_response_1.ExecutableResponse(responseJson).isValid()) {return new executable_response_1.ExecutableResponse(responseJson);}
				return;
			} catch (error) {
				if (error instanceof executable_response_1.ExecutableResponseError) {throw error;}
				throw new executable_response_1.ExecutableResponseError(`The output file contained an invalid response: ${responseString}`);
			}
		}
		/**
		* Parses given command string into component array, splitting on spaces unless
		* spaces are between quotation marks.
		*/
		static parseCommand(command) {
			const components = command.match(/(?:[^\s"]+|"[^"]*")+/g);
			if (!components) {throw new Error(`Provided command: "${command}" could not be parsed.`);}
			for (let i = 0; i < components.length; i++) {if (components[i][0] === "\"" && components[i].slice(-1) === "\"") components[i] = components[i].slice(1, -1);}
			return components;
		}
	};
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/pluggable-auth-client.js
var require_pluggable_auth_client = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PluggableAuthClient = exports.ExecutableError = void 0;
	const baseexternalclient_1 = require_baseexternalclient();
	const executable_response_1 = require_executable_response();
	const pluggable_auth_handler_1 = require_pluggable_auth_handler();
	var pluggable_auth_handler_2 = require_pluggable_auth_handler();
	Object.defineProperty(exports, "ExecutableError", {
		enumerable: true,
		get: function() {
			return pluggable_auth_handler_2.ExecutableError;
		}
	});
	/**
	* The default executable timeout when none is provided, in milliseconds.
	*/
	const DEFAULT_EXECUTABLE_TIMEOUT_MILLIS = 30 * 1e3;
	/**
	* The minimum allowed executable timeout in milliseconds.
	*/
	const MINIMUM_EXECUTABLE_TIMEOUT_MILLIS = 5 * 1e3;
	/**
	* The maximum allowed executable timeout in milliseconds.
	*/
	const MAXIMUM_EXECUTABLE_TIMEOUT_MILLIS = 120 * 1e3;
	/**
	* The environment variable to check to see if executable can be run.
	* Value must be set to '1' for the executable to run.
	*/
	const GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES = "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES";
	/**
	* The maximum currently supported executable version.
	*/
	const MAXIMUM_EXECUTABLE_VERSION = 1;
	/**
	* PluggableAuthClient enables the exchange of workload identity pool external credentials for
	* Google access tokens by retrieving 3rd party tokens through a user supplied executable. These
	* scripts/executables are completely independent of the Google Cloud Auth libraries. These
	* credentials plug into ADC and will call the specified executable to retrieve the 3rd party token
	* to be exchanged for a Google access token.
	*
	* <p>To use these credentials, the GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES environment variable
	* must be set to '1'. This is for security reasons.
	*
	* <p>Both OIDC and SAML are supported. The executable must adhere to a specific response format
	* defined below.
	*
	* <p>The executable must print out the 3rd party token to STDOUT in JSON format. When an
	* output_file is specified in the credential configuration, the executable must also handle writing the
	* JSON response to this file.
	*
	* <pre>
	* OIDC response sample:
	* {
	*   "version": 1,
	*   "success": true,
	*   "token_type": "urn:ietf:params:oauth:token-type:id_token",
	*   "id_token": "HEADER.PAYLOAD.SIGNATURE",
	*   "expiration_time": 1620433341
	* }
	*
	* SAML2 response sample:
	* {
	*   "version": 1,
	*   "success": true,
	*   "token_type": "urn:ietf:params:oauth:token-type:saml2",
	*   "saml_response": "...",
	*   "expiration_time": 1620433341
	* }
	*
	* Error response sample:
	* {
	*   "version": 1,
	*   "success": false,
	*   "code": "401",
	*   "message": "Error message."
	* }
	* </pre>
	*
	* <p>The "expiration_time" field in the JSON response is only required for successful
	* responses when an output file was specified in the credential configuration
	*
	* <p>The auth libraries will populate certain environment variables that will be accessible by the
	* executable, such as: GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE, GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE,
	* GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE, GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL, and
	* GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE.
	*
	* <p>Please see this repositories README for a complete executable request/response specification.
	*/
	var PluggableAuthClient = class extends baseexternalclient_1.BaseExternalAccountClient {
		/**
		* The command used to retrieve the third party token.
		*/
		command;
		/**
		* The timeout in milliseconds for running executable,
		* set to default if none provided.
		*/
		timeoutMillis;
		/**
		* The path to file to check for cached executable response.
		*/
		outputFile;
		/**
		* Executable and output file handler.
		*/
		handler;
		/**
		* Instantiates a PluggableAuthClient instance using the provided JSON
		* object loaded from an external account credentials file.
		* An error is thrown if the credential is not a valid pluggable auth credential.
		* @param options The external account options object typically loaded from
		*   the external account JSON credential file.
		*/
		constructor(options) {
			super(options);
			if (!options.credential_source.executable) {throw new Error("No valid Pluggable Auth \"credential_source\" provided.");}
			this.command = options.credential_source.executable.command;
			if (!this.command) {throw new Error("No valid Pluggable Auth \"credential_source\" provided.");}
			if (options.credential_source.executable.timeout_millis === void 0) {this.timeoutMillis = DEFAULT_EXECUTABLE_TIMEOUT_MILLIS;}
			else {
				this.timeoutMillis = options.credential_source.executable.timeout_millis;
				if (this.timeoutMillis < MINIMUM_EXECUTABLE_TIMEOUT_MILLIS || this.timeoutMillis > MAXIMUM_EXECUTABLE_TIMEOUT_MILLIS) {throw new Error(`Timeout must be between ${MINIMUM_EXECUTABLE_TIMEOUT_MILLIS} and ${MAXIMUM_EXECUTABLE_TIMEOUT_MILLIS} milliseconds.`);}
			}
			this.outputFile = options.credential_source.executable.output_file;
			this.handler = new pluggable_auth_handler_1.PluggableAuthHandler({
				command: this.command,
				timeoutMillis: this.timeoutMillis,
				outputFile: this.outputFile
			});
			this.credentialSourceType = "executable";
		}
		/**
		* Triggered when an external subject token is needed to be exchanged for a
		* GCP access token via GCP STS endpoint.
		* This uses the `options.credential_source` object to figure out how
		* to retrieve the token using the current environment. In this case,
		* this calls a user provided executable which returns the subject token.
		* The logic is summarized as:
		* 1. Validated that the executable is allowed to run. The
		*    GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES environment must be set to
		*    1 for security reasons.
		* 2. If an output file is specified by the user, check the file location
		*    for a response. If the file exists and contains a valid response,
		*    return the subject token from the file.
		* 3. Call the provided executable and return response.
		* @return A promise that resolves with the external subject token.
		*/
		async retrieveSubjectToken() {
			if (process.env[GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES] !== "1") {throw new Error("Pluggable Auth executables need to be explicitly allowed to run by setting the GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES environment Variable to 1.");}
			let executableResponse = void 0;
			if (this.outputFile) {executableResponse = await this.handler.retrieveCachedResponse();}
			if (!executableResponse) {
				const envMap = /* @__PURE__ */ new Map();
				envMap.set("GOOGLE_EXTERNAL_ACCOUNT_AUDIENCE", this.audience);
				envMap.set("GOOGLE_EXTERNAL_ACCOUNT_TOKEN_TYPE", this.subjectTokenType);
				envMap.set("GOOGLE_EXTERNAL_ACCOUNT_INTERACTIVE", "0");
				if (this.outputFile) {envMap.set("GOOGLE_EXTERNAL_ACCOUNT_OUTPUT_FILE", this.outputFile);}
				const serviceAccountEmail = this.getServiceAccountEmail();
				if (serviceAccountEmail) {envMap.set("GOOGLE_EXTERNAL_ACCOUNT_IMPERSONATED_EMAIL", serviceAccountEmail);}
				executableResponse = await this.handler.retrieveResponseFromExecutable(envMap);
			}
			if (executableResponse.version > MAXIMUM_EXECUTABLE_VERSION) {throw new Error(`Version of executable is not currently supported, maximum supported version is ${MAXIMUM_EXECUTABLE_VERSION}.`);}
			if (!executableResponse.success) {throw new pluggable_auth_handler_1.ExecutableError(executableResponse.errorMessage, executableResponse.errorCode);}
			if (this.outputFile) {
				if (!executableResponse.expirationTime) {throw new executable_response_1.InvalidExpirationTimeFieldError("The executable response must contain the `expiration_time` field for successful responses when an output_file has been specified in the configuration.");}
			}
			if (executableResponse.isExpired()) {throw new Error("Executable response is expired.");}
			return executableResponse.subjectToken;
		}
	};
	exports.PluggableAuthClient = PluggableAuthClient;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/externalclient.js
var require_externalclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ExternalAccountClient = void 0;
	const baseexternalclient_1 = require_baseexternalclient();
	const identitypoolclient_1 = require_identitypoolclient();
	const awsclient_1 = require_awsclient();
	const pluggable_auth_client_1 = require_pluggable_auth_client();
	/**
	* Dummy class with no constructor. Developers are expected to use fromJSON.
	*/
	var ExternalAccountClient = class {
		constructor() {
			throw new Error("ExternalAccountClients should be initialized via: ExternalAccountClient.fromJSON(), directly via explicit constructors, eg. new AwsClient(options), new IdentityPoolClient(options), newPluggableAuthClientOptions, or via new GoogleAuth(options).getClient()");
		}
		/**
		* This static method will instantiate the
		* corresponding type of external account credential depending on the
		* underlying credential source.
		*
		* **IMPORTANT**: This method does not validate the credential configuration.
		* A security risk occurs when a credential configuration configured with
		* malicious URLs is used. When the credential configuration is accepted from
		* an untrusted source, you should validate it before using it with this
		* method. For more details, see
		* https://cloud.google.com/docs/authentication/external/externally-sourced-credentials.
		*
		* @param options The external account options object typically loaded
		*   from the external account JSON credential file.
		* @return A BaseExternalAccountClient instance or null if the options
		*   provided do not correspond to an external account credential.
		*/
		static fromJSON(options) {
			if (options && options.type === baseexternalclient_1.EXTERNAL_ACCOUNT_TYPE) {if (options.credential_source?.environment_id) return new awsclient_1.AwsClient(options);
			else if (options.credential_source?.executable) return new pluggable_auth_client_1.PluggableAuthClient(options);
			else return new identitypoolclient_1.IdentityPoolClient(options);}
			else {return null;}
		}
	};
	exports.ExternalAccountClient = ExternalAccountClient;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/externalAccountAuthorizedUserClient.js
var require_externalAccountAuthorizedUserClient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ExternalAccountAuthorizedUserClient = exports.EXTERNAL_ACCOUNT_AUTHORIZED_USER_TYPE = void 0;
	const authclient_1 = require_authclient();
	const oauth2common_1 = require_oauth2common();
	const gaxios_1$2 = __require("gaxios");
	const stream$1 = __require("stream");
	const baseexternalclient_1 = require_baseexternalclient();
	/**
	* The credentials JSON file type for external account authorized user clients.
	*/
	exports.EXTERNAL_ACCOUNT_AUTHORIZED_USER_TYPE = "external_account_authorized_user";
	const DEFAULT_TOKEN_URL = "https://sts.{universeDomain}/v1/oauthtoken";
	/**
	* Handler for token refresh requests sent to the token_url endpoint for external
	* authorized user credentials.
	*/
	var ExternalAccountAuthorizedUserHandler = class ExternalAccountAuthorizedUserHandler extends oauth2common_1.OAuthClientAuthHandler {
		#tokenRefreshEndpoint;
		/**
		* Initializes an ExternalAccountAuthorizedUserHandler instance.
		* @param url The URL of the token refresh endpoint.
		* @param transporter The transporter to use for the refresh request.
		* @param clientAuthentication The client authentication credentials to use
		*   for the refresh request.
		*/
		constructor(options) {
			super(options);
			this.#tokenRefreshEndpoint = options.tokenRefreshEndpoint;
		}
		/**
		* Requests a new access token from the token_url endpoint using the provided
		*   refresh token.
		* @param refreshToken The refresh token to use to generate a new access token.
		* @param additionalHeaders Optional additional headers to pass along the
		*   request.
		* @return A promise that resolves with the token refresh response containing
		*   the requested access token and its expiration time.
		*/
		async refreshToken(refreshToken, headers) {
			const opts = {
				...ExternalAccountAuthorizedUserHandler.RETRY_CONFIG,
				url: this.#tokenRefreshEndpoint,
				method: "POST",
				headers,
				data: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: refreshToken
				}),
				responseType: "json"
			};
			authclient_1.AuthClient.setMethodName(opts, "refreshToken");
			this.applyClientAuthenticationOptions(opts);
			try {
				const response = await this.transporter.request(opts);
				const tokenRefreshResponse = response.data;
				tokenRefreshResponse.res = response;
				return tokenRefreshResponse;
			} catch (error) {
				if (error instanceof gaxios_1$2.GaxiosError && error.response) {throw (0, oauth2common_1.getErrorFromOAuthErrorResponse)(error.response.data, error);}
				throw error;
			}
		}
	};
	/**
	* External Account Authorized User Client. This is used for OAuth2 credentials
	* sourced using external identities through Workforce Identity Federation.
	* Obtaining the initial access and refresh token can be done through the
	* Google Cloud CLI.
	*/
	var ExternalAccountAuthorizedUserClient = class extends authclient_1.AuthClient {
		cachedAccessToken;
		externalAccountAuthorizedUserHandler;
		refreshToken;
		/**
		* Instantiates an ExternalAccountAuthorizedUserClient instances using the
		* provided JSON object loaded from a credentials files.
		* An error is throws if the credential is not valid.
		* @param options The external account authorized user option object typically
		*   from the external accoutn authorized user JSON credential file.
		*/
		constructor(options) {
			super(options);
			if (options.universe_domain) {this.universeDomain = options.universe_domain;}
			this.refreshToken = options.refresh_token;
			const clientAuthentication = {
				confidentialClientType: "basic",
				clientId: options.client_id,
				clientSecret: options.client_secret
			};
			this.externalAccountAuthorizedUserHandler = new ExternalAccountAuthorizedUserHandler({
				tokenRefreshEndpoint: options.token_url ?? DEFAULT_TOKEN_URL.replace("{universeDomain}", this.universeDomain),
				transporter: this.transporter,
				clientAuthentication
			});
			this.cachedAccessToken = null;
			this.quotaProjectId = options.quota_project_id;
			if (typeof options?.eagerRefreshThresholdMillis !== "number") {this.eagerRefreshThresholdMillis = baseexternalclient_1.EXPIRATION_TIME_OFFSET;}
			else {this.eagerRefreshThresholdMillis = options.eagerRefreshThresholdMillis;}
			this.forceRefreshOnFailure = !!options?.forceRefreshOnFailure;
		}
		async getAccessToken() {
			if (!this.cachedAccessToken || this.isExpired(this.cachedAccessToken)) {await this.refreshAccessTokenAsync();}
			return {
				token: this.cachedAccessToken.access_token,
				res: this.cachedAccessToken.res
			};
		}
		async getRequestHeaders() {
			const accessTokenResponse = await this.getAccessToken();
			const headers = new Headers({ authorization: `Bearer ${accessTokenResponse.token}` });
			return this.addSharedMetadataHeaders(headers);
		}
		request(opts, callback) {
			if (callback) {this.requestAsync(opts).then((r) => callback(null, r), (e) => {
				return callback(e, e.response);
			});}
			else {return this.requestAsync(opts);}
		}
		/**
		* Authenticates the provided HTTP request, processes it and resolves with the
		* returned response.
		* @param opts The HTTP request options.
		* @param reAuthRetried Whether the current attempt is a retry after a failed attempt due to an auth failure.
		* @return A promise that resolves with the successful response.
		*/
		async requestAsync(opts, reAuthRetried = false) {
			let response;
			try {
				const requestHeaders = await this.getRequestHeaders();
				opts.headers = gaxios_1$2.Gaxios.mergeHeaders(opts.headers);
				this.addUserProjectAndAuthHeaders(opts.headers, requestHeaders);
				response = await this.transporter.request(opts);
			} catch (e) {
				const res = e.response;
				if (res) {
					const statusCode = res.status;
					const isReadableStream = res.config.data instanceof stream$1.Readable;
					if (!reAuthRetried && (statusCode === 401 || statusCode === 403) && !isReadableStream && this.forceRefreshOnFailure) {
						await this.refreshAccessTokenAsync();
						return await this.requestAsync(opts, true);
					}
				}
				throw e;
			}
			return response;
		}
		/**
		* Forces token refresh, even if unexpired tokens are currently cached.
		* @return A promise that resolves with the refreshed credential.
		*/
		async refreshAccessTokenAsync() {
			const refreshResponse = await this.externalAccountAuthorizedUserHandler.refreshToken(this.refreshToken);
			this.cachedAccessToken = {
				access_token: refreshResponse.access_token,
				expiry_date: (/* @__PURE__ */ new Date()).getTime() + refreshResponse.expires_in * 1e3,
				res: refreshResponse.res
			};
			if (refreshResponse.refresh_token !== void 0) {this.refreshToken = refreshResponse.refresh_token;}
			return this.cachedAccessToken;
		}
		/**
		* Returns whether the provided credentials are expired or not.
		* If there is no expiry time, assumes the token is not expired or expiring.
		* @param credentials The credentials to check for expiration.
		* @return Whether the credentials are expired or not.
		*/
		isExpired(credentials) {
			const now = (/* @__PURE__ */ new Date()).getTime();
			return credentials.expiry_date ? now >= credentials.expiry_date - this.eagerRefreshThresholdMillis : false;
		}
	};
	exports.ExternalAccountAuthorizedUserClient = ExternalAccountAuthorizedUserClient;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/googleauth.js
var require_googleauth = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GoogleAuth = exports.GoogleAuthExceptionMessages = void 0;
	const child_process_1 = __require("child_process");
	const fs = __require("fs");
	const gaxios_1$1 = __require("gaxios");
	const gcpMetadata = require_src$1();
	const os = __require("os");
	const path = __require("path");
	const crypto_1 = require_crypto();
	const computeclient_1 = require_computeclient();
	const idtokenclient_1 = require_idtokenclient();
	const envDetect_1 = require_envDetect();
	const jwtclient_1 = require_jwtclient();
	const refreshclient_1 = require_refreshclient();
	const impersonated_1 = require_impersonated();
	const externalclient_1 = require_externalclient();
	const baseexternalclient_1 = require_baseexternalclient();
	const authclient_1 = require_authclient();
	const externalAccountAuthorizedUserClient_1 = require_externalAccountAuthorizedUserClient();
	const util_1 = require_util();
	exports.GoogleAuthExceptionMessages = {
		API_KEY_WITH_CREDENTIALS: "API Keys and Credentials are mutually exclusive authentication methods and cannot be used together.",
		NO_PROJECT_ID_FOUND: "Unable to detect a Project Id in the current environment. \nTo learn more about authentication and Google APIs, visit: \nhttps://cloud.google.com/docs/authentication/getting-started",
		NO_CREDENTIALS_FOUND: "Unable to find credentials in current environment. \nTo learn more about authentication and Google APIs, visit: \nhttps://cloud.google.com/docs/authentication/getting-started",
		NO_ADC_FOUND: "Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started for more information.",
		NO_UNIVERSE_DOMAIN_FOUND: "Unable to detect a Universe Domain in the current environment.\nTo learn more about Universe Domain retrieval, visit: \nhttps://cloud.google.com/compute/docs/metadata/predefined-metadata-keys"
	};
	var GoogleAuth = class {
		/**
		* Caches a value indicating whether the auth layer is running on Google
		* Compute Engine.
		* @private
		*/
		checkIsGCE = void 0;
		useJWTAccessWithScope;
		defaultServicePath;
		get isGCE() {
			return this.checkIsGCE;
		}
		_findProjectIdPromise;
		_cachedProjectId;
		jsonContent = null;
		apiKey;
		cachedCredential = null;
		/**
		* A pending {@link AuthClient}. Used for concurrent {@link GoogleAuth.getClient} calls.
		*/
		#pendingAuthClient = null;
		/**
		* Scopes populated by the client library by default. We differentiate between
		* these and user defined scopes when deciding whether to use a self-signed JWT.
		*/
		defaultScopes;
		keyFilename;
		scopes;
		clientOptions = {};
		/**
		* Configuration is resolved in the following order of precedence:
		* - {@link GoogleAuthOptions.credentials `credentials`}
		* - {@link GoogleAuthOptions.keyFilename `keyFilename`}
		* - {@link GoogleAuthOptions.keyFile `keyFile`}
		*
		* {@link GoogleAuthOptions.clientOptions `clientOptions`} are passed to the
		* {@link AuthClient `AuthClient`s}.
		*
		* @param opts
		*/
		constructor(opts = {}) {
			this._cachedProjectId = opts.projectId || null;
			this.cachedCredential = opts.authClient || null;
			this.keyFilename = opts.keyFilename || opts.keyFile;
			this.scopes = opts.scopes;
			this.clientOptions = opts.clientOptions || {};
			this.jsonContent = opts.credentials || null;
			this.apiKey = opts.apiKey || this.clientOptions.apiKey || null;
			if (this.apiKey && (this.jsonContent || this.clientOptions.credentials)) {throw new RangeError(exports.GoogleAuthExceptionMessages.API_KEY_WITH_CREDENTIALS);}
			if (opts.universeDomain) {this.clientOptions.universeDomain = opts.universeDomain;}
		}
		setGapicJWTValues(client) {
			client.defaultServicePath = this.defaultServicePath;
			client.useJWTAccessWithScope = this.useJWTAccessWithScope;
			client.defaultScopes = this.defaultScopes;
		}
		getProjectId(callback) {
			if (callback) {this.getProjectIdAsync().then((r) => callback(null, r), callback);}
			else {return this.getProjectIdAsync();}
		}
		/**
		* A temporary method for internal `getProjectId` usages where `null` is
		* acceptable. In a future major release, `getProjectId` should return `null`
		* (as the `Promise<string | null>` base signature describes) and this private
		* method should be removed.
		*
		* @returns Promise that resolves with project id (or `null`)
		*/
		async getProjectIdOptional() {
			try {
				return await this.getProjectId();
			} catch (e) {
				if (e instanceof Error && e.message === exports.GoogleAuthExceptionMessages.NO_PROJECT_ID_FOUND) {return null;}
				else {throw e;}
			}
		}
		/**
		* A private method for finding and caching a projectId.
		*
		* Supports environments in order of precedence:
		* - GCLOUD_PROJECT or GOOGLE_CLOUD_PROJECT environment variable
		* - GOOGLE_APPLICATION_CREDENTIALS JSON file
		* - Cloud SDK: `gcloud config config-helper --format json`
		* - GCE project ID from metadata server
		*
		* @returns projectId
		*/
		async findAndCacheProjectId() {
			let projectId = null;
			projectId ||= await this.getProductionProjectId();
			projectId ||= await this.getFileProjectId();
			projectId ||= await this.getDefaultServiceProjectId();
			projectId ||= await this.getGCEProjectId();
			projectId ||= await this.getExternalAccountClientProjectId();
			if (projectId) {
				this._cachedProjectId = projectId;
				return projectId;
			} else {throw new Error(exports.GoogleAuthExceptionMessages.NO_PROJECT_ID_FOUND);}
		}
		async getProjectIdAsync() {
			if (this._cachedProjectId) {return this._cachedProjectId;}
			if (!this._findProjectIdPromise) {this._findProjectIdPromise = this.findAndCacheProjectId();}
			return this._findProjectIdPromise;
		}
		/**
		* Retrieves a universe domain from the metadata server via
		* {@link gcpMetadata.universe}.
		*
		* @returns a universe domain
		*/
		async getUniverseDomainFromMetadataServer() {
			let universeDomain;
			try {
				universeDomain = await gcpMetadata.universe("universe-domain");
				universeDomain ||= authclient_1.DEFAULT_UNIVERSE;
			} catch (e) {
				if (e && e?.response?.status === 404) {universeDomain = authclient_1.DEFAULT_UNIVERSE;}
				else {throw e;}
			}
			return universeDomain;
		}
		/**
		* Retrieves, caches, and returns the universe domain in the following order
		* of precedence:
		* - The universe domain in {@link GoogleAuth.clientOptions}
		* - An existing or ADC {@link AuthClient}'s universe domain
		* - {@link gcpMetadata.universe}, if {@link Compute} client
		*
		* @returns The universe domain
		*/
		async getUniverseDomain() {
			let universeDomain = (0, util_1.originalOrCamelOptions)(this.clientOptions).get("universe_domain");
			try {
				universeDomain ??= (await this.getClient()).universeDomain;
			} catch {
				universeDomain ??= authclient_1.DEFAULT_UNIVERSE;
			}
			return universeDomain;
		}
		/**
		* @returns Any scopes (user-specified or default scopes specified by the
		*   client library) that need to be set on the current Auth client.
		*/
		getAnyScopes() {
			return this.scopes || this.defaultScopes;
		}
		getApplicationDefault(optionsOrCallback = {}, callback) {
			let options;
			if (typeof optionsOrCallback === "function") {callback = optionsOrCallback;}
			else {options = optionsOrCallback;}
			if (callback) {this.getApplicationDefaultAsync(options).then((r) => callback(null, r.credential, r.projectId), callback);}
			else {return this.getApplicationDefaultAsync(options);}
		}
		async getApplicationDefaultAsync(options = {}) {
			if (this.cachedCredential) {return await this.#prepareAndCacheClient(this.cachedCredential, null);}
			let credential;
			credential = await this._tryGetApplicationCredentialsFromEnvironmentVariable(options);
			if (credential) {
				if (credential instanceof jwtclient_1.JWT) {credential.scopes = this.scopes;}
				else if (credential instanceof baseexternalclient_1.BaseExternalAccountClient) {credential.scopes = this.getAnyScopes();}
				return await this.#prepareAndCacheClient(credential);
			}
			credential = await this._tryGetApplicationCredentialsFromWellKnownFile(options);
			if (credential) {
				if (credential instanceof jwtclient_1.JWT) {credential.scopes = this.scopes;}
				else if (credential instanceof baseexternalclient_1.BaseExternalAccountClient) {credential.scopes = this.getAnyScopes();}
				return await this.#prepareAndCacheClient(credential);
			}
			if (await this._checkIsGCE()) {
				options.scopes = this.getAnyScopes();
				return await this.#prepareAndCacheClient(new computeclient_1.Compute(options));
			}
			throw new Error(exports.GoogleAuthExceptionMessages.NO_ADC_FOUND);
		}
		async #prepareAndCacheClient(credential, quotaProjectIdOverride = process.env["GOOGLE_CLOUD_QUOTA_PROJECT"] || null) {
			const projectId = await this.getProjectIdOptional();
			if (quotaProjectIdOverride) {credential.quotaProjectId = quotaProjectIdOverride;}
			this.cachedCredential = credential;
			return {
				credential,
				projectId
			};
		}
		/**
		* Determines whether the auth layer is running on Google Compute Engine.
		* Checks for GCP Residency, then fallback to checking if metadata server
		* is available.
		*
		* @returns A promise that resolves with the boolean.
		* @api private
		*/
		async _checkIsGCE() {
			if (this.checkIsGCE === void 0) {this.checkIsGCE = gcpMetadata.getGCPResidency() || await gcpMetadata.isAvailable();}
			return this.checkIsGCE;
		}
		/**
		* Attempts to load default credentials from the environment variable path..
		* @returns Promise that resolves with the OAuth2Client or null.
		* @api private
		*/
		async _tryGetApplicationCredentialsFromEnvironmentVariable(options) {
			const credentialsPath = process.env["GOOGLE_APPLICATION_CREDENTIALS"] || process.env["google_application_credentials"];
			if (!credentialsPath || credentialsPath.length === 0) {return null;}
			try {
				return this._getApplicationCredentialsFromFilePath(credentialsPath, options);
			} catch (e) {
				if (e instanceof Error) {e.message = `Unable to read the credential file specified by the GOOGLE_APPLICATION_CREDENTIALS environment variable: ${e.message}`;}
				throw e;
			}
		}
		/**
		* Attempts to load default credentials from a well-known file location
		* @return Promise that resolves with the OAuth2Client or null.
		* @api private
		*/
		async _tryGetApplicationCredentialsFromWellKnownFile(options) {
			let location = null;
			if (this._isWindows()) {location = process.env["APPDATA"];}
			else {
				const home = process.env["HOME"];
				if (home) {location = path.join(home, ".config");}
			}
			if (location) {
				location = path.join(location, "gcloud", "application_default_credentials.json");
				if (!fs.existsSync(location)) {location = null;}
			}
			if (!location) {return null;}
			return await this._getApplicationCredentialsFromFilePath(location, options);
		}
		/**
		* Attempts to load default credentials from a file at the given path..
		* @param filePath The path to the file to read.
		* @returns Promise that resolves with the OAuth2Client
		* @api private
		*/
		async _getApplicationCredentialsFromFilePath(filePath, options = {}) {
			if (!filePath || filePath.length === 0) {throw new Error("The file path is invalid.");}
			try {
				filePath = fs.realpathSync(filePath);
				if (!fs.lstatSync(filePath).isFile()) {throw new Error();}
			} catch (err) {
				if (err instanceof Error) {err.message = `The file at ${filePath} does not exist, or it is not a file. ${err.message}`;}
				throw err;
			}
			const readStream = fs.createReadStream(filePath);
			return this.fromStream(readStream, options);
		}
		/**
		* Create a credentials instance using a given impersonated input options.
		* @param json The impersonated input object.
		* @returns JWT or UserRefresh Client with data
		*/
		fromImpersonatedJSON(json) {
			if (!json) {throw new Error("Must pass in a JSON object containing an  impersonated refresh token");}
			if (json.type !== impersonated_1.IMPERSONATED_ACCOUNT_TYPE) {throw new Error(`The incoming JSON object does not have the "${impersonated_1.IMPERSONATED_ACCOUNT_TYPE}" type`);}
			if (!json.source_credentials) {throw new Error("The incoming JSON object does not contain a source_credentials field");}
			if (!json.service_account_impersonation_url) {throw new Error("The incoming JSON object does not contain a service_account_impersonation_url field");}
			const sourceClient = this.fromJSON(json.source_credentials);
			if (json.service_account_impersonation_url?.length > 256)
 /**
			* Prevents DOS attacks.
			* @see {@link https://github.com/googleapis/google-auth-library-nodejs/security/code-scanning/85}
			**/
			{throw new RangeError(`Target principal is too long: ${json.service_account_impersonation_url}`);}
			const targetPrincipal = /(?<target>[^/]+):(generateAccessToken|generateIdToken)$/.exec(json.service_account_impersonation_url)?.groups?.target;
			if (!targetPrincipal) {throw new RangeError(`Cannot extract target principal from ${json.service_account_impersonation_url}`);}
			const targetScopes = (this.scopes || json.scopes || this.defaultScopes) ?? [];
			return new impersonated_1.Impersonated({
				...json,
				sourceClient,
				targetPrincipal,
				targetScopes: Array.isArray(targetScopes) ? targetScopes : [targetScopes]
			});
		}
		/**
		* Create a credentials instance using the given input options.
		* This client is not cached.
		*
		* **Important**: If you accept a credential configuration (credential JSON/File/Stream) from an external source for authentication to Google Cloud, you must validate it before providing it to any Google API or library. Providing an unvalidated credential configuration to Google APIs can compromise the security of your systems and data. For more information, refer to {@link https://cloud.google.com/docs/authentication/external/externally-sourced-credentials Validate credential configurations from external sources}.
		*
		* @deprecated This method is being deprecated because of a potential security risk.
		*
		* This method does not validate the credential configuration. The security
		* risk occurs when a credential configuration is accepted from a source that
		* is not under your control and used without validation on your side.
		*
		* If you know that you will be loading credential configurations of a
		* specific type, it is recommended to use a credential-type-specific
		* constructor. This will ensure that an unexpected credential type with
		* potential for malicious intent is not loaded unintentionally. You might
		* still have to do validation for certain credential types. Please follow
		* the recommendation for that method. For example, if you want to load only
		* service accounts, you can use the `JWT` constructor:
		* ```
		* const {JWT} = require('google-auth-library');
		* const keys = require('/path/to/key.json');
		* const client = new JWT({
		*   email: keys.client_email,
		*   key: keys.private_key,
		*   scopes: ['https://www.googleapis.com/auth/cloud-platform'],
		* });
		* ```
		*
		* If you are loading your credential configuration from an untrusted source and have
		* not mitigated the risks (e.g. by validating the configuration yourself), make
		* these changes as soon as possible to prevent security risks to your environment.
		*
		* Regardless of the method used, it is always your responsibility to validate
		* configurations received from external sources.
		*
		* For more details, see https://cloud.google.com/docs/authentication/external/externally-sourced-credentials.
		*
		* @param json The input object.
		* @param options The JWT or UserRefresh options for the client
		* @returns JWT or UserRefresh Client with data
		*/
		fromJSON(json, options = {}) {
			let client;
			const preferredUniverseDomain = (0, util_1.originalOrCamelOptions)(options).get("universe_domain");
			if (json.type === refreshclient_1.USER_REFRESH_ACCOUNT_TYPE) {
				client = new refreshclient_1.UserRefreshClient(options);
				client.fromJSON(json);
			} else if (json.type === impersonated_1.IMPERSONATED_ACCOUNT_TYPE) {client = this.fromImpersonatedJSON(json);}
			else if (json.type === baseexternalclient_1.EXTERNAL_ACCOUNT_TYPE) {
				client = externalclient_1.ExternalAccountClient.fromJSON({
					...json,
					...options
				});
				client.scopes = this.getAnyScopes();
			} else if (json.type === externalAccountAuthorizedUserClient_1.EXTERNAL_ACCOUNT_AUTHORIZED_USER_TYPE) {client = new externalAccountAuthorizedUserClient_1.ExternalAccountAuthorizedUserClient({
				...json,
				...options
			});}
			else {
				options.scopes = this.scopes;
				client = new jwtclient_1.JWT(options);
				this.setGapicJWTValues(client);
				client.fromJSON(json);
			}
			if (preferredUniverseDomain) {client.universeDomain = preferredUniverseDomain;}
			return client;
		}
		/**
		* Return a JWT or UserRefreshClient from JavaScript object, caching both the
		* object used to instantiate and the client.
		* @param json The input object.
		* @param options The JWT or UserRefresh options for the client
		* @returns JWT or UserRefresh Client with data
		*/
		_cacheClientFromJSON(json, options) {
			const client = this.fromJSON(json, options);
			this.jsonContent = json;
			this.cachedCredential = client;
			return client;
		}
		fromStream(inputStream, optionsOrCallback = {}, callback) {
			let options = {};
			if (typeof optionsOrCallback === "function") {callback = optionsOrCallback;}
			else {options = optionsOrCallback;}
			if (callback) {this.fromStreamAsync(inputStream, options).then((r) => callback(null, r), callback);}
			else {return this.fromStreamAsync(inputStream, options);}
		}
		fromStreamAsync(inputStream, options) {
			return new Promise((resolve, reject) => {
				if (!inputStream) {throw new Error("Must pass in a stream containing the Google auth settings.");}
				const chunks = [];
				inputStream.setEncoding("utf8").on("error", reject).on("data", (chunk) => chunks.push(chunk)).on("end", () => {
					try {
						try {
							const data = JSON.parse(chunks.join(""));
							return resolve(this._cacheClientFromJSON(data, options));
						} catch (err) {
							if (!this.keyFilename) {throw err;}
							const client = new jwtclient_1.JWT({
								...this.clientOptions,
								keyFile: this.keyFilename
							});
							this.cachedCredential = client;
							this.setGapicJWTValues(client);
							return resolve(client);
						}
					} catch (err) {
						return reject(err);
					}
				});
			});
		}
		/**
		* Create a credentials instance using the given API key string.
		* The created client is not cached. In order to create and cache it use the {@link GoogleAuth.getClient `getClient`} method after first providing an {@link GoogleAuth.apiKey `apiKey`}.
		*
		* @param apiKey The API key string
		* @param options An optional options object.
		* @returns A JWT loaded from the key
		*/
		fromAPIKey(apiKey, options = {}) {
			return new jwtclient_1.JWT({
				...options,
				apiKey
			});
		}
		/**
		* Determines whether the current operating system is Windows.
		* @api private
		*/
		_isWindows() {
			const sys = os.platform();
			if (sys && sys.length >= 3) {
				if (sys.substring(0, 3).toLowerCase() === "win") {return true;}
			}
			return false;
		}
		/**
		* Run the Google Cloud SDK command that prints the default project ID
		*/
		async getDefaultServiceProjectId() {
			return new Promise((resolve) => {
				(0, child_process_1.exec)("gcloud config config-helper --format json", (err, stdout) => {
					if (!err && stdout) {try {
						const projectId = JSON.parse(stdout).configuration.properties.core.project;
						resolve(projectId);
						return;
					} catch (e) {}}
					resolve(null);
				});
			});
		}
		/**
		* Loads the project id from environment variables.
		* @api private
		*/
		getProductionProjectId() {
			return process.env["GCLOUD_PROJECT"] || process.env["GOOGLE_CLOUD_PROJECT"] || process.env["gcloud_project"] || process.env["google_cloud_project"];
		}
		/**
		* Loads the project id from the GOOGLE_APPLICATION_CREDENTIALS json file.
		* @api private
		*/
		async getFileProjectId() {
			if (this.cachedCredential) {return this.cachedCredential.projectId;}
			if (this.keyFilename) {
				const creds = await this.getClient();
				if (creds && creds.projectId) {return creds.projectId;}
			}
			const r = await this._tryGetApplicationCredentialsFromEnvironmentVariable();
			if (r) {return r.projectId;}
			else {return null;}
		}
		/**
		* Gets the project ID from external account client if available.
		*/
		async getExternalAccountClientProjectId() {
			if (!this.jsonContent || this.jsonContent.type !== baseexternalclient_1.EXTERNAL_ACCOUNT_TYPE) {return null;}
			return await (await this.getClient()).getProjectId();
		}
		/**
		* Gets the Compute Engine project ID if it can be inferred.
		*/
		async getGCEProjectId() {
			try {
				return await gcpMetadata.project("project-id");
			} catch (e) {
				return null;
			}
		}
		getCredentials(callback) {
			if (callback) {this.getCredentialsAsync().then((r) => callback(null, r), callback);}
			else {return this.getCredentialsAsync();}
		}
		async getCredentialsAsync() {
			const client = await this.getClient();
			if (client instanceof impersonated_1.Impersonated) {return { client_email: client.getTargetPrincipal() };}
			if (client instanceof baseexternalclient_1.BaseExternalAccountClient) {
				const serviceAccountEmail = client.getServiceAccountEmail();
				if (serviceAccountEmail) {return {
					client_email: serviceAccountEmail,
					universe_domain: client.universeDomain
				};}
			}
			if (this.jsonContent) {return {
				client_email: this.jsonContent.client_email,
				private_key: this.jsonContent.private_key,
				universe_domain: this.jsonContent.universe_domain
			};}
			if (await this._checkIsGCE()) {
				const [client_email, universe_domain] = await Promise.all([gcpMetadata.instance("service-accounts/default/email"), this.getUniverseDomain()]);
				return {
					client_email,
					universe_domain
				};
			}
			throw new Error(exports.GoogleAuthExceptionMessages.NO_CREDENTIALS_FOUND);
		}
		/**
		* Automatically obtain an {@link AuthClient `AuthClient`} based on the
		* provided configuration. If no options were passed, use Application
		* Default Credentials.
		*/
		async getClient() {
			if (this.cachedCredential) {return this.cachedCredential;}
			this.#pendingAuthClient = this.#pendingAuthClient || this.#determineClient();
			try {
				return await this.#pendingAuthClient;
			} finally {
				this.#pendingAuthClient = null;
			}
		}
		async #determineClient() {
			if (this.jsonContent) {return this._cacheClientFromJSON(this.jsonContent, this.clientOptions);}
			else if (this.keyFilename) {
				const filePath = path.resolve(this.keyFilename);
				const stream = fs.createReadStream(filePath);
				return await this.fromStreamAsync(stream, this.clientOptions);
			} else if (this.apiKey) {
				const client = await this.fromAPIKey(this.apiKey, this.clientOptions);
				client.scopes = this.scopes;
				const { credential } = await this.#prepareAndCacheClient(client);
				return credential;
			} else {
				const { credential } = await this.getApplicationDefaultAsync(this.clientOptions);
				return credential;
			}
		}
		/**
		* Creates a client which will fetch an ID token for authorization.
		* @param targetAudience the audience for the fetched ID token.
		* @returns IdTokenClient for making HTTP calls authenticated with ID tokens.
		*/
		async getIdTokenClient(targetAudience) {
			const client = await this.getClient();
			if (!("fetchIdToken" in client)) {throw new Error("Cannot fetch ID token in this environment, use GCE or set the GOOGLE_APPLICATION_CREDENTIALS environment variable to a service account credentials JSON file.");}
			return new idtokenclient_1.IdTokenClient({
				targetAudience,
				idTokenProvider: client
			});
		}
		/**
		* Automatically obtain application default credentials, and return
		* an access token for making requests.
		*/
		async getAccessToken() {
			return (await (await this.getClient()).getAccessToken()).token;
		}
		/**
		* Obtain the HTTP headers that will provide authorization for a given
		* request.
		*/
		async getRequestHeaders(url) {
			return (await this.getClient()).getRequestHeaders(url);
		}
		/**
		* Obtain credentials for a request, then attach the appropriate headers to
		* the request options.
		* @param opts Axios or Request options on which to attach the headers
		*/
		async authorizeRequest(opts = {}) {
			const url = opts.url;
			const headers = await (await this.getClient()).getRequestHeaders(url);
			opts.headers = gaxios_1$1.Gaxios.mergeHeaders(opts.headers, headers);
			return opts;
		}
		/**
		* A {@link fetch `fetch`} compliant API for {@link GoogleAuth}.
		*
		* @see {@link GoogleAuth.request} for the classic method.
		*
		* @remarks
		*
		* This is useful as a drop-in replacement for `fetch` API usage.
		*
		* @example
		*
		* ```ts
		* const auth = new GoogleAuth();
		* const fetchWithAuth: typeof fetch = (...args) => auth.fetch(...args);
		* await fetchWithAuth('https://example.com');
		* ```
		*
		* @param args `fetch` API or {@link Gaxios.fetch `Gaxios#fetch`} parameters
		* @returns the {@link GaxiosResponse} with Gaxios-added properties
		*/
		async fetch(...args) {
			return (await this.getClient()).fetch(...args);
		}
		/**
		* Automatically obtain application default credentials, and make an
		* HTTP request using the given options.
		*
		* @see {@link GoogleAuth.fetch} for the modern method.
		*
		* @param opts Axios request options for the HTTP request.
		*/
		async request(opts) {
			return (await this.getClient()).request(opts);
		}
		/**
		* Determine the compute environment in which the code is running.
		*/
		getEnv() {
			return (0, envDetect_1.getEnv)();
		}
		/**
		* Sign the given data with the current private key, or go out
		* to the IAM API to sign it.
		* @param data The data to be signed.
		* @param endpoint A custom endpoint to use.
		*
		* @example
		* ```
		* sign('data', 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/');
		* ```
		*/
		async sign(data, endpoint) {
			const client = await this.getClient();
			const universe = await this.getUniverseDomain();
			endpoint = endpoint || `https://iamcredentials.${universe}/v1/projects/-/serviceAccounts/`;
			if (client instanceof impersonated_1.Impersonated) {return (await client.sign(data)).signedBlob;}
			const crypto = (0, crypto_1.createCrypto)();
			if (client instanceof jwtclient_1.JWT && client.key) {return await crypto.sign(client.key, data);}
			const creds = await this.getCredentials();
			if (!creds.client_email) {throw new Error("Cannot sign data without `client_email`.");}
			return this.signBlob(crypto, creds.client_email, data, endpoint);
		}
		async signBlob(crypto, emailOrUniqueId, data, endpoint) {
			const url = new URL(endpoint + `${emailOrUniqueId}:signBlob`);
			return (await this.request({
				method: "POST",
				url: url.href,
				data: { payload: crypto.encodeBase64StringUtf8(data) },
				retry: true,
				retryConfig: { httpMethodsToRetry: ["POST"] }
			})).data.signedBlob;
		}
	};
	exports.GoogleAuth = GoogleAuth;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/iam.js
var require_iam = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.IAMAuth = void 0;
	var IAMAuth = class {
		selector;
		token;
		/**
		* IAM credentials.
		*
		* @param selector the iam authority selector
		* @param token the token
		* @constructor
		*/
		constructor(selector, token) {
			this.selector = selector;
			this.token = token;
			this.selector = selector;
			this.token = token;
		}
		/**
		* Acquire the HTTP headers required to make an authenticated request.
		*/
		getRequestHeaders() {
			return {
				"x-goog-iam-authority-selector": this.selector,
				"x-goog-iam-authorization-token": this.token
			};
		}
	};
	exports.IAMAuth = IAMAuth;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/downscopedclient.js
var require_downscopedclient = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.DownscopedClient = exports.EXPIRATION_TIME_OFFSET = exports.MAX_ACCESS_BOUNDARY_RULES_COUNT = void 0;
	const gaxios_1 = __require("gaxios");
	const stream = __require("stream");
	const authclient_1 = require_authclient();
	const sts = require_stscredentials();
	/**
	* The required token exchange grant_type: rfc8693#section-2.1
	*/
	const STS_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange";
	/**
	* The requested token exchange requested_token_type: rfc8693#section-2.1
	*/
	const STS_REQUEST_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
	/**
	* The requested token exchange subject_token_type: rfc8693#section-2.1
	*/
	const STS_SUBJECT_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
	/**
	* The maximum number of access boundary rules a Credential Access Boundary
	* can contain.
	*/
	exports.MAX_ACCESS_BOUNDARY_RULES_COUNT = 10;
	/**
	* Offset to take into account network delays and server clock skews.
	*/
	exports.EXPIRATION_TIME_OFFSET = 300 * 1e3;
	/**
	* Defines a set of Google credentials that are downscoped from an existing set
	* of Google OAuth2 credentials. This is useful to restrict the Identity and
	* Access Management (IAM) permissions that a short-lived credential can use.
	* The common pattern of usage is to have a token broker with elevated access
	* generate these downscoped credentials from higher access source credentials
	* and pass the downscoped short-lived access tokens to a token consumer via
	* some secure authenticated channel for limited access to Google Cloud Storage
	* resources.
	*/
	var DownscopedClient = class extends authclient_1.AuthClient {
		authClient;
		credentialAccessBoundary;
		cachedDownscopedAccessToken;
		stsCredential;
		/**
		* Instantiates a downscoped client object using the provided source
		* AuthClient and credential access boundary rules.
		* To downscope permissions of a source AuthClient, a Credential Access
		* Boundary that specifies which resources the new credential can access, as
		* well as an upper bound on the permissions that are available on each
		* resource, has to be defined. A downscoped client can then be instantiated
		* using the source AuthClient and the Credential Access Boundary.
		* @param options the {@link DownscopedClientOptions `DownscopedClientOptions`} to use. Passing an `AuthClient` directly is **@DEPRECATED**.
		* @param credentialAccessBoundary **@DEPRECATED**. Provide a {@link DownscopedClientOptions `DownscopedClientOptions`} object in the first parameter instead.
		*/
		constructor(options, credentialAccessBoundary = { accessBoundary: { accessBoundaryRules: [] } }) {
			super(options instanceof authclient_1.AuthClient ? {} : options);
			if (options instanceof authclient_1.AuthClient) {
				this.authClient = options;
				this.credentialAccessBoundary = credentialAccessBoundary;
			} else {
				this.authClient = options.authClient;
				this.credentialAccessBoundary = options.credentialAccessBoundary;
			}
			if (this.credentialAccessBoundary.accessBoundary.accessBoundaryRules.length === 0) {throw new Error("At least one access boundary rule needs to be defined.");}
			else if (this.credentialAccessBoundary.accessBoundary.accessBoundaryRules.length > exports.MAX_ACCESS_BOUNDARY_RULES_COUNT) {throw new Error(`The provided access boundary has more than ${exports.MAX_ACCESS_BOUNDARY_RULES_COUNT} access boundary rules.`);}
			for (const rule of this.credentialAccessBoundary.accessBoundary.accessBoundaryRules) {if (rule.availablePermissions.length === 0) throw new Error("At least one permission should be defined in access boundary rules.");}
			this.stsCredential = new sts.StsCredentials({ tokenExchangeEndpoint: `https://sts.${this.universeDomain}/v1/token` });
			this.cachedDownscopedAccessToken = null;
		}
		/**
		* Provides a mechanism to inject Downscoped access tokens directly.
		* The expiry_date field is required to facilitate determination of the token
		* expiration which would make it easier for the token consumer to handle.
		* @param credentials The Credentials object to set on the current client.
		*/
		setCredentials(credentials) {
			if (!credentials.expiry_date) {throw new Error("The access token expiry_date field is missing in the provided credentials.");}
			super.setCredentials(credentials);
			this.cachedDownscopedAccessToken = credentials;
		}
		async getAccessToken() {
			if (!this.cachedDownscopedAccessToken || this.isExpired(this.cachedDownscopedAccessToken)) {await this.refreshAccessTokenAsync();}
			return {
				token: this.cachedDownscopedAccessToken.access_token,
				expirationTime: this.cachedDownscopedAccessToken.expiry_date,
				res: this.cachedDownscopedAccessToken.res
			};
		}
		/**
		* The main authentication interface. It takes an optional url which when
		* present is the endpoint being accessed, and returns a Promise which
		* resolves with authorization header fields.
		*
		* The result has the form:
		* { authorization: 'Bearer <access_token_value>' }
		*/
		async getRequestHeaders() {
			const accessTokenResponse = await this.getAccessToken();
			const headers = new Headers({ authorization: `Bearer ${accessTokenResponse.token}` });
			return this.addSharedMetadataHeaders(headers);
		}
		request(opts, callback) {
			if (callback) {this.requestAsync(opts).then((r) => callback(null, r), (e) => {
				return callback(e, e.response);
			});}
			else {return this.requestAsync(opts);}
		}
		/**
		* Authenticates the provided HTTP request, processes it and resolves with the
		* returned response.
		* @param opts The HTTP request options.
		* @param reAuthRetried Whether the current attempt is a retry after a failed attempt due to an auth failure
		* @return A promise that resolves with the successful response.
		*/
		async requestAsync(opts, reAuthRetried = false) {
			let response;
			try {
				const requestHeaders = await this.getRequestHeaders();
				opts.headers = gaxios_1.Gaxios.mergeHeaders(opts.headers);
				this.addUserProjectAndAuthHeaders(opts.headers, requestHeaders);
				response = await this.transporter.request(opts);
			} catch (e) {
				const res = e.response;
				if (res) {
					const statusCode = res.status;
					const isReadableStream = res.config.data instanceof stream.Readable;
					if (!reAuthRetried && (statusCode === 401 || statusCode === 403) && !isReadableStream && this.forceRefreshOnFailure) {
						await this.refreshAccessTokenAsync();
						return await this.requestAsync(opts, true);
					}
				}
				throw e;
			}
			return response;
		}
		/**
		* Forces token refresh, even if unexpired tokens are currently cached.
		* GCP access tokens are retrieved from authclient object/source credential.
		* Then GCP access tokens are exchanged for downscoped access tokens via the
		* token exchange endpoint.
		* @return A promise that resolves with the fresh downscoped access token.
		*/
		async refreshAccessTokenAsync() {
			const stsCredentialsOptions = {
				grantType: STS_GRANT_TYPE,
				requestedTokenType: STS_REQUEST_TOKEN_TYPE,
				subjectToken: (await this.authClient.getAccessToken()).token,
				subjectTokenType: STS_SUBJECT_TOKEN_TYPE
			};
			const stsResponse = await this.stsCredential.exchangeToken(stsCredentialsOptions, void 0, this.credentialAccessBoundary);
			/**
			* The STS endpoint will only return the expiration time for the downscoped
			* access token if the original access token represents a service account.
			* The downscoped token's expiration time will always match the source
			* credential expiration. When no expires_in is returned, we can copy the
			* source credential's expiration time.
			*/
			const sourceCredExpireDate = this.authClient.credentials?.expiry_date || null;
			const expiryDate = stsResponse.expires_in ? (/* @__PURE__ */ new Date()).getTime() + stsResponse.expires_in * 1e3 : sourceCredExpireDate;
			this.cachedDownscopedAccessToken = {
				access_token: stsResponse.access_token,
				expiry_date: expiryDate,
				res: stsResponse.res
			};
			this.credentials = {};
			Object.assign(this.credentials, this.cachedDownscopedAccessToken);
			delete this.credentials.res;
			this.emit("tokens", {
				refresh_token: null,
				expiry_date: this.cachedDownscopedAccessToken.expiry_date,
				access_token: this.cachedDownscopedAccessToken.access_token,
				token_type: "Bearer",
				id_token: null
			});
			return this.cachedDownscopedAccessToken;
		}
		/**
		* Returns whether the provided credentials are expired or not.
		* If there is no expiry time, assumes the token is not expired or expiring.
		* @param downscopedAccessToken The credentials to check for expiration.
		* @return Whether the credentials are expired or not.
		*/
		isExpired(downscopedAccessToken) {
			const now = (/* @__PURE__ */ new Date()).getTime();
			return downscopedAccessToken.expiry_date ? now >= downscopedAccessToken.expiry_date - this.eagerRefreshThresholdMillis : false;
		}
	};
	exports.DownscopedClient = DownscopedClient;
}));
//#endregion
//#region node_modules/.pnpm/google-auth-library@10.6.1/node_modules/google-auth-library/build/src/auth/passthrough.js
var require_passthrough = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PassThroughClient = void 0;
	const authclient_1 = require_authclient();
	/**
	* An AuthClient without any Authentication information. Useful for:
	* - Anonymous access
	* - Local Emulators
	* - Testing Environments
	*
	*/
	var PassThroughClient = class extends authclient_1.AuthClient {
		/**
		* Creates a request without any authentication headers or checks.
		*
		* @remarks
		*
		* In testing environments it may be useful to change the provided
		* {@link AuthClient.transporter} for any desired request overrides/handling.
		*
		* @param opts
		* @returns The response of the request.
		*/
		async request(opts) {
			return this.transporter.request(opts);
		}
		/**
		* A required method of the base class.
		* Always will return an empty object.
		*
		* @returns {}
		*/
		async getAccessToken() {
			return {};
		}
		/**
		* A required method of the base class.
		* Always will return an empty object.
		*
		* @returns {}
		*/
		async getRequestHeaders() {
			return new Headers();
		}
	};
	exports.PassThroughClient = PassThroughClient;
}));
//#endregion
//#region extensions/googlechat/src/auth.ts
var import_src = (/* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};}
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) {k2 = k;}
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$1) {
		for (var p in m) {if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$1, p)) __createBinding(exports$1, m, p);}
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.GoogleAuth = exports.auth = exports.PassThroughClient = exports.ExternalAccountAuthorizedUserClient = exports.EXTERNAL_ACCOUNT_AUTHORIZED_USER_TYPE = exports.ExecutableError = exports.PluggableAuthClient = exports.DownscopedClient = exports.BaseExternalAccountClient = exports.ExternalAccountClient = exports.IdentityPoolClient = exports.AwsRequestSigner = exports.AwsClient = exports.UserRefreshClient = exports.LoginTicket = exports.ClientAuthentication = exports.OAuth2Client = exports.CodeChallengeMethod = exports.Impersonated = exports.JWT = exports.JWTAccess = exports.IdTokenClient = exports.IAMAuth = exports.GCPEnv = exports.Compute = exports.DEFAULT_UNIVERSE = exports.AuthClient = exports.gaxios = exports.gcpMetadata = void 0;
	const googleauth_1 = require_googleauth();
	Object.defineProperty(exports, "GoogleAuth", {
		enumerable: true,
		get: function() {
			return googleauth_1.GoogleAuth;
		}
	});
	exports.gcpMetadata = require_src$1();
	exports.gaxios = __require("gaxios");
	var authclient_1 = require_authclient();
	Object.defineProperty(exports, "AuthClient", {
		enumerable: true,
		get: function() {
			return authclient_1.AuthClient;
		}
	});
	Object.defineProperty(exports, "DEFAULT_UNIVERSE", {
		enumerable: true,
		get: function() {
			return authclient_1.DEFAULT_UNIVERSE;
		}
	});
	var computeclient_1 = require_computeclient();
	Object.defineProperty(exports, "Compute", {
		enumerable: true,
		get: function() {
			return computeclient_1.Compute;
		}
	});
	var envDetect_1 = require_envDetect();
	Object.defineProperty(exports, "GCPEnv", {
		enumerable: true,
		get: function() {
			return envDetect_1.GCPEnv;
		}
	});
	var iam_1 = require_iam();
	Object.defineProperty(exports, "IAMAuth", {
		enumerable: true,
		get: function() {
			return iam_1.IAMAuth;
		}
	});
	var idtokenclient_1 = require_idtokenclient();
	Object.defineProperty(exports, "IdTokenClient", {
		enumerable: true,
		get: function() {
			return idtokenclient_1.IdTokenClient;
		}
	});
	var jwtaccess_1 = require_jwtaccess();
	Object.defineProperty(exports, "JWTAccess", {
		enumerable: true,
		get: function() {
			return jwtaccess_1.JWTAccess;
		}
	});
	var jwtclient_1 = require_jwtclient();
	Object.defineProperty(exports, "JWT", {
		enumerable: true,
		get: function() {
			return jwtclient_1.JWT;
		}
	});
	var impersonated_1 = require_impersonated();
	Object.defineProperty(exports, "Impersonated", {
		enumerable: true,
		get: function() {
			return impersonated_1.Impersonated;
		}
	});
	var oauth2client_1 = require_oauth2client();
	Object.defineProperty(exports, "CodeChallengeMethod", {
		enumerable: true,
		get: function() {
			return oauth2client_1.CodeChallengeMethod;
		}
	});
	Object.defineProperty(exports, "OAuth2Client", {
		enumerable: true,
		get: function() {
			return oauth2client_1.OAuth2Client;
		}
	});
	Object.defineProperty(exports, "ClientAuthentication", {
		enumerable: true,
		get: function() {
			return oauth2client_1.ClientAuthentication;
		}
	});
	var loginticket_1 = require_loginticket();
	Object.defineProperty(exports, "LoginTicket", {
		enumerable: true,
		get: function() {
			return loginticket_1.LoginTicket;
		}
	});
	var refreshclient_1 = require_refreshclient();
	Object.defineProperty(exports, "UserRefreshClient", {
		enumerable: true,
		get: function() {
			return refreshclient_1.UserRefreshClient;
		}
	});
	var awsclient_1 = require_awsclient();
	Object.defineProperty(exports, "AwsClient", {
		enumerable: true,
		get: function() {
			return awsclient_1.AwsClient;
		}
	});
	var awsrequestsigner_1 = require_awsrequestsigner();
	Object.defineProperty(exports, "AwsRequestSigner", {
		enumerable: true,
		get: function() {
			return awsrequestsigner_1.AwsRequestSigner;
		}
	});
	var identitypoolclient_1 = require_identitypoolclient();
	Object.defineProperty(exports, "IdentityPoolClient", {
		enumerable: true,
		get: function() {
			return identitypoolclient_1.IdentityPoolClient;
		}
	});
	var externalclient_1 = require_externalclient();
	Object.defineProperty(exports, "ExternalAccountClient", {
		enumerable: true,
		get: function() {
			return externalclient_1.ExternalAccountClient;
		}
	});
	var baseexternalclient_1 = require_baseexternalclient();
	Object.defineProperty(exports, "BaseExternalAccountClient", {
		enumerable: true,
		get: function() {
			return baseexternalclient_1.BaseExternalAccountClient;
		}
	});
	var downscopedclient_1 = require_downscopedclient();
	Object.defineProperty(exports, "DownscopedClient", {
		enumerable: true,
		get: function() {
			return downscopedclient_1.DownscopedClient;
		}
	});
	var pluggable_auth_client_1 = require_pluggable_auth_client();
	Object.defineProperty(exports, "PluggableAuthClient", {
		enumerable: true,
		get: function() {
			return pluggable_auth_client_1.PluggableAuthClient;
		}
	});
	Object.defineProperty(exports, "ExecutableError", {
		enumerable: true,
		get: function() {
			return pluggable_auth_client_1.ExecutableError;
		}
	});
	var externalAccountAuthorizedUserClient_1 = require_externalAccountAuthorizedUserClient();
	Object.defineProperty(exports, "EXTERNAL_ACCOUNT_AUTHORIZED_USER_TYPE", {
		enumerable: true,
		get: function() {
			return externalAccountAuthorizedUserClient_1.EXTERNAL_ACCOUNT_AUTHORIZED_USER_TYPE;
		}
	});
	Object.defineProperty(exports, "ExternalAccountAuthorizedUserClient", {
		enumerable: true,
		get: function() {
			return externalAccountAuthorizedUserClient_1.ExternalAccountAuthorizedUserClient;
		}
	});
	var passthrough_1 = require_passthrough();
	Object.defineProperty(exports, "PassThroughClient", {
		enumerable: true,
		get: function() {
			return passthrough_1.PassThroughClient;
		}
	});
	__exportStar(require_googleToken(), exports);
	exports.auth = new googleauth_1.GoogleAuth();
})))();
const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_ISSUER = "chat@system.gserviceaccount.com";
const ADDON_ISSUER_PATTERN = /^service-\d+@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const CHAT_CERTS_URL = "https://www.googleapis.com/service_accounts/v1/metadata/x509/chat@system.gserviceaccount.com";
const MAX_AUTH_CACHE_SIZE = 32;
const authCache = /* @__PURE__ */ new Map();
const verifyClient = new import_src.OAuth2Client();
let cachedCerts = null;
function buildAuthKey(account) {
	if (account.credentialsFile) {return `file:${account.credentialsFile}`;}
	if (account.credentials) {return `inline:${JSON.stringify(account.credentials)}`;}
	return "none";
}
function getAuthInstance(account) {
	const key = buildAuthKey(account);
	const cached = authCache.get(account.accountId);
	if (cached && cached.key === key) {return cached.auth;}
	const evictOldest = () => {
		if (authCache.size > MAX_AUTH_CACHE_SIZE) {
			const oldest = authCache.keys().next().value;
			if (oldest !== void 0) {authCache.delete(oldest);}
		}
	};
	if (account.credentialsFile) {
		const auth = new import_src.GoogleAuth({
			keyFile: account.credentialsFile,
			scopes: [CHAT_SCOPE]
		});
		authCache.set(account.accountId, {
			key,
			auth
		});
		evictOldest();
		return auth;
	}
	if (account.credentials) {
		const auth = new import_src.GoogleAuth({
			credentials: account.credentials,
			scopes: [CHAT_SCOPE]
		});
		authCache.set(account.accountId, {
			key,
			auth
		});
		evictOldest();
		return auth;
	}
	const auth = new import_src.GoogleAuth({ scopes: [CHAT_SCOPE] });
	authCache.set(account.accountId, {
		key,
		auth
	});
	evictOldest();
	return auth;
}
async function getGoogleChatAccessToken(account) {
	const access = await (await getAuthInstance(account).getClient()).getAccessToken();
	const token = typeof access === "string" ? access : access?.token;
	if (!token) {throw new Error("Missing Google Chat access token");}
	return token;
}
async function fetchChatCerts() {
	const now = Date.now();
	if (cachedCerts && now - cachedCerts.fetchedAt < 600 * 1e3) {return cachedCerts.certs;}
	const res = await fetch(CHAT_CERTS_URL);
	if (!res.ok) {throw new Error(`Failed to fetch Chat certs (${res.status})`);}
	const certs = await res.json();
	cachedCerts = {
		fetchedAt: now,
		certs
	};
	return certs;
}
async function verifyGoogleChatRequest(params) {
	const bearer = params.bearer?.trim();
	if (!bearer) {return {
		ok: false,
		reason: "missing token"
	};}
	const audience = params.audience?.trim();
	if (!audience) {return {
		ok: false,
		reason: "missing audience"
	};}
	const audienceType = params.audienceType ?? null;
	if (audienceType === "app-url") {try {
		const payload = (await verifyClient.verifyIdToken({
			idToken: bearer,
			audience
		})).getPayload();
		const email = String(payload?.email ?? "").trim().toLowerCase();
		if (!payload?.email_verified) return {
			ok: false,
			reason: "email not verified"
		};
		if (email === CHAT_ISSUER) return { ok: true };
		if (!ADDON_ISSUER_PATTERN.test(email)) return {
			ok: false,
			reason: `invalid issuer: ${email}`
		};
		const expectedAddOnPrincipal = params.expectedAddOnPrincipal?.trim().toLowerCase();
		if (!expectedAddOnPrincipal) return {
			ok: false,
			reason: "missing add-on principal binding"
		};
		const tokenPrincipal = String(payload?.sub ?? "").trim().toLowerCase();
		if (!tokenPrincipal || tokenPrincipal !== expectedAddOnPrincipal) return {
			ok: false,
			reason: `unexpected add-on principal: ${tokenPrincipal || "<missing>"}`
		};
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : "invalid token"
		};
	}}
	if (audienceType === "project-number") {try {
		const certs = await fetchChatCerts();
		await verifyClient.verifySignedJwtWithCertsAsync(bearer, certs, audience, [CHAT_ISSUER]);
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			reason: err instanceof Error ? err.message : "invalid token"
		};
	}}
	return {
		ok: false,
		reason: "unsupported audience type"
	};
}
//#endregion
//#region extensions/googlechat/src/api.ts
const CHAT_API_BASE = "https://chat.googleapis.com/v1";
const CHAT_UPLOAD_BASE = "https://chat.googleapis.com/upload/v1";
const headersToObject = (headers) => headers instanceof Headers ? Object.fromEntries(headers.entries()) : Array.isArray(headers) ? Object.fromEntries(headers) : headers || {};
async function withGoogleChatResponse(params) {
	const { account, url, init, auditContext, errorPrefix = "Google Chat API", handleResponse } = params;
	const token = await getGoogleChatAccessToken(account);
	const { response, release } = await fetchWithSsrFGuard({
		url,
		init: {
			...init,
			headers: {
				...headersToObject(init?.headers),
				Authorization: `Bearer ${token}`
			}
		},
		auditContext
	});
	try {
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`${errorPrefix} ${response.status}: ${text || response.statusText}`);
		}
		return await handleResponse(response);
	} finally {
		await release();
	}
}
async function fetchJson(account, url, init) {
	return await withGoogleChatResponse({
		account,
		url,
		init: {
			...init,
			headers: {
				...headersToObject(init.headers),
				"Content-Type": "application/json"
			}
		},
		auditContext: "googlechat.api.json",
		handleResponse: async (response) => await response.json()
	});
}
async function fetchOk(account, url, init) {
	await withGoogleChatResponse({
		account,
		url,
		init,
		auditContext: "googlechat.api.ok",
		handleResponse: async () => void 0
	});
}
async function fetchBuffer(account, url, init, options) {
	return await withGoogleChatResponse({
		account,
		url,
		init,
		auditContext: "googlechat.api.buffer",
		handleResponse: async (res) => {
			const maxBytes = options?.maxBytes;
			const lengthHeader = res.headers.get("content-length");
			if (maxBytes && lengthHeader) {
				const length = Number(lengthHeader);
				if (Number.isFinite(length) && length > maxBytes) {throw new Error(`Google Chat media exceeds max bytes (${maxBytes})`);}
			}
			if (!maxBytes || !res.body) {return {
				buffer: Buffer.from(await res.arrayBuffer()),
				contentType: res.headers.get("content-type") ?? void 0
			};}
			const reader = res.body.getReader();
			const chunks = [];
			let total = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) {break;}
				if (!value) {continue;}
				total += value.length;
				if (total > maxBytes) {
					await reader.cancel();
					throw new Error(`Google Chat media exceeds max bytes (${maxBytes})`);
				}
				chunks.push(Buffer.from(value));
			}
			return {
				buffer: Buffer.concat(chunks, total),
				contentType: res.headers.get("content-type") ?? void 0
			};
		}
	});
}
async function sendGoogleChatMessage(params) {
	const { account, space, text, thread, attachments } = params;
	const body = {};
	if (text) {body.text = text;}
	if (thread) {body.thread = { name: thread };}
	if (attachments && attachments.length > 0) {body.attachment = attachments.map((item) => ({
		attachmentDataRef: { attachmentUploadToken: item.attachmentUploadToken },
		...item.contentName ? { contentName: item.contentName } : {}
	}));}
	const urlObj = new URL(`${CHAT_API_BASE}/${space}/messages`);
	if (thread) {urlObj.searchParams.set("messageReplyOption", "REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD");}
	const result = await fetchJson(account, urlObj.toString(), {
		method: "POST",
		body: JSON.stringify(body)
	});
	return result ? { messageName: result.name } : null;
}
async function updateGoogleChatMessage(params) {
	const { account, messageName, text } = params;
	return { messageName: (await fetchJson(account, `${CHAT_API_BASE}/${messageName}?updateMask=text`, {
		method: "PATCH",
		body: JSON.stringify({ text })
	})).name };
}
async function deleteGoogleChatMessage(params) {
	const { account, messageName } = params;
	await fetchOk(account, `${CHAT_API_BASE}/${messageName}`, { method: "DELETE" });
}
async function uploadGoogleChatAttachment(params) {
	const { account, space, filename, buffer, contentType } = params;
	const boundary = `openclaw-${crypto.randomUUID()}`;
	const header = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ filename })}\r\n`;
	const mediaHeader = `--${boundary}\r\nContent-Type: ${contentType ?? "application/octet-stream"}\r\n\r\n`;
	const footer = `\r\n--${boundary}--\r\n`;
	const body = Buffer.concat([
		Buffer.from(header, "utf8"),
		Buffer.from(mediaHeader, "utf8"),
		buffer,
		Buffer.from(footer, "utf8")
	]);
	return { attachmentUploadToken: (await withGoogleChatResponse({
		account,
		url: `${CHAT_UPLOAD_BASE}/${space}/attachments:upload?uploadType=multipart`,
		init: {
			method: "POST",
			headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
			body
		},
		auditContext: "googlechat.upload",
		errorPrefix: "Google Chat upload",
		handleResponse: async (response) => await response.json()
	})).attachmentDataRef?.attachmentUploadToken };
}
async function downloadGoogleChatMedia(params) {
	const { account, resourceName, maxBytes } = params;
	return await fetchBuffer(account, `${CHAT_API_BASE}/media/${resourceName}?alt=media`, void 0, { maxBytes });
}
async function createGoogleChatReaction(params) {
	const { account, messageName, emoji } = params;
	return await fetchJson(account, `${CHAT_API_BASE}/${messageName}/reactions`, {
		method: "POST",
		body: JSON.stringify({ emoji: { unicode: emoji } })
	});
}
async function listGoogleChatReactions(params) {
	const { account, messageName, limit } = params;
	const url = new URL(`${CHAT_API_BASE}/${messageName}/reactions`);
	if (limit && limit > 0) {url.searchParams.set("pageSize", String(limit));}
	return (await fetchJson(account, url.toString(), { method: "GET" })).reactions ?? [];
}
async function deleteGoogleChatReaction(params) {
	const { account, reactionName } = params;
	await fetchOk(account, `${CHAT_API_BASE}/${reactionName}`, { method: "DELETE" });
}
async function findGoogleChatDirectMessage(params) {
	const { account, userName } = params;
	const url = new URL(`${CHAT_API_BASE}/spaces:findDirectMessage`);
	url.searchParams.set("name", userName);
	return await fetchJson(account, url.toString(), { method: "GET" });
}
async function probeGoogleChat(account) {
	try {
		const url = new URL(`${CHAT_API_BASE}/spaces`);
		url.searchParams.set("pageSize", "1");
		await fetchJson(account, url.toString(), { method: "GET" });
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
export { googlechatSetupAdapter as _, findGoogleChatDirectMessage as a, sendGoogleChatMessage as c, verifyGoogleChatRequest as d, googlechatSetupWizard as f, resolveGoogleChatAccount as g, resolveDefaultGoogleChatAccountId as h, downloadGoogleChatMedia as i, updateGoogleChatMessage as l, listGoogleChatAccountIds as m, deleteGoogleChatMessage as n, listGoogleChatReactions as o, listEnabledGoogleChatAccounts as p, deleteGoogleChatReaction as r, probeGoogleChat as s, createGoogleChatReaction as t, uploadGoogleChatAttachment as u };

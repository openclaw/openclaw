import { t as __commonJSMin } from "./chunk-A-jGZS85.js";
import { n as require_axios, t as require_lib } from "./lib-BGtC90ky.js";
//#region node_modules/@microsoft/teams.common/dist/logging/ansi.js
var require_ansi = /* @__PURE__ */ __commonJSMin(((exports) => {
	var ANSI = /* @__PURE__ */ ((ANSI2) => {
		ANSI2["Reset"] = "\x1B[0m";
		ANSI2["Bold"] = "\x1B[1m";
		ANSI2["BoldReset"] = "\x1B[22m";
		ANSI2["Italic"] = "\x1B[3m";
		ANSI2["ItalicReset"] = "\x1B[23m";
		ANSI2["Underline"] = "\x1B[4m";
		ANSI2["UnderlineReset"] = "\x1B[24m";
		ANSI2["Strike"] = "\x1B[9m";
		ANSI2["StrikeReset"] = "\x1B[29m";
		ANSI2["ForegroundReset"] = "\x1B[0m";
		ANSI2["BackgroundReset"] = "\x1B[0m";
		ANSI2["ForegroundBlack"] = "\x1B[30m";
		ANSI2["BackgroundBlack"] = "\x1B[40m";
		ANSI2["ForegroundRed"] = "\x1B[31m";
		ANSI2["BackgroundRed"] = "\x1B[41m";
		ANSI2["ForegroundGreen"] = "\x1B[32m";
		ANSI2["BackgroundGreen"] = "\x1B[42m";
		ANSI2["ForegroundYellow"] = "\x1B[33m";
		ANSI2["BackgroundYellow"] = "\x1B[43m";
		ANSI2["ForegroundBlue"] = "\x1B[34m";
		ANSI2["BackgroundBlue"] = "\x1B[44m";
		ANSI2["ForegroundMagenta"] = "\x1B[35m";
		ANSI2["BackgroundMagenta"] = "\x1B[45m";
		ANSI2["ForegroundCyan"] = "\x1B[36m";
		ANSI2["BackgroundCyan"] = "\x1B[46m";
		ANSI2["ForegroundWhite"] = "\x1B[37m";
		ANSI2["BackgroundWhite"] = "\x1B[47m";
		ANSI2["ForegroundGray"] = "\x1B[90m";
		ANSI2["ForegroundDefault"] = "\x1B[39m";
		ANSI2["BackgroundDefault"] = "\x1B[49m";
		return ANSI2;
	})(ANSI || {});
	exports.ANSI = ANSI;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/logging/console.js
var require_console = /* @__PURE__ */ __commonJSMin(((exports) => {
	var ansi = require_ansi();
	var ConsoleLogger = class ConsoleLogger {
		loggerOptions;
		name;
		level;
		_enabled;
		_levels = {
			error: 100,
			warn: 200,
			info: 300,
			debug: 400,
			trace: 500
		};
		_colors = {
			error: ansi.ANSI.ForegroundRed,
			warn: ansi.ANSI.ForegroundYellow,
			info: ansi.ANSI.ForegroundCyan,
			debug: ansi.ANSI.ForegroundMagenta,
			trace: ansi.ANSI.BackgroundBlue
		};
		constructor(name, options) {
			this.name = name;
			const env = typeof process === "undefined" ? void 0 : process.env;
			const logNamePattern = env?.LOG || options?.pattern || "*";
			this._enabled = parseMagicExpr(logNamePattern).test(name);
			this.level = parseLogLevel(env?.LOG_LEVEL) || options?.level || "info";
			this.loggerOptions = options ?? {
				level: this.level,
				pattern: logNamePattern
			};
		}
		error(...msg) {
			this.log("error", ...msg);
		}
		warn(...msg) {
			this.log("warn", ...msg);
		}
		info(...msg) {
			this.log("info", ...msg);
		}
		debug(...msg) {
			this.log("debug", ...msg);
		}
		trace(...msg) {
			this.log("trace", ...msg);
		}
		log(level, ...msg) {
			if (!this._enabled) return;
			if (this._levels[level] > this._levels[this.level]) return;
			const prefix = [
				this._colors[level],
				ansi.ANSI.Bold,
				`[${level.toUpperCase()}]`
			];
			const name = [
				this.name,
				ansi.ANSI.ForegroundReset,
				ansi.ANSI.BoldReset
			];
			for (const m of msg) {
				let text = new String(m);
				if (typeof m === "object") text = JSON.stringify(m, null, 2);
				for (const line of text.split("\n")) console[level](prefix.join(""), name.join(""), line);
			}
		}
		child(name, overrideOptions) {
			const mergedPattern = mergePatterns(this.loggerOptions.pattern, overrideOptions?.pattern);
			return new ConsoleLogger(`${this.name}/${name}`, {
				...this.loggerOptions,
				...overrideOptions,
				pattern: mergedPattern
			});
		}
	};
	function parsePatternString(pattern) {
		const patterns = pattern.split(",").map((p) => p.trim());
		const inclusions = [];
		const exclusions = [];
		for (const p of patterns) if (p.startsWith("-")) exclusions.push(p.substring(1));
		else inclusions.push(p);
		return {
			inclusions,
			exclusions
		};
	}
	function parseMagicExpr(pattern) {
		const { inclusions: inclusionPatterns, exclusions: exclusionPatterns } = parsePatternString(pattern);
		const inclusions = inclusionPatterns.map((p) => patternToRegex(p));
		const exclusions = exclusionPatterns.map((p) => patternToRegex(p));
		if (inclusions.length === 0 && exclusions.length > 0) inclusions.push(/.*/);
		return { test: (name) => {
			if (!inclusions.some((regex) => regex.test(name))) return false;
			return !exclusions.some((regex) => regex.test(name));
		} };
	}
	function patternToRegex(pattern) {
		let res = "";
		const parts = pattern.split("*");
		for (let i = 0; i < parts.length; i++) {
			if (i > 0) res += ".*";
			res += parts[i];
		}
		return new RegExp(res);
	}
	function mergePatterns(parentPattern, childPattern) {
		if (!parentPattern && !childPattern) return "*";
		if (!parentPattern) return childPattern;
		if (!childPattern) return parentPattern;
		const parent = parsePatternString(parentPattern);
		const child = parsePatternString(childPattern);
		let allInclusions = [.../* @__PURE__ */ new Set([...parent.inclusions, ...child.inclusions])];
		if (allInclusions.length === 0) allInclusions = ["*"];
		const optimizedInclusions = allInclusions.includes("*") ? ["*"] : allInclusions;
		const allExclusions = [.../* @__PURE__ */ new Set([...parent.exclusions, ...child.exclusions])];
		const inclusionStrings = optimizedInclusions;
		const exclusionStrings = allExclusions.map((e) => "-" + e);
		return [...inclusionStrings, ...exclusionStrings].join(",");
	}
	function parseLogLevel(level) {
		const value = level?.toLowerCase();
		switch (value) {
			case "error":
			case "warn":
			case "info":
			case "debug":
			case "trace": return value;
			default: return;
		}
	}
	exports.ConsoleLogger = ConsoleLogger;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/logging/logger.js
var require_logger = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/logging/string.js
var require_string = /* @__PURE__ */ __commonJSMin(((exports) => {
	var ansi = require_ansi();
	var String = class {
		_value;
		constructor(value = "") {
			this._value = value;
		}
		clear() {
			this._value = "";
			return this;
		}
		append(...text) {
			this._value += text.join("");
			return this;
		}
		reset() {
			this._value += ansi.ANSI.Reset;
			return this;
		}
		bold(text) {
			this._value += ansi.ANSI.Bold + text.toString() + ansi.ANSI.BoldReset;
			return this;
		}
		italic(text) {
			this._value += ansi.ANSI.Italic + text.toString() + ansi.ANSI.ItalicReset;
			return this;
		}
		underline(text) {
			this._value += ansi.ANSI.Underline + text.toString() + ansi.ANSI.UnderlineReset;
			return this;
		}
		strike(text) {
			this._value += ansi.ANSI.Strike + text.toString() + ansi.ANSI.StrikeReset;
			return this;
		}
		black(text) {
			this._value += ansi.ANSI.ForegroundBlack + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgBlack(text) {
			this._value += ansi.ANSI.BackgroundBlack + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		red(text) {
			this._value += ansi.ANSI.ForegroundRed + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgRed(text) {
			this._value += ansi.ANSI.BackgroundRed + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		green(text) {
			this._value += ansi.ANSI.ForegroundGreen + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgGreen(text) {
			this._value += ansi.ANSI.BackgroundGreen + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		yellow(text) {
			this._value += ansi.ANSI.ForegroundYellow + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgYellow(text) {
			this._value += ansi.ANSI.BackgroundYellow + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		blue(text) {
			this._value += ansi.ANSI.ForegroundBlue + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgBlue(text) {
			this._value += ansi.ANSI.BackgroundBlue + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		magenta(text) {
			this._value += ansi.ANSI.ForegroundMagenta + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgMagenta(text) {
			this._value += ansi.ANSI.BackgroundMagenta + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		cyan(text) {
			this._value += ansi.ANSI.ForegroundCyan + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgCyan(text) {
			this._value += ansi.ANSI.BackgroundCyan + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		white(text) {
			this._value += ansi.ANSI.ForegroundWhite + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgWhite(text) {
			this._value += ansi.ANSI.BackgroundWhite + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		gray(text) {
			this._value += ansi.ANSI.ForegroundGray + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		default(text) {
			this._value += ansi.ANSI.ForegroundDefault + text.toString() + ansi.ANSI.ForegroundReset;
			return this;
		}
		bgDefault(text) {
			this._value += ansi.ANSI.BackgroundDefault + text.toString() + ansi.ANSI.BackgroundReset;
			return this;
		}
		toString() {
			return this._value;
		}
	};
	exports.String = String;
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/logging/index.js
var require_logging = /* @__PURE__ */ __commonJSMin(((exports) => {
	var console = require_console();
	var logger = require_logger();
	var string = require_string();
	Object.keys(console).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return console[k];
			}
		});
	});
	Object.keys(logger).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return logger[k];
			}
		});
	});
	Object.keys(string).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return string[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/http/client.js
var require_client = /* @__PURE__ */ __commonJSMin(((exports) => {
	var axios = require_axios();
	var logging = require_logging();
	function _interopDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	var axios__default = /* @__PURE__ */ _interopDefault(axios);
	exports.Client = class Client {
		token;
		name;
		options;
		log;
		http;
		seq = 0;
		interceptors;
		constructor(options = {}) {
			this.options = options;
			this.name = options.name || "http";
			this.token = options.token;
			this.log = options.logger || new logging.ConsoleLogger(this.name);
			this.interceptors = /* @__PURE__ */ new Map();
			this.http = axios__default.default.create({
				baseURL: options.baseUrl,
				timeout: options.timeout,
				headers: options.headers
			});
			for (const interceptor of options.interceptors || []) this.use(interceptor);
		}
		async get(url, config) {
			return this.http.get(url, await this.withConfig(config));
		}
		async post(url, data, config) {
			return this.http.post(url, data, await this.withConfig(config));
		}
		async put(url, data, config) {
			return this.http.put(url, data, await this.withConfig(config));
		}
		async patch(url, data, config) {
			return this.http.patch(url, data, await this.withConfig(config));
		}
		async delete(url, config) {
			return this.http.delete(url, await this.withConfig(config));
		}
		async request(config) {
			return this.http.request(await this.withConfig(config));
		}
		/**
		* Register an interceptor to use
		* as middleware for the request/response/error
		*/
		use(interceptor) {
			const id = ++this.seq;
			let requestId = void 0;
			let responseId = void 0;
			if (interceptor.request) requestId = this.http.interceptors.request.use(
				/* istanbul ignore next */
				(config) => {
					return interceptor.request({
						config,
						log: this.log
					});
				},
				/* istanbul ignore next */
				(error) => {
					if (!interceptor.error) return error;
					return interceptor.error({
						error,
						log: this.log
					});
				}
			);
			if (interceptor.response) responseId = this.http.interceptors.response.use(
				/* istanbul ignore next */
				(res) => {
					return interceptor.response({
						res,
						log: this.log
					});
				},
				/* istanbul ignore next */
				(error) => {
					if (!interceptor.error) return error;
					return interceptor.error({
						error,
						log: this.log
					});
				}
			);
			this.interceptors.set(id, {
				requestId,
				responseId,
				interceptor
			});
			return id;
		}
		/**
		* Eject an interceptor
		*/
		eject(id) {
			const registry = this.interceptors.get(id);
			if (!registry) return;
			if (registry.requestId) this.http.interceptors.request.eject(registry.requestId);
			if (registry.responseId) this.http.interceptors.response.eject(registry.responseId);
			this.interceptors.delete(id);
		}
		/**
		* Clear (Eject) all interceptors
		*/
		clear() {
			for (const id of this.interceptors.keys()) this.eject(id);
		}
		/**
		* Create a copy of the client
		*/
		clone(options) {
			const findUA = (h) => {
				if (!h) return void 0;
				const key = Object.keys(h).find((k) => k.toLowerCase() === "user-agent");
				return key ? String(h[key]) : void 0;
			};
			const parentUA = findUA(this.options.headers);
			const childUA = findUA(options?.headers);
			const mergedUA = parentUA && childUA ? `${childUA} ${parentUA}` : childUA || parentUA;
			const headers = {
				...this.options.headers,
				...options?.headers
			};
			if (mergedUA) {
				for (const key of Object.keys(headers)) if (key.toLowerCase() === "user-agent") delete headers[key];
				headers["User-Agent"] = mergedUA;
			}
			return new Client({
				...this.options,
				...options,
				headers,
				interceptors: [...Array.from(this.interceptors.values()).map((i) => i.interceptor)]
			});
		}
		async withConfig(config = {}) {
			let token = config.token || this.token;
			if (config.token) delete config.token;
			if (this.options.headers) {
				if (!config.headers) config.headers = {};
				for (const key in this.options.headers) config.headers[key] = this.options.headers[key];
			}
			if (token) {
				if (!config.headers) config.headers = {};
				if (typeof token === "function") token = await token(config);
				if (token && typeof token === "object") token = token.toString();
				config.headers["Authorization"] = `Bearer ${token}`;
			}
			return config;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/http/interceptor.js
var require_interceptor = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/http/token.js
var require_token$3 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.common/dist/http/index.js
var require_http = /* @__PURE__ */ __commonJSMin(((exports) => {
	var client = require_client();
	var interceptor = require_interceptor();
	var token = require_token$3();
	Object.keys(client).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return client[k];
			}
		});
	});
	Object.keys(interceptor).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return interceptor[k];
			}
		});
	});
	Object.keys(token).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return token[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/api-client-settings.js
var require_api_client_settings = /* @__PURE__ */ __commonJSMin(((exports) => {
	const DEFAULT_API_CLIENT_SETTINGS = { oauthUrl: "https://token.botframework.com" };
	function mergeApiClientSettings(apiClientSettings, cloud) {
		const env = typeof process === "undefined" ? void 0 : process.env;
		const defaultOauthUrl = cloud?.tokenServiceUrl ?? DEFAULT_API_CLIENT_SETTINGS.oauthUrl;
		return { oauthUrl: apiClientSettings?.oauthUrl ?? env?.OAUTH_URL ?? defaultOauthUrl };
	}
	exports.DEFAULT_API_CLIENT_SETTINGS = DEFAULT_API_CLIENT_SETTINGS;
	exports.mergeApiClientSettings = mergeApiClientSettings;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/bot/sign-in.js
var require_sign_in$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var qs = require_lib();
	var http = require_http();
	var apiClientSettings = require_api_client_settings();
	function _interopDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	var qs__default = /* @__PURE__ */ _interopDefault(qs);
	const BOT_SIGNIN_ENDPOINTS = {
		URL: "api/botsignin/GetSignInUrl",
		RESOURCE: "api/botsignin/GetSignInResource"
	};
	var BotSignInClient = class {
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(options, apiClientSettings$1) {
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async getUrl(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.get(`${this._apiClientSettings.oauthUrl}/${BOT_SIGNIN_ENDPOINTS.URL}?${q}`)).data;
		}
		async getResource(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.get(`${this._apiClientSettings.oauthUrl}/${BOT_SIGNIN_ENDPOINTS.RESOURCE}?${q}`)).data;
		}
	};
	exports.BOT_SIGNIN_ENDPOINTS = BOT_SIGNIN_ENDPOINTS;
	exports.BotSignInClient = BotSignInClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/bot/index.js
var require_bot = /* @__PURE__ */ __commonJSMin(((exports) => {
	var http = require_http();
	var apiClientSettings = require_api_client_settings();
	var signIn = require_sign_in$3();
	var BotClient = class {
		signIn;
		get http() {
			return this._http;
		}
		set http(v) {
			this.signIn.http = v;
			this._http = v;
		}
		_http;
		_clientSettings;
		constructor(options, clientSettings) {
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._clientSettings = apiClientSettings.mergeApiClientSettings(clientSettings);
			this.signIn = new signIn.BotSignInClient(this.http, this._clientSettings);
		}
	};
	exports.BotClient = BotClient;
	Object.keys(signIn).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signIn[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/token-post-resource.js
var require_token_post_resource = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/token-request.js
var require_token_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/token-response.js
var require_token_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/token-status.js
var require_token_status = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token/index.js
var require_token$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var tokenPostResource = require_token_post_resource();
	var tokenRequest = require_token_request();
	var tokenResponse = require_token_response();
	var tokenStatus = require_token_status();
	Object.keys(tokenPostResource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenPostResource[k];
			}
		});
	});
	Object.keys(tokenRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenRequest[k];
			}
		});
	});
	Object.keys(tokenResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenResponse[k];
			}
		});
	});
	Object.keys(tokenStatus).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenStatus[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-invoke-request.js
var require_token_exchange_invoke_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-invoke-response.js
var require_token_exchange_invoke_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-request.js
var require_token_exchange_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-resource.js
var require_token_exchange_resource = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/token-exchange-state.js
var require_token_exchange_state = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/token-exchange/index.js
var require_token_exchange$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var tokenExchangeInvokeRequest = require_token_exchange_invoke_request();
	var tokenExchangeInvokeResponse = require_token_exchange_invoke_response();
	var tokenExchangeRequest = require_token_exchange_request();
	var tokenExchangeResource = require_token_exchange_resource();
	var tokenExchangeState = require_token_exchange_state();
	Object.keys(tokenExchangeInvokeRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeInvokeRequest[k];
			}
		});
	});
	Object.keys(tokenExchangeInvokeResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeInvokeResponse[k];
			}
		});
	});
	Object.keys(tokenExchangeRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeRequest[k];
			}
		});
	});
	Object.keys(tokenExchangeResource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeResource[k];
			}
		});
	});
	Object.keys(tokenExchangeState).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchangeState[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-card.js
var require_sign_in_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-url-response.js
var require_sign_in_url_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-state-verify-query.js
var require_sign_in_state_verify_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-exchange-token.js
var require_sign_in_exchange_token = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/sign-in-failure.js
var require_sign_in_failure = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/sign-in/index.js
var require_sign_in$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var signInCard = require_sign_in_card();
	var signInUrlResponse = require_sign_in_url_response();
	var signInStateVerifyQuery = require_sign_in_state_verify_query();
	var signInExchangeToken = require_sign_in_exchange_token();
	var signInFailure = require_sign_in_failure();
	Object.keys(signInCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInCard[k];
			}
		});
	});
	Object.keys(signInUrlResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInUrlResponse[k];
			}
		});
	});
	Object.keys(signInStateVerifyQuery).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInStateVerifyQuery[k];
			}
		});
	});
	Object.keys(signInExchangeToken).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInExchangeToken[k];
			}
		});
	});
	Object.keys(signInFailure).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signInFailure[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/oauth/oauth-card.js
var require_oauth_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/oauth/index.js
var require_oauth = /* @__PURE__ */ __commonJSMin(((exports) => {
	var oauthCard = require_oauth_card();
	Object.keys(oauthCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return oauthCard[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/role.js
var require_role = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/account.js
var require_account = /* @__PURE__ */ __commonJSMin(((exports) => {
	function resolveAadObjectId(data) {
		return {
			...data,
			aadObjectId: data.aadObjectId ?? data.objectId
		};
	}
	exports.resolveAadObjectId = resolveAadObjectId;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/client-info-entity.js
var require_client_info_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/mention-entity.js
var require_mention_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/message-entity.js
var require_message_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/ai-message-entity.js
var require_ai_message_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/stream-info-entity.js
var require_stream_info_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/citation-entity.js
var require_citation_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/sensitive-usage-entity.js
var require_sensitive_usage_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/product-info-entity.js
var require_product_info_entity = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/entity/index.js
var require_entity = /* @__PURE__ */ __commonJSMin(((exports) => {
	var clientInfoEntity = require_client_info_entity();
	var mentionEntity = require_mention_entity();
	var messageEntity = require_message_entity();
	var aiMessageEntity = require_ai_message_entity();
	var streamInfoEntity = require_stream_info_entity();
	var citationEntity = require_citation_entity();
	var sensitiveUsageEntity = require_sensitive_usage_entity();
	var productInfoEntity = require_product_info_entity();
	Object.keys(clientInfoEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return clientInfoEntity[k];
			}
		});
	});
	Object.keys(mentionEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return mentionEntity[k];
			}
		});
	});
	Object.keys(messageEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageEntity[k];
			}
		});
	});
	Object.keys(aiMessageEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return aiMessageEntity[k];
			}
		});
	});
	Object.keys(streamInfoEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return streamInfoEntity[k];
			}
		});
	});
	Object.keys(citationEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return citationEntity[k];
			}
		});
	});
	Object.keys(sensitiveUsageEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return sensitiveUsageEntity[k];
			}
		});
	});
	Object.keys(productInfoEntity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return productInfoEntity[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/input-hint.js
var require_input_hint = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/text-format.js
var require_text_format = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/attachment/attachment.js
var require_attachment$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/attachment/card-attachment.js
var require_card_attachment = /* @__PURE__ */ __commonJSMin(((exports) => {
	function cardAttachment(type, content) {
		return {
			contentType: `application/vnd.microsoft.card.${type}`,
			content
		};
	}
	exports.cardAttachment = cardAttachment;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/attachment/attachment-layout.js
var require_attachment_layout = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/attachment/index.js
var require_attachment = /* @__PURE__ */ __commonJSMin(((exports) => {
	var attachment = require_attachment$1();
	var cardAttachment = require_card_attachment();
	var attachmentLayout = require_attachment_layout();
	Object.keys(attachment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return attachment[k];
			}
		});
	});
	Object.keys(cardAttachment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cardAttachment[k];
			}
		});
	});
	Object.keys(attachmentLayout).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return attachmentLayout[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/suggested-actions.js
var require_suggested_actions = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/importance.js
var require_importance = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/delivery-mode.js
var require_delivery_mode = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/error.js
var require_error = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/conversation.js
var require_conversation$3 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/conversation-reference.js
var require_conversation_reference = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/conversation-resource.js
var require_conversation_resource = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/paged-members-result.js
var require_paged_members_result = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/conversation/index.js
var require_conversation$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var conversation = require_conversation$3();
	var conversationReference = require_conversation_reference();
	var conversationResource = require_conversation_resource();
	var pagedMembersResult = require_paged_members_result();
	Object.keys(conversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversation[k];
			}
		});
	});
	Object.keys(conversationReference).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversationReference[k];
			}
		});
	});
	Object.keys(conversationResource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversationResource[k];
			}
		});
	});
	Object.keys(pagedMembersResult).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return pagedMembersResult[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/resource.js
var require_resource = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/cache-info.js
var require_cache_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/config/config-auth.js
var require_config_auth = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/config/config-response.js
var require_config_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/config/index.js
var require_config$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var configAuth = require_config_auth();
	var configResponse = require_config_response();
	Object.keys(configAuth).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return configAuth[k];
			}
		});
	});
	Object.keys(configResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return configResponse[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-card-response.js
var require_task_module_card_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-continue-response.js
var require_task_module_continue_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-message-response.js
var require_task_module_message_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-response.js
var require_task_module_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-task-info.js
var require_task_module_task_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/task-module-request.js
var require_task_module_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/task-module/index.js
var require_task_module = /* @__PURE__ */ __commonJSMin(((exports) => {
	var taskModuleCardResponse = require_task_module_card_response();
	var taskModuleContinueResponse = require_task_module_continue_response();
	var taskModuleMessageResponse = require_task_module_message_response();
	var taskModuleResponse = require_task_module_response();
	var taskModuleTaskInfo = require_task_module_task_info();
	var taskModuleRequest = require_task_module_request();
	Object.keys(taskModuleCardResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleCardResponse[k];
			}
		});
	});
	Object.keys(taskModuleContinueResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleContinueResponse[k];
			}
		});
	});
	Object.keys(taskModuleMessageResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleMessageResponse[k];
			}
		});
	});
	Object.keys(taskModuleResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleResponse[k];
			}
		});
	});
	Object.keys(taskModuleTaskInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleTaskInfo[k];
			}
		});
	});
	Object.keys(taskModuleRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModuleRequest[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/file/file-consent-card.js
var require_file_consent_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/file/file-info-card.js
var require_file_info_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/file/file-upload-info.js
var require_file_upload_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/file/index.js
var require_file = /* @__PURE__ */ __commonJSMin(((exports) => {
	var fileConsentCard = require_file_consent_card();
	var fileInfoCard = require_file_info_card();
	var fileUploadInfo = require_file_upload_info();
	Object.keys(fileConsentCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fileConsentCard[k];
			}
		});
	});
	Object.keys(fileInfoCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fileInfoCard[k];
			}
		});
	});
	Object.keys(fileUploadInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fileUploadInfo[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/action.js
var require_action$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/o365/o365-connector-card-action-query.js
var require_o365_connector_card_action_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/o365/index.js
var require_o365 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var o365ConnectorCardActionQuery = require_o365_connector_card_action_query();
	Object.keys(o365ConnectorCardActionQuery).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return o365ConnectorCardActionQuery[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/app-based-link-query.js
var require_app_based_link_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-attachment.js
var require_messaging_extension_attachment = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-response.js
var require_messaging_extension_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-result.js
var require_messaging_extension_result = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-suggested-action.js
var require_messaging_extension_suggested_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-parameter.js
var require_messaging_extension_parameter = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-query.js
var require_messaging_extension_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-action.js
var require_messaging_extension_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-action-response.js
var require_messaging_extension_action_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/messaging-extension-attachment-layout.js
var require_messaging_extension_attachment_layout = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/messaging-extension/index.js
var require_messaging_extension = /* @__PURE__ */ __commonJSMin(((exports) => {
	var messagingExtensionAttachment = require_messaging_extension_attachment();
	var messagingExtensionResponse = require_messaging_extension_response();
	var messagingExtensionResult = require_messaging_extension_result();
	var messagingExtensionSuggestedAction = require_messaging_extension_suggested_action();
	var messagingExtensionParameter = require_messaging_extension_parameter();
	var messagingExtensionQuery = require_messaging_extension_query();
	var messagingExtensionAction = require_messaging_extension_action();
	var messagingExtensionActionResponse = require_messaging_extension_action_response();
	var messagingExtensionAttachmentLayout = require_messaging_extension_attachment_layout();
	Object.keys(messagingExtensionAttachment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionAttachment[k];
			}
		});
	});
	Object.keys(messagingExtensionResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionResponse[k];
			}
		});
	});
	Object.keys(messagingExtensionResult).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionResult[k];
			}
		});
	});
	Object.keys(messagingExtensionSuggestedAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionSuggestedAction[k];
			}
		});
	});
	Object.keys(messagingExtensionParameter).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionParameter[k];
			}
		});
	});
	Object.keys(messagingExtensionQuery).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionQuery[k];
			}
		});
	});
	Object.keys(messagingExtensionAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionAction[k];
			}
		});
	});
	Object.keys(messagingExtensionActionResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionActionResponse[k];
			}
		});
	});
	Object.keys(messagingExtensionAttachmentLayout).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtensionAttachmentLayout[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message.js
var require_message$4 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-app.js
var require_message_app = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-body.js
var require_message_body = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-conversation.js
var require_message_conversation = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-from.js
var require_message_from = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-mention.js
var require_message_mention = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-reaction.js
var require_message_reaction$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/message-user.js
var require_message_user = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/message/index.js
var require_message$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var message = require_message$4();
	var messageApp = require_message_app();
	var messageBody = require_message_body();
	var messageConversation = require_message_conversation();
	var messageFrom = require_message_from();
	var messageMention = require_message_mention();
	var messageReaction = require_message_reaction$1();
	var messageUser = require_message_user();
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(messageApp).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageApp[k];
			}
		});
	});
	Object.keys(messageBody).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageBody[k];
			}
		});
	});
	Object.keys(messageConversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageConversation[k];
			}
		});
	});
	Object.keys(messageFrom).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageFrom[k];
			}
		});
	});
	Object.keys(messageMention).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageMention[k];
			}
		});
	});
	Object.keys(messageReaction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageReaction[k];
			}
		});
	});
	Object.keys(messageUser).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageUser[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-entity-context.js
var require_tab_entity_context = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-context.js
var require_tab_context = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-request.js
var require_tab_request = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-response.js
var require_tab_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-response-card.js
var require_tab_response_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-submit.js
var require_tab_submit$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/tab-suggested-actions.js
var require_tab_suggested_actions = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/tab/index.js
var require_tab$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var tabEntityContext = require_tab_entity_context();
	var tabContext = require_tab_context();
	var tabRequest = require_tab_request();
	var tabResponse = require_tab_response();
	var tabResponseCard = require_tab_response_card();
	var tabSubmit = require_tab_submit$1();
	var tabSuggestedActions = require_tab_suggested_actions();
	Object.keys(tabEntityContext).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabEntityContext[k];
			}
		});
	});
	Object.keys(tabContext).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabContext[k];
			}
		});
	});
	Object.keys(tabRequest).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabRequest[k];
			}
		});
	});
	Object.keys(tabResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabResponse[k];
			}
		});
	});
	Object.keys(tabResponseCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabResponseCard[k];
			}
		});
	});
	Object.keys(tabSubmit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabSubmit[k];
			}
		});
	});
	Object.keys(tabSuggestedActions).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabSuggestedActions[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/animation-card.js
var require_animation_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/audio-card.js
var require_audio_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/basic-card.js
var require_basic_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/card-image.js
var require_card_image = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/hero-card.js
var require_hero_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/media-card.js
var require_media_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/media-url.js
var require_media_url = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/thumbnail-card.js
var require_thumbnail_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/thumbnail-url.js
var require_thumbnail_url = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/video-card.js
var require_video_card = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/card-action.js
var require_card_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/card/index.js
var require_card = /* @__PURE__ */ __commonJSMin(((exports) => {
	var animationCard = require_animation_card();
	var audioCard = require_audio_card();
	var basicCard = require_basic_card();
	var cardImage = require_card_image();
	var heroCard = require_hero_card();
	var mediaCard = require_media_card();
	var mediaUrl = require_media_url();
	var thumbnailCard = require_thumbnail_card();
	var thumbnailUrl = require_thumbnail_url();
	var videoCard = require_video_card();
	var cardAction = require_card_action();
	Object.keys(animationCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return animationCard[k];
			}
		});
	});
	Object.keys(audioCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return audioCard[k];
			}
		});
	});
	Object.keys(basicCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return basicCard[k];
			}
		});
	});
	Object.keys(cardImage).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cardImage[k];
			}
		});
	});
	Object.keys(heroCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return heroCard[k];
			}
		});
	});
	Object.keys(mediaCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return mediaCard[k];
			}
		});
	});
	Object.keys(mediaUrl).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return mediaUrl[k];
			}
		});
	});
	Object.keys(thumbnailCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return thumbnailCard[k];
			}
		});
	});
	Object.keys(thumbnailUrl).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return thumbnailUrl[k];
			}
		});
	});
	Object.keys(videoCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return videoCard[k];
			}
		});
	});
	Object.keys(cardAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cardAction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/invoke-response.js
var require_invoke_response = /* @__PURE__ */ __commonJSMin(((exports) => {
	function isInvokeResponse(value) {
		return typeof value === "object" && "status" in value && typeof value.status === "number";
	}
	exports.isInvokeResponse = isInvokeResponse;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/membership-source-types.js
var require_membership_source_types = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/membership-source.js
var require_membership_source = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/membership-types.js
var require_membership_types = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-authentication.js
var require_adaptive_card_authentication = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-invoke-action.js
var require_adaptive_card_invoke_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-invoke-value.js
var require_adaptive_card_invoke_value = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-action-response.js
var require_adaptive_card_action_response = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/adaptive-card/index.js
var require_adaptive_card$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var adaptiveCardAuthentication = require_adaptive_card_authentication();
	var adaptiveCardInvokeAction = require_adaptive_card_invoke_action();
	var adaptiveCardInvokeValue = require_adaptive_card_invoke_value();
	var adaptiveCardActionResponse = require_adaptive_card_action_response();
	Object.keys(adaptiveCardAuthentication).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCardAuthentication[k];
			}
		});
	});
	Object.keys(adaptiveCardInvokeAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCardInvokeAction[k];
			}
		});
	});
	Object.keys(adaptiveCardInvokeValue).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCardInvokeValue[k];
			}
		});
	});
	Object.keys(adaptiveCardActionResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCardActionResponse[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/channel-info.js
var require_channel_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/notification-info.js
var require_notification_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/on-behalf-of.js
var require_on_behalf_of = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/settings.js
var require_settings = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/team-info.js
var require_team_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/tenant-info.js
var require_tenant_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/feedback-loop.js
var require_feedback_loop = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-data/index.js
var require_channel_data = /* @__PURE__ */ __commonJSMin(((exports) => {
	var channelInfo = require_channel_info();
	var notificationInfo = require_notification_info();
	var onBehalfOf = require_on_behalf_of();
	var settings = require_settings();
	var teamInfo = require_team_info();
	var tenantInfo = require_tenant_info();
	var feedbackLoop = require_feedback_loop();
	Object.keys(channelInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return channelInfo[k];
			}
		});
	});
	Object.keys(notificationInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return notificationInfo[k];
			}
		});
	});
	Object.keys(onBehalfOf).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return onBehalfOf[k];
			}
		});
	});
	Object.keys(settings).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return settings[k];
			}
		});
	});
	Object.keys(teamInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return teamInfo[k];
			}
		});
	});
	Object.keys(tenantInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tenantInfo[k];
			}
		});
	});
	Object.keys(feedbackLoop).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return feedbackLoop[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/team-details.js
var require_team_details = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting.js
var require_meeting$2 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting-info.js
var require_meeting_info = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting-details.js
var require_meeting_details = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting-notification.js
var require_meeting_notification = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/meeting-participant.js
var require_meeting_participant = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/meeting/index.js
var require_meeting$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var meeting = require_meeting$2();
	var meetingInfo = require_meeting_info();
	var meetingDetails = require_meeting_details();
	var meetingNotification = require_meeting_notification();
	var meetingParticipant = require_meeting_participant();
	Object.keys(meeting).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meeting[k];
			}
		});
	});
	Object.keys(meetingInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingInfo[k];
			}
		});
	});
	Object.keys(meetingDetails).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingDetails[k];
			}
		});
	});
	Object.keys(meetingNotification).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingNotification[k];
			}
		});
	});
	Object.keys(meetingParticipant).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingParticipant[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/channel-id.js
var require_channel_id = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/activity-like.js
var require_activity_like = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/models/index.js
var require_models = /* @__PURE__ */ __commonJSMin(((exports) => {
	var token = require_token$2();
	var tokenExchange = require_token_exchange$1();
	var signIn = require_sign_in$2();
	var oauth = require_oauth();
	var role = require_role();
	var account = require_account();
	var entity = require_entity();
	var inputHint = require_input_hint();
	var textFormat = require_text_format();
	var attachment = require_attachment();
	var suggestedActions = require_suggested_actions();
	var importance = require_importance();
	var deliveryMode = require_delivery_mode();
	var error = require_error();
	var conversation = require_conversation$2();
	var resource = require_resource();
	var cacheInfo = require_cache_info();
	var config = require_config$1();
	var taskModule = require_task_module();
	var file = require_file();
	var action = require_action$1();
	var o365 = require_o365();
	var appBasedLinkQuery = require_app_based_link_query();
	var messagingExtension = require_messaging_extension();
	var message = require_message$3();
	var tab = require_tab$1();
	var card = require_card();
	var invokeResponse = require_invoke_response();
	var membershipSourceTypes = require_membership_source_types();
	var membershipSource = require_membership_source();
	var membershipTypes = require_membership_types();
	var adaptiveCard = require_adaptive_card$1();
	var channelData = require_channel_data();
	var teamDetails = require_team_details();
	var meeting = require_meeting$1();
	var channelId = require_channel_id();
	var activityLike = require_activity_like();
	Object.keys(token).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return token[k];
			}
		});
	});
	Object.keys(tokenExchange).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchange[k];
			}
		});
	});
	Object.keys(signIn).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signIn[k];
			}
		});
	});
	Object.keys(oauth).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return oauth[k];
			}
		});
	});
	Object.keys(role).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return role[k];
			}
		});
	});
	Object.keys(account).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return account[k];
			}
		});
	});
	Object.keys(entity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return entity[k];
			}
		});
	});
	Object.keys(inputHint).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return inputHint[k];
			}
		});
	});
	Object.keys(textFormat).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return textFormat[k];
			}
		});
	});
	Object.keys(attachment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return attachment[k];
			}
		});
	});
	Object.keys(suggestedActions).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return suggestedActions[k];
			}
		});
	});
	Object.keys(importance).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return importance[k];
			}
		});
	});
	Object.keys(deliveryMode).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return deliveryMode[k];
			}
		});
	});
	Object.keys(error).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return error[k];
			}
		});
	});
	Object.keys(conversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversation[k];
			}
		});
	});
	Object.keys(resource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return resource[k];
			}
		});
	});
	Object.keys(cacheInfo).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cacheInfo[k];
			}
		});
	});
	Object.keys(config).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return config[k];
			}
		});
	});
	Object.keys(taskModule).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskModule[k];
			}
		});
	});
	Object.keys(file).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return file[k];
			}
		});
	});
	Object.keys(action).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return action[k];
			}
		});
	});
	Object.keys(o365).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return o365[k];
			}
		});
	});
	Object.keys(appBasedLinkQuery).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return appBasedLinkQuery[k];
			}
		});
	});
	Object.keys(messagingExtension).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messagingExtension[k];
			}
		});
	});
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(tab).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tab[k];
			}
		});
	});
	Object.keys(card).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return card[k];
			}
		});
	});
	Object.keys(invokeResponse).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return invokeResponse[k];
			}
		});
	});
	Object.keys(membershipSourceTypes).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return membershipSourceTypes[k];
			}
		});
	});
	Object.keys(membershipSource).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return membershipSource[k];
			}
		});
	});
	Object.keys(membershipTypes).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return membershipTypes[k];
			}
		});
	});
	Object.keys(adaptiveCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCard[k];
			}
		});
	});
	Object.keys(channelData).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return channelData[k];
			}
		});
	});
	Object.keys(teamDetails).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return teamDetails[k];
			}
		});
	});
	Object.keys(meeting).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meeting[k];
			}
		});
	});
	Object.keys(channelId).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return channelId[k];
			}
		});
	});
	Object.keys(activityLike).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return activityLike[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/conversation/activity.js
var require_activity$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var http = require_http();
	var models = require_models();
	var apiClientSettings = require_api_client_settings();
	var ConversationActivityClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async create(conversationId, params) {
			return (await this.http.post(`${this.serviceUrl}/v3/conversations/${conversationId}/activities`, params)).data;
		}
		async update(conversationId, id, params) {
			return (await this.http.put(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}`, params)).data;
		}
		async reply(conversationId, id, params) {
			params.replyToId = id;
			return (await this.http.post(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}`, params)).data;
		}
		async delete(conversationId, id) {
			return (await this.http.delete(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}`)).data;
		}
		async getMembers(conversationId, id) {
			return ((await this.http.get(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}/members`)).data ?? []).map(models.resolveAadObjectId);
		}
		async createTargeted(conversationId, params) {
			return (await this.http.post(`${this.serviceUrl}/v3/conversations/${conversationId}/activities?isTargetedActivity=true`, params)).data;
		}
		async updateTargeted(conversationId, id, params) {
			return (await this.http.put(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}?isTargetedActivity=true`, params)).data;
		}
		async deleteTargeted(conversationId, id) {
			return (await this.http.delete(`${this.serviceUrl}/v3/conversations/${conversationId}/activities/${id}?isTargetedActivity=true`)).data;
		}
	};
	exports.ConversationActivityClient = ConversationActivityClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/conversation/member.js
var require_member = /* @__PURE__ */ __commonJSMin(((exports) => {
	var http = require_http();
	var models = require_models();
	var apiClientSettings = require_api_client_settings();
	var ConversationMemberClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async get(conversationId) {
			return (await this.http.get(`${this.serviceUrl}/v3/conversations/${conversationId}/members`)).data.map(models.resolveAadObjectId);
		}
		async getById(conversationId, id) {
			const res = await this.http.get(`${this.serviceUrl}/v3/conversations/${conversationId}/members/${id}`);
			return models.resolveAadObjectId(res.data);
		}
		/**
		* Get paged members in a conversation.
		* @param conversationId - The ID of the conversation.
		* @param pageSize - Optional maximum number of members per page (min 50, default 200, max 500).
		* @param continuationToken - Optional token from a previous call to fetch the next page.
		* @returns PagedMembersResult containing members and an optional continuation token.
		*/
		async getPaged(conversationId, pageSize, continuationToken) {
			const params = {};
			if (pageSize !== void 0) params["pageSize"] = pageSize;
			if (continuationToken !== void 0) params["continuationToken"] = continuationToken;
			const res = await this.http.get(`${this.serviceUrl}/v3/conversations/${conversationId}/pagedMembers`, { params });
			return {
				...res.data,
				members: res.data.members.map(models.resolveAadObjectId)
			};
		}
		/**
		* @deprecated The DELETE member endpoint is not supported by the backend. This method will be removed in a future version.
		*/
		async delete(conversationId, id) {
			return (await this.http.delete(`${this.serviceUrl}/v3/conversations/${conversationId}/members/${id}`)).data;
		}
	};
	exports.ConversationMemberClient = ConversationMemberClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/conversation/index.js
var require_conversation$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var qs = require_lib();
	var http = require_http();
	var apiClientSettings = require_api_client_settings();
	var activity = require_activity$1();
	var member = require_member();
	function _interopDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	var qs__default = /* @__PURE__ */ _interopDefault(qs);
	var ConversationClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_activities;
		_members;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
			this._activities = new activity.ConversationActivityClient(serviceUrl, this.http, this._apiClientSettings);
			this._members = new member.ConversationMemberClient(serviceUrl, this.http, this._apiClientSettings);
		}
		activities(conversationId) {
			return {
				create: (params) => this._activities.create(conversationId, params),
				update: (id, params) => this._activities.update(conversationId, id, params),
				reply: (id, params) => this._activities.reply(conversationId, id, params),
				delete: (id) => this._activities.delete(conversationId, id),
				members: (activityId) => this._activities.getMembers(conversationId, activityId),
				createTargeted: (params) => this._activities.createTargeted(conversationId, params),
				updateTargeted: (id, params) => this._activities.updateTargeted(conversationId, id, params),
				deleteTargeted: (id) => this._activities.deleteTargeted(conversationId, id)
			};
		}
		members(conversationId) {
			return {
				get: () => this._members.get(conversationId),
				getById: (id) => this._members.getById(conversationId, id),
				getPaged: (pageSize, continuationToken) => this._members.getPaged(conversationId, pageSize, continuationToken),
				/**
				* @deprecated The DELETE member endpoint is not supported by the backend. This method will be removed in a future version.
				*/
				delete: (id) => this._members.delete(conversationId, id)
			};
		}
		/**
		* @deprecated The GET /v3/conversations endpoint is not supported. This method will be removed in a future version.
		*/
		async get(params) {
			const q = qs__default.default.stringify(params, { addQueryPrefix: true });
			return (await this.http.get(`${this.serviceUrl}/v3/conversations${q}`)).data;
		}
		async create(params) {
			return (await this.http.post(`${this.serviceUrl}/v3/conversations`, params)).data;
		}
	};
	exports.ConversationClient = ConversationClient;
	Object.keys(activity).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return activity[k];
			}
		});
	});
	Object.keys(member).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return member[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/meeting.js
var require_meeting = /* @__PURE__ */ __commonJSMin(((exports) => {
	var http = require_http();
	var apiClientSettings = require_api_client_settings();
	var MeetingClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		/**
		* Retrieves meeting information including details, organizer, and conversation.
		* @param id - The meeting ID.
		*/
		async getById(id) {
			return (await this.http.get(`${this.serviceUrl}/v1/meetings/${encodeURIComponent(id)}`)).data;
		}
		/**
		* Retrieves information about a specific participant in a meeting.
		* @param meetingId - The meeting ID.
		* @param id - The user AAD object ID
		* @param tenantId - The tenant ID of the meeting and user.
		* @returns {MeetingParticipant} The meeting participant information.
		*/
		async getParticipant(meetingId, id, tenantId) {
			return (await this.http.get(`${this.serviceUrl}/v1/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(id)}?tenantId=${encodeURIComponent(tenantId)}`)).data;
		}
		/**
		* Send a targeted in-meeting notification to specific participants.
		*
		* Returns `undefined` on full success (HTTP 202). Returns a `MeetingNotificationResponse`
		* with per-recipient failure info on partial success (HTTP 207).
		*
		* Requires the RSC permission `OnlineMeetingNotification.Send.Chat` and the ECS flag
		* enabled for the tenant/bot.
		*
		* @param meetingId - The BASE64-encoded meeting ID.
		* @param params - The notification parameters including recipients and surfaces.
		*/
		async sendNotification(meetingId, params) {
			const body = {
				type: params.type ?? "targetedMeetingNotification",
				value: params.value
			};
			return (await this.http.post(`${this.serviceUrl}/v1/meetings/${encodeURIComponent(meetingId)}/notification`, body)).data || void 0;
		}
	};
	exports.MeetingClient = MeetingClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/reaction/reaction.js
var require_reaction$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var http = require_http();
	var apiClientSettings = require_api_client_settings();
	var ReactionClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		/**
		* Add a reaction to a message.
		*
		* @experimental This API is in preview and may change in the future.
		* Diagnostic: ExperimentalTeamsReactions
		*/
		async add(conversationId, activityId, reactionType) {
			return (await this.http.put(`${this.serviceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/reactions/${encodeURIComponent(reactionType)}`)).data;
		}
		/**
		* Remove a reaction from a message.
		*
		* @experimental This API is in preview and may change in the future.
		* Diagnostic: ExperimentalTeamsReactions
		*/
		async remove(conversationId, activityId, reactionType) {
			return (await this.http.delete(`${this.serviceUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}/reactions/${encodeURIComponent(reactionType)}`)).data;
		}
	};
	exports.ReactionClient = ReactionClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/reaction/index.js
var require_reaction = /* @__PURE__ */ __commonJSMin(((exports) => {
	var reaction = require_reaction$1();
	Object.keys(reaction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return reaction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/team.js
var require_team = /* @__PURE__ */ __commonJSMin(((exports) => {
	var http = require_http();
	var apiClientSettings = require_api_client_settings();
	var TeamClient = class {
		serviceUrl;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async getById(id) {
			return (await this.http.get(`${this.serviceUrl}/v3/teams/${id}`)).data;
		}
		async getConversations(id) {
			return (await this.http.get(`${this.serviceUrl}/v3/teams/${id}/conversations`)).data.conversations;
		}
	};
	exports.TeamClient = TeamClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/user/token.js
var require_token$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var qs = require_lib();
	var http = require_http();
	var apiClientSettings = require_api_client_settings();
	function _interopDefault(e) {
		return e && e.__esModule ? e : { default: e };
	}
	var qs__default = /* @__PURE__ */ _interopDefault(qs);
	const USER_TOKEN_ENDPOINTS = {
		GET_TOKEN: "api/usertoken/GetToken",
		GET_AAD_TOKENS: "api/usertoken/GetAadTokens",
		GET_STATUS: "api/usertoken/GetTokenStatus",
		SIGN_OUT: "api/usertoken/SignOut",
		EXCHANGE: "api/usertoken/exchange"
	};
	var UserTokenClient = class {
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(options, apiClientSettings$1) {
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
		}
		async get(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.get(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.GET_TOKEN}?${q}`)).data;
		}
		async getAad(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.post(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.GET_AAD_TOKENS}?${q}`, params)).data;
		}
		async getStatus(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.get(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.GET_STATUS}?${q}`)).data;
		}
		async signOut(params) {
			const q = qs__default.default.stringify(params);
			return (await this.http.delete(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.SIGN_OUT}?${q}`, { data: params })).data;
		}
		async exchange(params) {
			const q = qs__default.default.stringify({
				userId: params.userId,
				connectionName: params.connectionName,
				channelId: params.channelId
			});
			return (await this.http.post(`${this._apiClientSettings.oauthUrl}/${USER_TOKEN_ENDPOINTS.EXCHANGE}?${q}`, params.exchangeRequest)).data;
		}
	};
	exports.USER_TOKEN_ENDPOINTS = USER_TOKEN_ENDPOINTS;
	exports.UserTokenClient = UserTokenClient;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/user/index.js
var require_user = /* @__PURE__ */ __commonJSMin(((exports) => {
	var http = require_http();
	var apiClientSettings = require_api_client_settings();
	var token = require_token$1();
	var UserClient = class {
		token;
		get http() {
			return this._http;
		}
		set http(v) {
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(options, apiClientSettings$1) {
			if (!options) this._http = new http.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http.Client(options);
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1);
			this.token = new token.UserTokenClient(this.http, this._apiClientSettings);
		}
	};
	exports.UserClient = UserClient;
	Object.keys(token).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return token[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/clients/index.js
var require_clients = /* @__PURE__ */ __commonJSMin(((exports) => {
	var http = require_http();
	var apiClientSettings = require_api_client_settings();
	var bot = require_bot();
	var conversation = require_conversation$1();
	var meeting = require_meeting();
	var reaction = require_reaction();
	var team = require_team();
	var user = require_user();
	function _interopNamespace(e) {
		if (e && e.__esModule) return e;
		var n = Object.create(null);
		if (e) Object.keys(e).forEach(function(k) {
			if (k !== "default") {
				var d = Object.getOwnPropertyDescriptor(e, k);
				Object.defineProperty(n, k, d.get ? d : {
					enumerable: true,
					get: function() {
						return e[k];
					}
				});
			}
		});
		n.default = e;
		return Object.freeze(n);
	}
	var http__namespace = /* @__PURE__ */ _interopNamespace(http);
	var Client = class {
		serviceUrl;
		bots;
		users;
		conversations;
		teams;
		meetings;
		/**
		* @experimental This API is in preview and may change in the future.
		* Diagnostic: ExperimentalTeamsReactions
		*/
		reactions;
		get http() {
			return this._http;
		}
		set http(v) {
			this.bots.http = v;
			this.conversations.http = v;
			this.users.http = v;
			this.teams.http = v;
			this.meetings.http = v;
			this.reactions.http = v;
			this._http = v;
		}
		_http;
		_apiClientSettings;
		constructor(serviceUrl, options, apiClientSettings$1, cloud) {
			this.serviceUrl = serviceUrl;
			if (!options) this._http = new http__namespace.Client();
			else if ("request" in options) this._http = options;
			else this._http = new http__namespace.Client({
				...options,
				headers: {
					...options?.headers,
					"Content-Type": "application/json"
				}
			});
			this._apiClientSettings = apiClientSettings.mergeApiClientSettings(apiClientSettings$1, cloud);
			this.bots = new bot.BotClient(this.http, this._apiClientSettings);
			this.users = new user.UserClient(this.http, this._apiClientSettings);
			this.conversations = new conversation.ConversationClient(serviceUrl, this.http, this._apiClientSettings);
			this.teams = new team.TeamClient(serviceUrl, this.http, this._apiClientSettings);
			this.meetings = new meeting.MeetingClient(serviceUrl, this.http, this._apiClientSettings);
			this.reactions = new reaction.ReactionClient(serviceUrl, this.http, this._apiClientSettings);
		}
	};
	exports.Client = Client;
	Object.keys(apiClientSettings).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return apiClientSettings[k];
			}
		});
	});
	Object.keys(bot).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return bot[k];
			}
		});
	});
	Object.keys(conversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversation[k];
			}
		});
	});
	Object.keys(meeting).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meeting[k];
			}
		});
	});
	Object.keys(reaction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return reaction[k];
			}
		});
	});
	Object.keys(team).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return team[k];
			}
		});
	});
	Object.keys(user).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return user[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/activity.js
var require_activity = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.Activity = class Activity {
		/**
		* Contains the type of the activity.
		*/
		type;
		/**
		* Contains an ID that uniquely identifies the activity on the channel.
		*/
		id;
		/**
		* Contains the URL that specifies the channel's service endpoint. Set by the channel.
		*/
		serviceUrl;
		/**
		* Contains the date and time that the message was sent, in UTC, expressed in ISO-8601 format.
		*/
		timestamp;
		/**
		* A locale name for the contents of the text field.
		* The locale name is a combination of an ISO 639 two- or three-letter culture code associated
		* with a language
		* and an ISO 3166 two-letter subculture code associated with a country or region.
		* The locale name can also correspond to a valid BCP-47 language tag.
		*/
		locale;
		/**
		* Contains the local date and time of the message, expressed in ISO-8601 format.
		*
		* For example, 2016-09-23T13:07:49.4714686-07:00.
		*/
		localTimestamp;
		/**
		* Contains an ID that uniquely identifies the channel. Set by the channel.
		*/
		channelId;
		/**
		* Identifies the sender of the message.
		*/
		from;
		/**
		* Identifies the conversation to which the activity belongs.
		*/
		conversation;
		/**
		* A reference to another conversation or activity.
		*/
		relatesTo;
		/**
		* Identifies the recipient of the message.
		*/
		recipient;
		/**
		* Contains the ID of the message to which this message is a reply.
		*/
		replyToId;
		/**
		* Represents the entities that were mentioned in the message.
		*/
		entities;
		/**
		* Contains channel-specific content.
		*/
		channelData;
		/**
		* Information about the tenant in which the message was sent.
		*/
		get tenant() {
			return this.channelData?.tenant;
		}
		/**
		* Information about the channel in which the message was sent.
		*/
		get channel() {
			return this.channelData?.channel;
		}
		/**
		* Information about the team in which the message was sent.
		*/
		get team() {
			return this.channelData?.team;
		}
		/**
		* Information about the tenant in which the message was sent.
		*/
		get meeting() {
			return this.channelData?.meeting;
		}
		/**
		* Notification settings for the message.
		*/
		get notification() {
			return this.channelData?.notification;
		}
		constructor(value) {
			Object.assign(this, {
				channelId: "msteams",
				...value
			});
		}
		static from(activity) {
			return new Activity(activity);
		}
		toInterface() {
			return Object.assign({}, this);
		}
		clone(options = {}) {
			return new Activity({
				...this.toInterface(),
				...options
			});
		}
		withId(value) {
			this.id = value;
			return this;
		}
		withReplyToId(value) {
			this.replyToId = value;
			return this;
		}
		withChannelId(value) {
			this.channelId = value;
			return this;
		}
		withFrom(value) {
			this.from = value;
			return this;
		}
		withConversation(value) {
			this.conversation = value;
			return this;
		}
		withRelatesTo(value) {
			this.relatesTo = value;
			return this;
		}
		/**
		* Set the recipient of this activity, optionally marking it as a targeted message.
		* Targeted messages are ephemeral to the specified recipient in a shared conversation.
		* @param value - The recipient account
		* @param isTargeted - If true, marks this as a targeted message visible only to the recipient (default: false)
		* @returns this instance for chaining
		*
		* @experimental This API is in preview and may change in the future.
		* Diagnostic: ExperimentalTeamsTargeted
		*/
		withRecipient(value, isTargeted = false) {
			this.recipient = {
				...value,
				isTargeted: isTargeted ? true : void 0
			};
			return this;
		}
		withServiceUrl(value) {
			this.serviceUrl = value;
			return this;
		}
		withTimestamp(value) {
			this.timestamp = value;
			return this;
		}
		withLocale(value) {
			this.locale = value;
			return this;
		}
		withLocalTimestamp(value) {
			this.localTimestamp = value;
			return this;
		}
		withChannelData(value) {
			const merged = {
				...this.channelData,
				...value
			};
			if (merged.feedbackLoop !== void 0) merged.feedbackLoopEnabled = void 0;
			else if (merged.feedbackLoopEnabled === true) {
				merged.feedbackLoop = { type: "default" };
				merged.feedbackLoopEnabled = void 0;
			}
			this.channelData = merged;
			return this;
		}
		/**
		* Add an entity.
		*/
		addEntity(value) {
			if (!this.entities) this.entities = [];
			this.entities.push(value);
			return this;
		}
		/**
		* Add multiple entities
		*/
		addEntities(...value) {
			if (!this.entities) this.entities = [];
			this.entities.push(...value);
			return this;
		}
		/**
		* Add the `Generated By AI` label.
		*/
		addAiGenerated() {
			const messageEntity = this.ensureSingleRootLevelMessageEntity();
			if (messageEntity.additionalType?.includes("AIGeneratedContent")) return this;
			if (!messageEntity.additionalType) messageEntity.additionalType = [];
			messageEntity.additionalType.push("AIGeneratedContent");
			return this;
		}
		/**
		* Enable message feedback.
		* @param mode - `'default'` shows Teams' built-in thumbs up/down UI.
		*               `'custom'` triggers a `message/fetchTask` invoke so the bot can return its own task module dialog.
		*/
		addFeedback(mode = "default") {
			if (!this.channelData) this.channelData = {};
			this.channelData.feedbackLoop = { type: mode };
			this.channelData.feedbackLoopEnabled = void 0;
			return this;
		}
		/**
		* Add citations
		*/
		addCitation(position, appearance) {
			const messageEntity = this.ensureSingleRootLevelMessageEntity();
			if (!messageEntity.citation) messageEntity.citation = [];
			messageEntity.citation.push({
				"@type": "Claim",
				position,
				appearance: {
					"@type": "DigitalDocument",
					abstract: appearance.abstract,
					name: appearance.name,
					encodingFormat: "application/vnd.microsoft.card.adaptive",
					image: appearance.icon ? {
						"@type": "ImageObject",
						name: appearance.icon
					} : void 0,
					keywords: appearance.keywords,
					text: appearance.text,
					url: appearance.url,
					usageInfo: appearance.usageInfo
				}
			});
			return this;
		}
		/**
		* is this a streaming activity
		*/
		isStreaming() {
			return this.entities?.some((e) => e.type === "streaminfo") || false;
		}
		/**
		* Get or create the base message entity.
		* There should only be one root level message entity.
		*/
		ensureSingleRootLevelMessageEntity() {
			let mesageEntity = this.entities?.find((e) => e.type === "https://schema.org/Message" && e["@type"] === "Message");
			if (!mesageEntity) {
				mesageEntity = {
					type: "https://schema.org/Message",
					"@type": "Message",
					"@context": "https://schema.org",
					"@id": ""
				};
				this.addEntity(mesageEntity);
			}
			return mesageEntity;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/message-delete.js
var require_message_delete = /* @__PURE__ */ __commonJSMin(((exports) => {
	var activity = require_activity();
	exports.MessageDeleteActivity = class MessageDeleteActivity extends activity.Activity {
		constructor(value = {}) {
			super({
				...value,
				type: "messageDelete",
				channelData: {
					...value.channelData,
					eventType: "softDeleteMessage"
				}
			});
			Object.assign(this, {
				...value,
				channelData: {
					...value.channelData,
					eventType: "softDeleteMessage"
				}
			});
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new MessageDeleteActivity(activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new MessageDeleteActivity({
				...this.toInterface(),
				...options
			});
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/utils/strip-mentions-text.js
var require_strip_mentions_text = /* @__PURE__ */ __commonJSMin(((exports) => {
	function stripMentionsText(activity, { accountId, tagOnly } = {}) {
		if (!activity.text) return;
		let text = activity.text;
		for (const mention of activity.entities?.filter((e) => e.type === "mention") || []) {
			if (accountId && mention.mentioned.id !== accountId) continue;
			if (mention.text) {
				const textWithoutTags = mention.text.replace("<at>", "").replace("</at>", "");
				text = text.replace(mention.text, !tagOnly ? "" : textWithoutTags);
			} else text = text.replace(`<at>${mention.mentioned.name}</at>`, !tagOnly ? "" : mention.mentioned.name);
		}
		return text.trim();
	}
	exports.stripMentionsText = stripMentionsText;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/core.js
var require_core = /* @__PURE__ */ __commonJSMin(((exports) => {
	function isAdaptiveCard(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "AdaptiveCard";
	}
	var AdaptiveCard = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **AdaptiveCard**.
		*/
		type = "AdaptiveCard";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* A URL to the Adaptive Card schema the card is authored against.
		*/
		$schema;
		/**
		* The Adaptive Card schema version the card is authored against.
		*/
		version = "1.5";
		/**
		* The text that should be displayed if the client is not able to render the card.
		*/
		fallbackText;
		/**
		* The text that should be spoken for the entire card.
		*/
		speak;
		/**
		* Defines how the card can be refreshed by making a request to the target Bot.
		*/
		refresh;
		/**
		* Defines authentication information to enable on-behalf-of single-sign-on or just-in-time OAuth. This information is used in conjunction with the refresh property and Action.Execute in general.
		*/
		authentication;
		/**
		* Teams-specific metadata associated with the card.
		*/
		msteams;
		/**
		* Metadata associated with the card.
		*/
		metadata;
		/**
		* Resources card elements can reference.
		*/
		resources;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The body of the card, comprised of a list of elements displayed according to the layouts property. If the layouts property is not specified, a Layout.Stack is used.
		*/
		body;
		/**
		* The card level actions, which always appear at the bottom of the card.
		*/
		actions;
		constructor(...body) {
			this.body = body;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		with$schema($schema) {
			this.$schema = $schema;
			return this;
		}
		withVersion(version) {
			this.version = version;
			return this;
		}
		withFallbackText(fallbackText) {
			this.fallbackText = fallbackText;
			return this;
		}
		withSpeak(speak) {
			this.speak = speak;
			return this;
		}
		withRefresh(refresh) {
			this.refresh = refresh;
			return this;
		}
		withAuthentication(authentication) {
			this.authentication = authentication;
			return this;
		}
		withMsteams(msteams) {
			this.msteams = msteams;
			return this;
		}
		withMetadata(metadata) {
			this.metadata = metadata;
			return this;
		}
		withResources(resources) {
			this.resources = resources;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withBody(...body) {
			this.body = body;
			return this;
		}
		withActions(...actions) {
			this.actions = actions;
			return this;
		}
	};
	var HostCapabilities = class HostCapabilities {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new HostCapabilities(options);
		}
	};
	function isExecuteAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.Execute";
	}
	var ExecuteAction = class ExecuteAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.Execute**.
		*/
		type = "Action.Execute";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The data to send to the Bot when the action is executed. When expressed as an object, `data` is sent back to the Bot when the action is executed, adorned with the values of the inputs expressed as key/value pairs, where the key is the Id of the input. If `data` is expressed as a string, input values are not sent to the Bot.
		*/
		data;
		/**
		* The Ids of the inputs associated with the Action.Submit. When the action is executed, the values of the associated inputs are sent to the Bot. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		associatedInputs;
		/**
		* Controls if the action is enabled only if at least one required input has been filled by the user.
		*/
		conditionallyEnabled = false;
		/**
		* The verb of the action.
		*/
		verb;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ExecuteAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withData(data) {
			this.data = data;
			return this;
		}
		withAssociatedInputs(associatedInputs) {
			this.associatedInputs = associatedInputs;
			return this;
		}
		withConditionallyEnabled(conditionallyEnabled = true) {
			this.conditionallyEnabled = conditionallyEnabled;
			return this;
		}
		withVerb(verb) {
			this.verb = verb;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isInsertImageAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.InsertImage";
	}
	var InsertImageAction = class InsertImageAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.InsertImage**.
		*/
		type = "Action.InsertImage";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The URL of the image to insert.
		*/
		url;
		/**
		* The alternate text for the image.
		*/
		altText;
		/**
		* The position at which to insert the image.
		*/
		insertPosition = "Selection";
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new InsertImageAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withAltText(altText) {
			this.altText = altText;
			return this;
		}
		withInsertPosition(insertPosition) {
			this.insertPosition = insertPosition;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isOpenUrlAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.OpenUrl";
	}
	var OpenUrlAction = class OpenUrlAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.OpenUrl**.
		*/
		type = "Action.OpenUrl";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The URL to open.
		*/
		url;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(url, options = {}) {
			Object.assign(this, options);
			this.url = url;
		}
		static from(options) {
			return new OpenUrlAction(options.url, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isOpenUrlDialogAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.OpenUrlDialog";
	}
	var OpenUrlDialogAction = class OpenUrlDialogAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.OpenUrlDialog**.
		*/
		type = "Action.OpenUrlDialog";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The title of the dialog to be displayed in the dialog header.
		*/
		dialogTitle;
		/**
		* The height of the dialog. To define height as a number of pixels, use the <number>px format.
		*/
		dialogHeight;
		/**
		* The width of the dialog. To define width as a number of pixels, use the <number>px format.
		*/
		dialogWidth;
		/**
		* The URL to open.
		*/
		url;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new OpenUrlDialogAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withDialogTitle(dialogTitle) {
			this.dialogTitle = dialogTitle;
			return this;
		}
		withDialogHeight(dialogHeight) {
			this.dialogHeight = dialogHeight;
			return this;
		}
		withDialogWidth(dialogWidth) {
			this.dialogWidth = dialogWidth;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isResetInputsAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.ResetInputs";
	}
	var ResetInputsAction = class ResetInputsAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.ResetInputs**.
		*/
		type = "Action.ResetInputs";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The Ids of the inputs that should be reset.
		*/
		targetInputIds;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ResetInputsAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withTargetInputIds(...targetInputIds) {
			this.targetInputIds = targetInputIds;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isSubmitAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.Submit";
	}
	var SubmitAction = class SubmitAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.Submit**.
		*/
		type = "Action.Submit";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The data to send to the Bot when the action is executed. When expressed as an object, `data` is sent back to the Bot when the action is executed, adorned with the values of the inputs expressed as key/value pairs, where the key is the Id of the input. If `data` is expressed as a string, input values are not sent to the Bot.
		*/
		data;
		/**
		* The Ids of the inputs associated with the Action.Submit. When the action is executed, the values of the associated inputs are sent to the Bot. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		associatedInputs;
		/**
		* Controls if the action is enabled only if at least one required input has been filled by the user.
		*/
		conditionallyEnabled = false;
		/**
		* Teams-specific metadata associated with the action.
		*/
		msteams;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new SubmitAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withData(data) {
			this.data = data;
			return this;
		}
		withAssociatedInputs(associatedInputs) {
			this.associatedInputs = associatedInputs;
			return this;
		}
		withConditionallyEnabled(conditionallyEnabled = true) {
			this.conditionallyEnabled = conditionallyEnabled;
			return this;
		}
		withMsteams(msteams) {
			this.msteams = msteams;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isToggleVisibilityAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.ToggleVisibility";
	}
	var ToggleVisibilityAction = class ToggleVisibilityAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.ToggleVisibility**.
		*/
		type = "Action.ToggleVisibility";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The Ids of the elements to toggle the visibility of.
		*/
		targetElements;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ToggleVisibilityAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withTargetElements(...targetElements) {
			this.targetElements = targetElements;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var ThemedUrl = class ThemedUrl {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The theme this URL applies to.
		*/
		theme = "Light";
		/**
		* The URL to use for the associated theme.
		*/
		url;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ThemedUrl(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTheme(theme) {
			this.theme = theme;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
	};
	var TargetElement = class TargetElement {
		/**
		* The Id of the element to change the visibility of.
		*/
		elementId;
		/**
		* The new visibility state of the element.
		*/
		isVisible;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TargetElement(options);
		}
		withElementId(elementId) {
			this.elementId = elementId;
			return this;
		}
		withIsVisible(isVisible) {
			this.isVisible = isVisible;
			return this;
		}
	};
	function isShowCardAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.ShowCard";
	}
	var ShowCardAction = class ShowCardAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.ShowCard**.
		*/
		type = "Action.ShowCard";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* The actions to display in the overflow menu of a Split action button.
		*/
		menuActions;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The card that should be displayed when the action is executed.
		*/
		card;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ShowCardAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withMenuActions(...menuActions) {
			this.menuActions = menuActions;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withCard(card) {
			this.card = card;
			return this;
		}
	};
	function isPopoverAction(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Action.Popover";
	}
	var PopoverAction = class PopoverAction {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Action.Popover**.
		*/
		type = "Action.Popover";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The title of the action, as it appears on buttons.
		*/
		title;
		/**
		* A URL (or Base64-encoded Data URI) to a PNG, GIF, JPEG or SVG image to be displayed on the left of the action's title.
		*
		* `iconUrl` also accepts the `<icon-name>[,regular|filled]` format to display an icon from the vast [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) instead of an image.
		*/
		iconUrl;
		/**
		* Control the style of the action, affecting its visual and spoken representations.
		*/
		style = "default";
		/**
		* Controls if the action is primary or secondary. Secondary actions appear in an overflow menu.
		*/
		mode = "primary";
		/**
		* The tooltip text to display when the action is hovered over.
		*/
		tooltip;
		/**
		* Controls the enabled state of the action. A disabled action cannot be clicked. If the action is represented as a button, the button's style will reflect this state.
		*/
		isEnabled = true;
		/**
		* A set of theme-specific icon URLs.
		*/
		themedIconUrls;
		/**
		* The content of the popover, which can be any element.
		*/
		content;
		/**
		* Controls if an arrow should be displayed towards the element that triggered the popover.
		*/
		displayArrow = true;
		/**
		* Controls where the popover should be displayed with regards to the element that triggered it.
		*/
		position = "Above";
		/**
		* The maximum width of the popover in pixels, in the `<number>px` format
		*/
		maxPopoverWidth;
		/**
		* An alternate action to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new PopoverAction(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withIconUrl(iconUrl) {
			this.iconUrl = iconUrl;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withMode(mode) {
			this.mode = mode;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withIsEnabled(isEnabled = false) {
			this.isEnabled = isEnabled;
			return this;
		}
		withThemedIconUrls(...themedIconUrls) {
			this.themedIconUrls = themedIconUrls;
			return this;
		}
		withContent(content) {
			this.content = content;
			return this;
		}
		withDisplayArrow(displayArrow = false) {
			this.displayArrow = displayArrow;
			return this;
		}
		withPosition(position) {
			this.position = position;
			return this;
		}
		withMaxPopoverWidth(maxPopoverWidth) {
			this.maxPopoverWidth = maxPopoverWidth;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isActionSet(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ActionSet";
	}
	var ActionSet = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ActionSet**.
		*/
		type = "ActionSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The actions in the set.
		*/
		actions;
		constructor(...actions) {
			this.actions = actions;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withActions(...actions) {
			this.actions = actions;
			return this;
		}
	};
	function isContainer(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Container";
	}
	var Container = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Container**.
		*/
		type = "Container";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* The maximum height, in pixels, of the container, in the `<number>px` format. When the content of a container exceeds the container's maximum height, a vertical scrollbar is displayed.
		*/
		maxHeight;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The elements in the container.
		*/
		items;
		constructor(...items) {
			this.items = items;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		withMaxHeight(maxHeight) {
			this.maxHeight = maxHeight;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withItems(...items) {
			this.items = items;
			return this;
		}
	};
	function isStackLayout(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Layout.Stack";
	}
	var StackLayout = class StackLayout {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Layout.Stack**.
		*/
		type = "Layout.Stack";
		/**
		* Controls for which card width the layout should be used.
		*/
		targetWidth;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StackLayout(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
	};
	function isFlowLayout(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Layout.Flow";
	}
	var FlowLayout = class FlowLayout {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Layout.Flow**.
		*/
		type = "Layout.Flow";
		/**
		* Controls for which card width the layout should be used.
		*/
		targetWidth;
		/**
		* Controls how the content of the container should be horizontally aligned.
		*/
		horizontalItemsAlignment = "Center";
		/**
		* Controls how the content of the container should be vertically aligned.
		*/
		verticalItemsAlignment = "Top";
		/**
		* Controls how item should fit inside the container.
		*/
		itemFit = "Fit";
		/**
		* The minimum width, in pixels, of each item, in the `<number>px` format. Should not be used if itemWidth is set.
		*/
		minItemWidth;
		/**
		* The maximum width, in pixels, of each item, in the `<number>px` format. Should not be used if itemWidth is set.
		*/
		maxItemWidth;
		/**
		* The width, in pixels, of each item, in the `<number>px` format. Should not be used if maxItemWidth and/or minItemWidth are set.
		*/
		itemWidth;
		/**
		* The space between items.
		*/
		columnSpacing = "Default";
		/**
		* The space between rows of items.
		*/
		rowSpacing = "Default";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new FlowLayout(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withHorizontalItemsAlignment(horizontalItemsAlignment) {
			this.horizontalItemsAlignment = horizontalItemsAlignment;
			return this;
		}
		withVerticalItemsAlignment(verticalItemsAlignment) {
			this.verticalItemsAlignment = verticalItemsAlignment;
			return this;
		}
		withItemFit(itemFit) {
			this.itemFit = itemFit;
			return this;
		}
		withMinItemWidth(minItemWidth) {
			this.minItemWidth = minItemWidth;
			return this;
		}
		withMaxItemWidth(maxItemWidth) {
			this.maxItemWidth = maxItemWidth;
			return this;
		}
		withItemWidth(itemWidth) {
			this.itemWidth = itemWidth;
			return this;
		}
		withColumnSpacing(columnSpacing) {
			this.columnSpacing = columnSpacing;
			return this;
		}
		withRowSpacing(rowSpacing) {
			this.rowSpacing = rowSpacing;
			return this;
		}
	};
	function isAreaGridLayout(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Layout.AreaGrid";
	}
	var AreaGridLayout = class AreaGridLayout {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Layout.AreaGrid**.
		*/
		type = "Layout.AreaGrid";
		/**
		* Controls for which card width the layout should be used.
		*/
		targetWidth;
		/**
		* The columns in the grid layout, defined as a percentage of the available width or in pixels using the `<number>px` format.
		*/
		columns;
		/**
		* The areas in the grid layout.
		*/
		areas;
		/**
		* The space between columns.
		*/
		columnSpacing = "Default";
		/**
		* The space between rows.
		*/
		rowSpacing = "Default";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new AreaGridLayout(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withColumns(...columns) {
			this.columns = columns;
			return this;
		}
		withAreas(...areas) {
			this.areas = areas;
			return this;
		}
		withColumnSpacing(columnSpacing) {
			this.columnSpacing = columnSpacing;
			return this;
		}
		withRowSpacing(rowSpacing) {
			this.rowSpacing = rowSpacing;
			return this;
		}
	};
	var GridArea = class GridArea {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The name of the area. To place an element in this area, set its `grid.area` property to match the name of the area.
		*/
		name;
		/**
		* The start column index of the area. Column indices start at 1.
		*/
		column = 1;
		/**
		* Defines how many columns the area should span.
		*/
		columnSpan = 1;
		/**
		* The start row index of the area. Row indices start at 1.
		*/
		row = 1;
		/**
		* Defines how many rows the area should span.
		*/
		rowSpan = 1;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GridArea(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withColumn(column) {
			this.column = column;
			return this;
		}
		withColumnSpan(columnSpan) {
			this.columnSpan = columnSpan;
			return this;
		}
		withRow(row) {
			this.row = row;
			return this;
		}
		withRowSpan(rowSpan) {
			this.rowSpan = rowSpan;
			return this;
		}
	};
	var BackgroundImage = class BackgroundImage {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The URL (or Base64-encoded Data URI) of the image. Acceptable formats are PNG, JPEG, GIF and SVG.
		*/
		url;
		/**
		* Controls how the image should fill the area.
		*/
		fillMode = "Cover";
		/**
		* Controls how the image should be aligned if it must be cropped or if using repeat fill mode.
		*/
		horizontalAlignment = "Left";
		/**
		* Controls how the image should be aligned if it must be cropped or if using repeat fill mode.
		*/
		verticalAlignment = "Top";
		/**
		* A set of theme-specific image URLs.
		*/
		themedUrls;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new BackgroundImage(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withFillMode(fillMode) {
			this.fillMode = fillMode;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withVerticalAlignment(verticalAlignment) {
			this.verticalAlignment = verticalAlignment;
			return this;
		}
		withThemedUrls(...themedUrls) {
			this.themedUrls = themedUrls;
			return this;
		}
	};
	function isColumnSet(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ColumnSet";
	}
	var ColumnSet = class ColumnSet {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ColumnSet**.
		*/
		type = "ColumnSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* The minimum width of the column set. `auto` will automatically adjust the column set's minimum width according to its content and using the `<number>px` format will give the column set an explicit minimum width in pixels. A scrollbar will be displayed if the available width is less than the specified minimum width.
		*/
		minWidth;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The columns in the set.
		*/
		columns;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ColumnSet(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withMinWidth(minWidth) {
			this.minWidth = minWidth;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withColumns(...columns) {
			this.columns = columns;
			return this;
		}
	};
	function isMedia(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Media";
	}
	var Media = class Media {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Media**.
		*/
		type = "Media";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The sources for the media. For YouTube, Dailymotion and Vimeo, only one source can be specified.
		*/
		sources;
		/**
		* The caption sources for the media. Caption sources are not used for YouTube, Dailymotion or Vimeo sources.
		*/
		captionSources;
		/**
		* The URL of the poster image to display.
		*/
		poster;
		/**
		* The alternate text for the media, used for accessibility purposes.
		*/
		altText;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Media(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSources(...sources) {
			this.sources = sources;
			return this;
		}
		withCaptionSources(...captionSources) {
			this.captionSources = captionSources;
			return this;
		}
		withPoster(poster) {
			this.poster = poster;
			return this;
		}
		withAltText(altText) {
			this.altText = altText;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var MediaSource = class MediaSource {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The MIME type of the source.
		*/
		mimeType;
		/**
		* The URL of the source.
		*/
		url;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new MediaSource(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withMimeType(mimeType) {
			this.mimeType = mimeType;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
	};
	var CaptionSource = class CaptionSource {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The MIME type of the source.
		*/
		mimeType;
		/**
		* The URL of the source.
		*/
		url;
		/**
		* The label of this caption source.
		*/
		label;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CaptionSource(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withMimeType(mimeType) {
			this.mimeType = mimeType;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
	};
	function isRichTextBlock(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "RichTextBlock";
	}
	var RichTextBlock = class RichTextBlock {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **RichTextBlock**.
		*/
		type = "RichTextBlock";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The Id of the input the RichTextBlock should act as the label of.
		*/
		labelFor;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The inlines making up the rich text block.
		*/
		inlines;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new RichTextBlock(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabelFor(labelFor) {
			this.labelFor = labelFor;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withInlines(...inlines) {
			this.inlines = inlines;
			return this;
		}
	};
	function isTable(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Table";
	}
	var Table = class Table {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Table**.
		*/
		type = "Table";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The columns in the table.
		*/
		columns;
		/**
		* The minimum width of the table in pixels. `auto` will automatically adjust the table's minimum width according to its content and using the `<number>px` format will give the table an explicit minimum width in pixels. A scrollbar will be displayed if the available width is less than the specified minimum width.
		*/
		minWidth;
		/**
		* Controls whether the first row of the table should be treated as a header.
		*/
		firstRowAsHeaders = true;
		/**
		* Controls if grid lines should be displayed.
		*/
		showGridLines = true;
		/**
		* The style of the grid lines between cells.
		*/
		gridStyle;
		/**
		* Controls how the content of every cell in the table should be horizontally aligned by default.
		*/
		horizontalCellContentAlignment;
		/**
		* Controls how the content of every cell in the table should be vertically aligned by default.
		*/
		verticalCellContentAlignment;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The rows of the table.
		*/
		rows;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Table(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withColumns(...columns) {
			this.columns = columns;
			return this;
		}
		withMinWidth(minWidth) {
			this.minWidth = minWidth;
			return this;
		}
		withFirstRowAsHeaders(firstRowAsHeaders = false) {
			this.firstRowAsHeaders = firstRowAsHeaders;
			return this;
		}
		withShowGridLines(showGridLines = false) {
			this.showGridLines = showGridLines;
			return this;
		}
		withGridStyle(gridStyle) {
			this.gridStyle = gridStyle;
			return this;
		}
		withHorizontalCellContentAlignment(horizontalCellContentAlignment) {
			this.horizontalCellContentAlignment = horizontalCellContentAlignment;
			return this;
		}
		withVerticalCellContentAlignment(verticalCellContentAlignment) {
			this.verticalCellContentAlignment = verticalCellContentAlignment;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withRows(...rows) {
			this.rows = rows;
			return this;
		}
	};
	var ColumnDefinition = class ColumnDefinition {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Controls how the content of every cell in the table should be horizontally aligned by default. This property overrides the horizontalCellContentAlignment property of the table.
		*/
		horizontalCellContentAlignment;
		/**
		* Controls how the content of every cell in the column should be vertically aligned by default. This property overrides the verticalCellContentAlignment property of the table.
		*/
		verticalCellContentAlignment;
		/**
		* The width of the column in the table. If expressed as a number, represents the relative weight of the column in the table. If expressed as a string, `auto` will automatically adjust the column's width according to its content and using the `<number>px` format will give the column an explicit width in pixels.
		*/
		width;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ColumnDefinition(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withHorizontalCellContentAlignment(horizontalCellContentAlignment) {
			this.horizontalCellContentAlignment = horizontalCellContentAlignment;
			return this;
		}
		withVerticalCellContentAlignment(verticalCellContentAlignment) {
			this.verticalCellContentAlignment = verticalCellContentAlignment;
			return this;
		}
		withWidth(width) {
			this.width = width;
			return this;
		}
	};
	function isTextBlock(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "TextBlock";
	}
	var TextBlock = class TextBlock {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **TextBlock**.
		*/
		type = "TextBlock";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The text to display. A subset of markdown is supported.
		*/
		text;
		/**
		* The size of the text.
		*/
		size;
		/**
		* The weight of the text.
		*/
		weight;
		/**
		* The color of the text.
		*/
		color;
		/**
		* Controls whether the text should be renderer using a subtler variant of the select color.
		*/
		isSubtle;
		/**
		* The type of font to use for rendering.
		*/
		fontType;
		/**
		* Controls if the text should wrap.
		*/
		wrap = false;
		/**
		* The maximum number of lines to display.
		*/
		maxLines;
		/**
		* The style of the text.
		*/
		style;
		/**
		* The Id of the input the TextBlock should act as the label of.
		*/
		labelFor;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(text, options = {}) {
			Object.assign(this, options);
			this.text = text;
		}
		static from(options) {
			return new TextBlock(options.text, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withWeight(weight) {
			this.weight = weight;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withIsSubtle(isSubtle) {
			this.isSubtle = isSubtle;
			return this;
		}
		withFontType(fontType) {
			this.fontType = fontType;
			return this;
		}
		withWrap(wrap = true) {
			this.wrap = wrap;
			return this;
		}
		withMaxLines(maxLines) {
			this.maxLines = maxLines;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withLabelFor(labelFor) {
			this.labelFor = labelFor;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isFactSet(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "FactSet";
	}
	var FactSet = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **FactSet**.
		*/
		type = "FactSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The facts in the set.
		*/
		facts;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(...facts) {
			this.facts = facts;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withFacts(...facts) {
			this.facts = facts;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var Fact = class Fact {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The fact's title.
		*/
		title;
		/**
		* The fact's value.
		*/
		value;
		constructor(title, value, options = {}) {
			Object.assign(this, options);
			this.title = title;
			this.value = value;
		}
		static from(options) {
			return new Fact(options.title, options.value, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isImageSet(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ImageSet";
	}
	var ImageSet = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ImageSet**.
		*/
		type = "ImageSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The images in the set.
		*/
		images;
		/**
		* The size to use to render all images in the set.
		*/
		imageSize = "Medium";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(...images) {
			this.images = images;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withImages(...images) {
			this.images = images;
			return this;
		}
		withImageSize(imageSize) {
			this.imageSize = imageSize;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isImage(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Image";
	}
	var Image = class Image {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Image**.
		*/
		type = "Image";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The URL (or Base64-encoded Data URI) of the image. Acceptable formats are PNG, JPEG, GIF and SVG.
		*/
		url;
		/**
		* The alternate text for the image, used for accessibility purposes.
		*/
		altText;
		/**
		* The background color of the image.
		*/
		backgroundColor;
		/**
		* The style of the image.
		*/
		style = "Default";
		/**
		* The size of the image.
		*/
		size = "Auto";
		/**
		* The width of the image.
		*/
		width = "auto";
		/**
		* An Action that will be invoked when the image is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* Controls if the image can be expanded to full screen.
		*/
		allowExpand = false;
		/**
		* Teams-specific metadata associated with the image.
		*/
		msteams;
		/**
		* A set of theme-specific image URLs.
		*/
		themedUrls;
		/**
		* Controls how the image should be fitted inside its bounding box. imageFit is only meaningful when both the width and height properties are set. When fitMode is set to contain, the default style is always used.
		*/
		fitMode = "Fill";
		/**
		* Controls the horizontal position of the image within its bounding box. horizontalContentAlignment is only meaningful when both the width and height properties are set and fitMode is set to either cover or contain.
		*/
		horizontalContentAlignment = "Left";
		/**
		* Controls the vertical position of the image within its bounding box. verticalContentAlignment is only meaningful when both the width and height properties are set and fitMode is set to either cover or contain.
		*/
		verticalContentAlignment = "Top";
		/**
		* The height of the image.
		*/
		height = "auto";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(url, options = {}) {
			Object.assign(this, options);
			this.url = url;
		}
		static from(options) {
			return new Image(options.url, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withAltText(altText) {
			this.altText = altText;
			return this;
		}
		withBackgroundColor(backgroundColor) {
			this.backgroundColor = backgroundColor;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withWidth(width) {
			this.width = width;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withAllowExpand(allowExpand = true) {
			this.allowExpand = allowExpand;
			return this;
		}
		withMsteams(msteams) {
			this.msteams = msteams;
			return this;
		}
		withThemedUrls(...themedUrls) {
			this.themedUrls = themedUrls;
			return this;
		}
		withFitMode(fitMode) {
			this.fitMode = fitMode;
			return this;
		}
		withHorizontalContentAlignment(horizontalContentAlignment) {
			this.horizontalContentAlignment = horizontalContentAlignment;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var TeamsImageProperties = class TeamsImageProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Controls if the image is expandable in Teams. This property is equivalent to the Image.allowExpand property.
		*/
		allowExpand;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TeamsImageProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withAllowExpand(allowExpand) {
			this.allowExpand = allowExpand;
			return this;
		}
	};
	function isTextInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Text";
	}
	var TextInput = class TextInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Text**.
		*/
		type = "Input.Text";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value;
		/**
		* The maximum length of the text in the input.
		*/
		maxLength;
		/**
		* Controls if the input should allow multiple lines of text.
		*/
		isMultiline = false;
		/**
		* The text to display as a placeholder when the user hasn't entered a value.
		*/
		placeholder;
		/**
		* The style of the input.
		*/
		style = "Text";
		/**
		* The action that should be displayed as a button alongside the input. Action.ShowCard is not supported.
		*/
		inlineAction;
		/**
		* The regular expression to validate the input.
		*/
		regex;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TextInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withMaxLength(maxLength) {
			this.maxLength = maxLength;
			return this;
		}
		withIsMultiline(isMultiline = true) {
			this.isMultiline = isMultiline;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withInlineAction(inlineAction) {
			this.inlineAction = inlineAction;
			return this;
		}
		withRegex(regex) {
			this.regex = regex;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isDateInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Date";
	}
	var DateInput = class DateInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Date**.
		*/
		type = "Input.Date";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input, in the `YYYY-MM-DD` format.
		*/
		value;
		/**
		* The text to display as a placeholder when the user has not selected a date.
		*/
		placeholder;
		/**
		* The minimum date that can be selected.
		*/
		min;
		/**
		* The maximum date that can be selected.
		*/
		max;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new DateInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withMin(min) {
			this.min = min;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isTimeInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Time";
	}
	var TimeInput = class TimeInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Time**.
		*/
		type = "Input.Time";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input, in the `HH:MM` format.
		*/
		value;
		/**
		* The text to display as a placeholder when the user hasn't entered a value.
		*/
		placeholder;
		/**
		* The minimum time that can be selected, in the `HH:MM` format.
		*/
		min;
		/**
		* The maximum time that can be selected, in the `HH:MM` format.
		*/
		max;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TimeInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withMin(min) {
			this.min = min;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isNumberInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Number";
	}
	var NumberInput = class NumberInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Number**.
		*/
		type = "Input.Number";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value;
		/**
		* The text to display as a placeholder when the user hasn't entered a value.
		*/
		placeholder;
		/**
		* The minimum value that can be entered.
		*/
		min;
		/**
		* The maximum value that can be entered.
		*/
		max;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new NumberInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withMin(min) {
			this.min = min;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isToggleInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Toggle";
	}
	var ToggleInput = class ToggleInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Toggle**.
		*/
		type = "Input.Toggle";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value = "false";
		/**
		* The title (caption) to display next to the toggle.
		*/
		title;
		/**
		* The value to send to the Bot when the toggle is on.
		*/
		valueOn = "true";
		/**
		* The value to send to the Bot when the toggle is off.
		*/
		valueOff = "false";
		/**
		* Controls if the title should wrap.
		*/
		wrap = true;
		/**
		* Controls whether the title is visually displayed. When set to false, the title is hidden from view but remains accessible to screen readers for accessibility purposes.
		*/
		showTitle = true;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(title, options = {}) {
			Object.assign(this, options);
			this.title = title;
		}
		static from(options) {
			return new ToggleInput(options.title, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withValueOn(valueOn) {
			this.valueOn = valueOn;
			return this;
		}
		withValueOff(valueOff) {
			this.valueOff = valueOff;
			return this;
		}
		withWrap(wrap = false) {
			this.wrap = wrap;
			return this;
		}
		withShowTitle(showTitle = false) {
			this.showTitle = showTitle;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isChoiceSetInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.ChoiceSet";
	}
	var ChoiceSetInput = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.ChoiceSet**.
		*/
		type = "Input.ChoiceSet";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value;
		/**
		* The choices associated with the input.
		*/
		choices;
		/**
		* A Data.Query object that defines the dataset from which to dynamically fetch the choices for the input.
		*/
		"choices.data";
		/**
		* Controls whether the input should be displayed as a dropdown (compact) or a list of radio buttons or checkboxes (expanded).
		*/
		style = "compact";
		/**
		* Controls whether multiple choices can be selected.
		*/
		isMultiSelect = false;
		/**
		* The text to display as a placeholder when the user has not entered any value.
		*/
		placeholder;
		/**
		* Controls if choice titles should wrap.
		*/
		wrap = true;
		/**
		* Controls whether choice items are arranged in multiple columns in expanded mode, or in a single column. Default is false.
		*/
		useMultipleColumns = false;
		/**
		* The minimum width, in pixels, for each column when using a multi-column layout. This ensures that choice items remain readable even when horizontal space is limited. Default is 100 pixels.
		*/
		minColumnWidth;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(...choices) {
			this.choices = choices;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withChoices(...choices) {
			this.choices = choices;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withIsMultiSelect(isMultiSelect = true) {
			this.isMultiSelect = isMultiSelect;
			return this;
		}
		withPlaceholder(placeholder) {
			this.placeholder = placeholder;
			return this;
		}
		withWrap(wrap = false) {
			this.wrap = wrap;
			return this;
		}
		withUseMultipleColumns(useMultipleColumns = true) {
			this.useMultipleColumns = useMultipleColumns;
			return this;
		}
		withMinColumnWidth(minColumnWidth) {
			this.minColumnWidth = minColumnWidth;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var Choice = class Choice {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The text to display for the choice.
		*/
		title;
		/**
		* The value associated with the choice, as sent to the Bot when an Action.Submit or Action.Execute is invoked
		*/
		value;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Choice(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isQueryData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Data.Query";
	}
	var QueryData = class QueryData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Data.Query**.
		*/
		type = "Data.Query";
		/**
		* The dataset from which to fetch the data.
		*/
		dataset;
		/**
		* Controls which inputs are associated with the Data.Query. When a Data.Query is executed, the values of the associated inputs are sent to the Bot, allowing it to perform filtering operations based on the user's input.
		*/
		associatedInputs;
		/**
		* The maximum number of data items that should be returned by the query. Card authors should not specify this property in their card payload. It is determined by the client and sent to the Bot to enable pagination.
		*/
		count;
		/**
		* The number of data items to be skipped by the query. Card authors should not specify this property in their card payload. It is determined by the client and sent to the Bot to enable pagination.
		*/
		skip;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new QueryData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withDataset(dataset) {
			this.dataset = dataset;
			return this;
		}
		withAssociatedInputs(associatedInputs) {
			this.associatedInputs = associatedInputs;
			return this;
		}
		withCount(count) {
			this.count = count;
			return this;
		}
		withSkip(skip) {
			this.skip = skip;
			return this;
		}
	};
	function isRatingInput(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Input.Rating";
	}
	var RatingInput = class RatingInput {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Input.Rating**.
		*/
		type = "Input.Rating";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the input.
		*
		* A label should **always** be provided to ensure the best user experience especially for users of assistive technology.
		*/
		label;
		/**
		* Controls whether the input is required. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		isRequired = false;
		/**
		* The error message to display when the input fails validation. See [Input validation](https://adaptivecards.microsoft.com/?topic=input-validation) for more details.
		*/
		errorMessage;
		/**
		* An Action.ResetInputs action that will be executed when the value of the input changes.
		*/
		valueChangedAction;
		/**
		* The default value of the input.
		*/
		value;
		/**
		* The number of stars to display.
		*/
		max = 5;
		/**
		* Controls if the user can select half stars.
		*/
		allowHalfSteps = false;
		/**
		* The size of the stars.
		*/
		size = "Large";
		/**
		* The color of the stars.
		*/
		color = "Neutral";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new RatingInput(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withIsRequired(isRequired = true) {
			this.isRequired = isRequired;
			return this;
		}
		withErrorMessage(errorMessage) {
			this.errorMessage = errorMessage;
			return this;
		}
		withValueChangedAction(valueChangedAction) {
			this.valueChangedAction = valueChangedAction;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withAllowHalfSteps(allowHalfSteps = true) {
			this.allowHalfSteps = allowHalfSteps;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isRating(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Rating";
	}
	var Rating = class Rating {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Rating**.
		*/
		type = "Rating";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The value of the rating. Must be between 0 and max.
		*/
		value;
		/**
		* The number of "votes" associated with the rating.
		*/
		count;
		/**
		* The number of stars to display.
		*/
		max = 5;
		/**
		* The size of the stars.
		*/
		size = "Large";
		/**
		* The color of the stars.
		*/
		color = "Neutral";
		/**
		* The style of the stars.
		*/
		style = "Default";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Rating(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withCount(count) {
			this.count = count;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isCompoundButton(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "CompoundButton";
	}
	var CompoundButton = class CompoundButton {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **CompoundButton**.
		*/
		type = "CompoundButton";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The icon to show on the button.
		*/
		icon;
		/**
		* The badge to show on the button.
		*/
		badge;
		/**
		* The title of the button.
		*/
		title;
		/**
		* The description text of the button.
		*/
		description;
		/**
		* An Action that will be invoked when the button is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CompoundButton(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withIcon(icon) {
			this.icon = icon;
			return this;
		}
		withBadge(badge) {
			this.badge = badge;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withDescription(description) {
			this.description = description;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var IconInfo = class IconInfo {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The name of the icon to display.
		*/
		name;
		/**
		* The size of the icon.
		*/
		size = "xSmall";
		/**
		* The style of the icon.
		*/
		style = "Regular";
		/**
		* The color of the icon.
		*/
		color = "Default";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new IconInfo(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isIcon(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Icon";
	}
	var Icon = class Icon {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Icon**.
		*/
		type = "Icon";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The name of the icon to display.
		*/
		name;
		/**
		* The size of the icon.
		*/
		size = "Standard";
		/**
		* The style of the icon.
		*/
		style = "Regular";
		/**
		* The color of the icon.
		*/
		color = "Default";
		/**
		* An Action that will be invoked when the icon is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(name, options = {}) {
			Object.assign(this, options);
			this.name = name;
		}
		static from(options) {
			return new Icon(options.name, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isCarousel(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Carousel";
	}
	var Carousel = class Carousel {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Carousel**.
		*/
		type = "Carousel";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Controls the type of animation to use to navigate between pages.
		*/
		pageAnimation = "Slide";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The pages in the carousel.
		*/
		pages;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Carousel(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withPageAnimation(pageAnimation) {
			this.pageAnimation = pageAnimation;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withPages(...pages) {
			this.pages = pages;
			return this;
		}
	};
	function isBadge(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Badge";
	}
	var Badge = class Badge {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Badge**.
		*/
		type = "Badge";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The text to display.
		*/
		text;
		/**
		* The name of an icon from the [Adaptive Card icon catalog](https://adaptivecards.microsoft.com/?topic=icon-catalog) to display, in the `<icon-name>[,regular|filled]` format. If the style is not specified, the regular style is used.
		*/
		icon;
		/**
		* Controls the position of the icon.
		*/
		iconPosition = "Before";
		/**
		* Controls the strength of the background color.
		*/
		appearance = "Filled";
		/**
		* The size of the badge.
		*/
		size = "Medium";
		/**
		* Controls the shape of the badge.
		*/
		shape = "Circular";
		/**
		* The style of the badge.
		*/
		style = "Default";
		/**
		* Controls the tooltip text to display when the badge is hovered over.
		*/
		tooltip;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Badge(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withIcon(icon) {
			this.icon = icon;
			return this;
		}
		withIconPosition(iconPosition) {
			this.iconPosition = iconPosition;
			return this;
		}
		withAppearance(appearance) {
			this.appearance = appearance;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withShape(shape) {
			this.shape = shape;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withTooltip(tooltip) {
			this.tooltip = tooltip;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isProgressRing(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ProgressRing";
	}
	var ProgressRing = class ProgressRing {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ProgressRing**.
		*/
		type = "ProgressRing";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The label of the progress ring.
		*/
		label;
		/**
		* Controls the relative position of the label to the progress ring.
		*/
		labelPosition = "Below";
		/**
		* The size of the progress ring.
		*/
		size = "Medium";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ProgressRing(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withLabel(label) {
			this.label = label;
			return this;
		}
		withLabelPosition(labelPosition) {
			this.labelPosition = labelPosition;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isProgressBar(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ProgressBar";
	}
	var ProgressBar = class ProgressBar {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ProgressBar**.
		*/
		type = "ProgressBar";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The value of the progress bar. Must be between 0 and max.
		*/
		value;
		/**
		* The maximum value of the progress bar.
		*/
		max = 100;
		/**
		* The color of the progress bar. `color` has no effect when the `ProgressBar` is in indeterminate mode, in which case the "accent" color is always used.
		*/
		color = "Accent";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ProgressBar(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isDonutChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.Donut";
	}
	var DonutChart = class DonutChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.Donut**.
		*/
		type = "Chart.Donut";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The data to display in the chart.
		*/
		data;
		/**
		* The value that should be displayed in the center of a Donut chart. `value` is ignored for Pie charts.
		*/
		value;
		/**
		* Controls the color of the value displayed in the center of a Donut chart.
		*/
		valueColor;
		/**
		* Controls the thickness of the donut segments. Default is **Thick**.
		*/
		thickness;
		/**
		* Controls whether the outlines of the donut segments are displayed.
		*/
		showOutlines = true;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new DonutChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withValueColor(valueColor) {
			this.valueColor = valueColor;
			return this;
		}
		withThickness(thickness) {
			this.thickness = thickness;
			return this;
		}
		withShowOutlines(showOutlines = false) {
			this.showOutlines = showOutlines;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var DonutChartData = class DonutChartData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The legend of the chart.
		*/
		legend;
		/**
		* The value associated with the data point.
		*/
		value = 0;
		/**
		* The color to use for the data point. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new DonutChartData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isPieChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.Pie";
	}
	var PieChart = class PieChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.Pie**.
		*/
		type = "Chart.Pie";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The data to display in the chart.
		*/
		data;
		/**
		* The value that should be displayed in the center of a Donut chart. `value` is ignored for Pie charts.
		*/
		value;
		/**
		* Controls the color of the value displayed in the center of a Donut chart.
		*/
		valueColor;
		/**
		* Controls the thickness of the donut segments. Default is **Thick**.
		*/
		thickness;
		/**
		* Controls whether the outlines of the donut segments are displayed.
		*/
		showOutlines = true;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new PieChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withValueColor(valueColor) {
			this.valueColor = valueColor;
			return this;
		}
		withThickness(thickness) {
			this.thickness = thickness;
			return this;
		}
		withShowOutlines(showOutlines = false) {
			this.showOutlines = showOutlines;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isGroupedVerticalBarChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.VerticalBar.Grouped";
	}
	var GroupedVerticalBarChart = class GroupedVerticalBarChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.VerticalBar.Grouped**.
		*/
		type = "Chart.VerticalBar.Grouped";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* Controls if bars in the chart should  be displayed as stacks instead of groups.
		*
		* **Note:** stacked vertical bar charts do not support custom Y ranges nor negative Y values.
		*/
		stacked = false;
		/**
		* The data points in a series.
		*/
		data;
		/**
		* Controls if values should be displayed on each bar.
		*/
		showBarValues = false;
		/**
		* The requested minimum for the Y axis range. The value used at runtime may be different to optimize visual presentation.
		*
		* `yMin` is ignored if `stacked` is set to `true`.
		*/
		yMin;
		/**
		* The requested maximum for the Y axis range. The value used at runtime may be different to optimize visual presentation.
		*
		* `yMax` is ignored if `stacked` is set to `true`.
		*/
		yMax;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GroupedVerticalBarChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withStacked(stacked = true) {
			this.stacked = stacked;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withShowBarValues(showBarValues = true) {
			this.showBarValues = showBarValues;
			return this;
		}
		withYMin(yMin) {
			this.yMin = yMin;
			return this;
		}
		withYMax(yMax) {
			this.yMax = yMax;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var GroupedVerticalBarChartData = class GroupedVerticalBarChartData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The legend of the chart.
		*/
		legend;
		/**
		* The data points in the series.
		*/
		values;
		/**
		* The color to use for all data points in the series. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GroupedVerticalBarChartData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withValues(...values) {
			this.values = values;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	var BarChartDataValue = class BarChartDataValue {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The x axis value of the data point.
		*/
		x;
		/**
		* The y axis value of the data point.
		*/
		y = 0;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new BarChartDataValue(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withX(x) {
			this.x = x;
			return this;
		}
		withY(y) {
			this.y = y;
			return this;
		}
	};
	function isVerticalBarChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.VerticalBar";
	}
	var VerticalBarChart = class VerticalBarChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.VerticalBar**.
		*/
		type = "Chart.VerticalBar";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The data to display in the chart.
		*/
		data;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* Controls if the bar values should be displayed.
		*/
		showBarValues = false;
		/**
		* The requested minimum for the Y axis range. The value used at runtime may be different to optimize visual presentation.
		*/
		yMin;
		/**
		* The requested maximum for the Y axis range. The value used at runtime may be different to optimize visual presentation.
		*/
		yMax;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new VerticalBarChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withShowBarValues(showBarValues = true) {
			this.showBarValues = showBarValues;
			return this;
		}
		withYMin(yMin) {
			this.yMin = yMin;
			return this;
		}
		withYMax(yMax) {
			this.yMax = yMax;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var VerticalBarChartDataValue = class VerticalBarChartDataValue {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The x axis value of the data point.
		*/
		x;
		/**
		* The y axis value of the data point.
		*/
		y = 0;
		/**
		* The color to use for the bar associated with the data point. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new VerticalBarChartDataValue(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withX(x) {
			this.x = x;
			return this;
		}
		withY(y) {
			this.y = y;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isHorizontalBarChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.HorizontalBar";
	}
	var HorizontalBarChart = class HorizontalBarChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.HorizontalBar**.
		*/
		type = "Chart.HorizontalBar";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* The data points in the chart.
		*/
		data;
		/**
		* Controls how the chart should be visually laid out.
		*/
		displayMode = "AbsoluteWithAxis";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new HorizontalBarChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withDisplayMode(displayMode) {
			this.displayMode = displayMode;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var HorizontalBarChartDataValue = class HorizontalBarChartDataValue {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The x axis value of the data point.
		*/
		x;
		/**
		* The y axis value of the data point.
		*/
		y = 0;
		/**
		* The color of the bar associated with the data point. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new HorizontalBarChartDataValue(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withX(x) {
			this.x = x;
			return this;
		}
		withY(y) {
			this.y = y;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isStackedHorizontalBarChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.HorizontalBar.Stacked";
	}
	var StackedHorizontalBarChart = class StackedHorizontalBarChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.HorizontalBar.Stacked**.
		*/
		type = "Chart.HorizontalBar.Stacked";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* The data to display in the chart.
		*/
		data;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StackedHorizontalBarChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var StackedHorizontalBarChartData = class StackedHorizontalBarChartData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The title of the series.
		*/
		title;
		/**
		* The data points in the series.
		*/
		data;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StackedHorizontalBarChartData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
	};
	var StackedHorizontalBarChartDataPoint = class StackedHorizontalBarChartDataPoint {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The legend associated with the data point.
		*/
		legend;
		/**
		* The value of the data point.
		*/
		value = 0;
		/**
		* The color to use to render the bar associated with the data point. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StackedHorizontalBarChartDataPoint(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isLineChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.Line";
	}
	var LineChart = class LineChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.Line**.
		*/
		type = "Chart.Line";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The title of the x axis.
		*/
		xAxisTitle;
		/**
		* The title of the y axis.
		*/
		yAxisTitle;
		/**
		* The color to use for all data points. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		/**
		* The data point series in the line chart.
		*/
		data;
		/**
		* The maximum y range.
		*/
		yMin;
		/**
		* The minimum y range.
		*/
		yMax;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new LineChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withXAxisTitle(xAxisTitle) {
			this.xAxisTitle = xAxisTitle;
			return this;
		}
		withYAxisTitle(yAxisTitle) {
			this.yAxisTitle = yAxisTitle;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withData(...data) {
			this.data = data;
			return this;
		}
		withYMin(yMin) {
			this.yMin = yMin;
			return this;
		}
		withYMax(yMax) {
			this.yMax = yMax;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var LineChartData = class LineChartData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The legend of the chart.
		*/
		legend;
		/**
		* The data points in the series.
		*/
		values;
		/**
		* The color all data points in the series. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new LineChartData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withValues(...values) {
			this.values = values;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	var LineChartValue = class LineChartValue {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The x axis value of the data point.
		*
		* If all x values of the x [Chart.Line](https://adaptivecards.microsoft.com/?topic=Chart.Line) are expressed as a number, or if all x values are expressed as a date string in the `YYYY-MM-DD` format, the chart will be rendered as a time series chart, i.e. x axis values will span across the minimum x value to maximum x value range.
		*
		* Otherwise, if x values are represented as a mix of numbers and strings or if at least one x value isn't in the `YYYY-MM-DD` format, the chart will be rendered as a categorical chart, i.e. x axis values will be displayed as categories.
		*/
		x;
		/**
		* The y axis value of the data point.
		*/
		y = 0;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new LineChartValue(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withX(x) {
			this.x = x;
			return this;
		}
		withY(y) {
			this.y = y;
			return this;
		}
	};
	function isGaugeChart(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Chart.Gauge";
	}
	var GaugeChart = class GaugeChart {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Chart.Gauge**.
		*/
		type = "Chart.Gauge";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The title of the chart.
		*/
		title;
		/**
		* Controls whether the chart's title should be displayed. Defaults to `false`.
		*/
		showTitle = false;
		/**
		* The name of the set of colors to use to render the chart. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		colorSet;
		/**
		* The maximum width, in pixels, of the chart, in the `<number>px` format.
		*/
		maxWidth;
		/**
		* Controls whether the chart's legend should be displayed.
		*/
		showLegend = true;
		/**
		* The minimum value of the gauge.
		*/
		min = 0;
		/**
		* The maximum value of the gauge.
		*/
		max;
		/**
		* The sub-label of the gauge.
		*/
		subLabel;
		/**
		* Controls whether the min/max values should be displayed.
		*/
		showMinMax = true;
		/**
		* Controls whether the gauge's needle is displayed. Default is **true**.
		*/
		showNeedle = true;
		/**
		* Controls whether the outlines of the gauge segments are displayed.
		*/
		showOutlines = true;
		/**
		* The segments to display in the gauge.
		*/
		segments;
		/**
		* The value of the gauge.
		*/
		value = 0;
		/**
		* The format used to display the gauge's value.
		*/
		valueFormat = "Percentage";
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GaugeChart(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withShowTitle(showTitle = true) {
			this.showTitle = showTitle;
			return this;
		}
		withColorSet(colorSet) {
			this.colorSet = colorSet;
			return this;
		}
		withMaxWidth(maxWidth) {
			this.maxWidth = maxWidth;
			return this;
		}
		withShowLegend(showLegend = false) {
			this.showLegend = showLegend;
			return this;
		}
		withMin(min) {
			this.min = min;
			return this;
		}
		withMax(max) {
			this.max = max;
			return this;
		}
		withSubLabel(subLabel) {
			this.subLabel = subLabel;
			return this;
		}
		withShowMinMax(showMinMax = false) {
			this.showMinMax = showMinMax;
			return this;
		}
		withShowNeedle(showNeedle = false) {
			this.showNeedle = showNeedle;
			return this;
		}
		withShowOutlines(showOutlines = false) {
			this.showOutlines = showOutlines;
			return this;
		}
		withSegments(...segments) {
			this.segments = segments;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
		withValueFormat(valueFormat) {
			this.valueFormat = valueFormat;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var GaugeChartLegend = class GaugeChartLegend {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The size of the segment.
		*/
		size = 0;
		/**
		* The legend text associated with the segment.
		*/
		legend;
		/**
		* The color to use for the segment. See [Chart colors reference](https://adaptivecards.microsoft.com/?topic=chart-colors-reference).
		*/
		color;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new GaugeChartLegend(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withLegend(legend) {
			this.legend = legend;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
	};
	function isCodeBlock(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "CodeBlock";
	}
	var CodeBlock = class CodeBlock {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **CodeBlock**.
		*/
		type = "CodeBlock";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The code snippet to display.
		*/
		codeSnippet;
		/**
		* The language the code snippet is expressed in.
		*/
		language = "PlainText";
		/**
		* A number that represents the line in the file from where the code snippet was extracted.
		*/
		startLineNumber = 1;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CodeBlock(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withCodeSnippet(codeSnippet) {
			this.codeSnippet = codeSnippet;
			return this;
		}
		withLanguage(language) {
			this.language = language;
			return this;
		}
		withStartLineNumber(startLineNumber) {
			this.startLineNumber = startLineNumber;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isComUserMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/user";
	}
	var ComUserMicrosoftGraphComponent = class ComUserMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/user**.
		*/
		name = "graph.microsoft.com/user";
		/**
		* The properties of the Persona component.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComUserMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var PersonaProperties = class PersonaProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The Id of the persona.
		*/
		id;
		/**
		* The UPN of the persona.
		*/
		userPrincipalName;
		/**
		* The display name of the persona.
		*/
		displayName;
		/**
		* Defines the style of the icon for the persona.
		*/
		iconStyle;
		/**
		* Defines how the persona should be displayed.
		*/
		style;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new PersonaProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withUserPrincipalName(userPrincipalName) {
			this.userPrincipalName = userPrincipalName;
			return this;
		}
		withDisplayName(displayName) {
			this.displayName = displayName;
			return this;
		}
		withIconStyle(iconStyle) {
			this.iconStyle = iconStyle;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
	};
	function isComUsersMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/users";
	}
	var ComUsersMicrosoftGraphComponent = class ComUsersMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/users**.
		*/
		name = "graph.microsoft.com/users";
		/**
		* The properties of the PersonaSet component.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComUsersMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var PersonaSetProperties = class PersonaSetProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The users a PersonaSet component should display.
		*/
		users;
		/**
		* Defines the style of the icon for the personas in the set.
		*/
		iconStyle;
		/**
		* Defines how each persona in the set should be displayed.
		*/
		style;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new PersonaSetProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withUsers(...users) {
			this.users = users;
			return this;
		}
		withIconStyle(iconStyle) {
			this.iconStyle = iconStyle;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
	};
	function isComResourceMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/resource";
	}
	var ComResourceMicrosoftGraphComponent = class ComResourceMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/resource**.
		*/
		name = "graph.microsoft.com/resource";
		/**
		* The properties of the resource.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComResourceMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var ResourceProperties = class ResourceProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The Id of the resource.
		*/
		id;
		/**
		* The reference to the resource.
		*/
		resourceReference;
		/**
		* The visualization of the resource.
		*/
		resourceVisualization;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ResourceProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withResourceReference(resourceReference) {
			this.resourceReference = resourceReference;
			return this;
		}
		withResourceVisualization(resourceVisualization) {
			this.resourceVisualization = resourceVisualization;
			return this;
		}
	};
	var ResourceVisualization = class ResourceVisualization {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The media associated with the resource.
		*/
		media;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ResourceVisualization(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withMedia(media) {
			this.media = media;
			return this;
		}
	};
	function isComFileMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/file";
	}
	var ComFileMicrosoftGraphComponent = class ComFileMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/file**.
		*/
		name = "graph.microsoft.com/file";
		/**
		* The properties of the file.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComFileMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var FileProperties = class FileProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The name of the file.
		*/
		name;
		/**
		* The file extension.
		*/
		extension;
		/**
		* The URL of the file.
		*/
		url;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new FileProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withExtension(extension) {
			this.extension = extension;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
	};
	function isComEventMicrosoftGraphComponent(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Component" && obj.name === "graph.microsoft.com/event";
	}
	var ComEventMicrosoftGraphComponent = class ComEventMicrosoftGraphComponent {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **Component**.
		*/
		type = "Component";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Must be **graph.microsoft.com/event**.
		*/
		name = "graph.microsoft.com/event";
		/**
		* The properties of the event.
		*/
		properties;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ComEventMicrosoftGraphComponent(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withProperties(properties) {
			this.properties = properties;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	var CalendarEventProperties = class CalendarEventProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The ID of the event.
		*/
		id;
		/**
		* The title of the event.
		*/
		title;
		/**
		* The start date and time of the event.
		*/
		start;
		/**
		* The end date and time of the event.
		*/
		end;
		/**
		* The status of the event.
		*/
		status;
		/**
		* The locations of the event.
		*/
		locations;
		/**
		* The URL of the online meeting.
		*/
		onlineMeetingUrl;
		/**
		* Indicates if the event is all day.
		*/
		isAllDay;
		/**
		* The extension of the event.
		*/
		extension;
		/**
		* The URL of the event.
		*/
		url;
		/**
		* The attendees of the event.
		*/
		attendees;
		/**
		* The organizer of the event.
		*/
		organizer;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CalendarEventProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withStart(start) {
			this.start = start;
			return this;
		}
		withEnd(end) {
			this.end = end;
			return this;
		}
		withStatus(status) {
			this.status = status;
			return this;
		}
		withLocations(...locations) {
			this.locations = locations;
			return this;
		}
		withOnlineMeetingUrl(onlineMeetingUrl) {
			this.onlineMeetingUrl = onlineMeetingUrl;
			return this;
		}
		withIsAllDay(isAllDay) {
			this.isAllDay = isAllDay;
			return this;
		}
		withExtension(extension) {
			this.extension = extension;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withAttendees(...attendees) {
			this.attendees = attendees;
			return this;
		}
		withOrganizer(organizer) {
			this.organizer = organizer;
			return this;
		}
	};
	var CalendarEventAttendee = class CalendarEventAttendee {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The name of the attendee.
		*/
		name;
		/**
		* The email address of the attendee.
		*/
		email;
		/**
		* The title of the attendee.
		*/
		title;
		/**
		* The type of the attendee.
		*/
		type;
		/**
		* The status of the attendee.
		*/
		status;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CalendarEventAttendee(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withEmail(email) {
			this.email = email;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withType(type) {
			this.type = type;
			return this;
		}
		withStatus(status) {
			this.status = status;
			return this;
		}
	};
	function isCarouselPage(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "CarouselPage";
	}
	var CarouselPage = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **CarouselPage**.
		*/
		type = "CarouselPage";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* The maximum height, in pixels, of the container, in the `<number>px` format. When the content of a container exceeds the container's maximum height, a vertical scrollbar is displayed.
		*/
		maxHeight;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The elements in the page.
		*/
		items;
		constructor(...items) {
			this.items = items;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		withMaxHeight(maxHeight) {
			this.maxHeight = maxHeight;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withItems(...items) {
			this.items = items;
			return this;
		}
	};
	function isTableRow(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "TableRow";
	}
	var TableRow = class TableRow {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **TableRow**.
		*/
		type = "TableRow";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls how the content of every cell in the row should be horizontally aligned by default. This property overrides the horizontalCellContentAlignment property of the table and columns.
		*/
		horizontalCellContentAlignment;
		/**
		* Controls how the content of every cell in the row should be vertically aligned by default. This property overrides the verticalCellContentAlignment property of the table and columns.
		*/
		verticalCellContentAlignment;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The cells in the row.
		*/
		cells;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TableRow(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withHorizontalCellContentAlignment(horizontalCellContentAlignment) {
			this.horizontalCellContentAlignment = horizontalCellContentAlignment;
			return this;
		}
		withVerticalCellContentAlignment(verticalCellContentAlignment) {
			this.verticalCellContentAlignment = verticalCellContentAlignment;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withCells(...cells) {
			this.cells = cells;
			return this;
		}
	};
	function isTableCell(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "TableCell";
	}
	var TableCell = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **TableCell**.
		*/
		type = "TableCell";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* The maximum height, in pixels, of the container, in the `<number>px` format. When the content of a container exceeds the container's maximum height, a vertical scrollbar is displayed.
		*/
		maxHeight;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The items (elements) in the cell.
		*/
		items;
		constructor(...items) {
			this.items = items;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		withMaxHeight(maxHeight) {
			this.maxHeight = maxHeight;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withItems(...items) {
			this.items = items;
			return this;
		}
	};
	function isTextRun(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "TextRun";
	}
	var TextRun = class TextRun {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **TextRun**.
		*/
		type = "TextRun";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The text to display. A subset of markdown is supported.
		*/
		text;
		/**
		* The size of the text.
		*/
		size;
		/**
		* The weight of the text.
		*/
		weight;
		/**
		* The color of the text.
		*/
		color;
		/**
		* Controls whether the text should be renderer using a subtler variant of the select color.
		*/
		isSubtle;
		/**
		* The type of font to use for rendering.
		*/
		fontType;
		/**
		* Controls if the text should be italicized.
		*/
		italic = false;
		/**
		* Controls if the text should be struck through.
		*/
		strikethrough = false;
		/**
		* Controls if the text should be highlighted.
		*/
		highlight = false;
		/**
		* Controls if the text should be underlined.
		*/
		underline = false;
		/**
		* An Action that will be invoked when the text is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(text, options = {}) {
			Object.assign(this, options);
			this.text = text;
		}
		static from(options) {
			return new TextRun(options.text, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withWeight(weight) {
			this.weight = weight;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withIsSubtle(isSubtle) {
			this.isSubtle = isSubtle;
			return this;
		}
		withFontType(fontType) {
			this.fontType = fontType;
			return this;
		}
		withItalic(italic = true) {
			this.italic = italic;
			return this;
		}
		withStrikethrough(strikethrough = true) {
			this.strikethrough = strikethrough;
			return this;
		}
		withHighlight(highlight = true) {
			this.highlight = highlight;
			return this;
		}
		withUnderline(underline = true) {
			this.underline = underline;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isIconRun(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "IconRun";
	}
	var IconRun = class IconRun {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **IconRun**.
		*/
		type = "IconRun";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The name of the inline icon to display.
		*/
		name;
		/**
		* The size of the inline icon.
		*/
		size = "Default";
		/**
		* The style of the inline icon.
		*/
		style = "Regular";
		/**
		* The color of the inline icon.
		*/
		color = "Default";
		/**
		* An Action that will be invoked when the inline icon is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new IconRun(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withColor(color) {
			this.color = color;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isImageRun(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "ImageRun";
	}
	var ImageRun = class ImageRun {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **ImageRun**.
		*/
		type = "ImageRun";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* The URL (or Base64-encoded Data URI) of the image. Acceptable formats are PNG, JPEG, GIF and SVG.
		*/
		url;
		/**
		* The size of the inline image.
		*/
		size = "Default";
		/**
		* The style of the inline image.
		*/
		style = "Default";
		/**
		* An Action that will be invoked when the image is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* A set of theme-specific image URLs.
		*/
		themedUrls;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new ImageRun(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withUrl(url) {
			this.url = url;
			return this;
		}
		withSize(size) {
			this.size = size;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withThemedUrls(...themedUrls) {
			this.themedUrls = themedUrls;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
	};
	function isColumn(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "Column";
	}
	var Column = class {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Optional. If specified, must be **Column**.
		*/
		type = "Column";
		/**
		* A unique identifier for the element or action. Input elements must have an id, otherwise they will not be validated and their values will not be sent to the Bot.
		*/
		id;
		/**
		* A list of capabilities the element requires the host application to support. If the host application doesn't support at least one of the listed capabilities, the element is not rendered (or its fallback is rendered if provided).
		*/
		requires = {};
		/**
		* The locale associated with the element.
		*/
		lang;
		/**
		* Controls the visibility of the element.
		*/
		isVisible = true;
		/**
		* Controls whether a separator line should be displayed above the element to visually separate it from the previous element. No separator will be displayed for the first element in a container, even if this property is set to true.
		*/
		separator = false;
		/**
		* The height of the element. When set to stretch, the element will use the remaining vertical space in its container.
		*/
		height = "auto";
		/**
		* Controls how the element should be horizontally aligned.
		*/
		horizontalAlignment;
		/**
		* Controls the amount of space between this element and the previous one. No space will be added for the first element in a container.
		*/
		spacing = "Default";
		/**
		* Controls for which card width the element should be displayed. If targetWidth isn't specified, the element is rendered at all card widths. Using targetWidth makes it possible to author responsive cards that adapt their layout to the available horizontal space. For more details, see [Responsive layout](https://adaptivecards.microsoft.com/?topic=responsive-layout).
		*/
		targetWidth;
		/**
		* Controls whether the element should be used as a sort key by elements that allow sorting across a collection of elements.
		*/
		isSortKey = false;
		/**
		* An Action that will be invoked when the element is tapped or clicked. Action.ShowCard is not supported.
		*/
		selectAction;
		/**
		* The style of the container. Container styles control the colors of the background, border and text inside the container, in such a way that contrast requirements are always met.
		*/
		style;
		/**
		* Controls if a border should be displayed around the container.
		*/
		showBorder = false;
		/**
		* Controls if the container should have rounded corners.
		*/
		roundedCorners = false;
		/**
		* The layouts associated with the container. The container can dynamically switch from one layout to another as the card's width changes. See [Container layouts](https://adaptivecards.microsoft.com/?topic=container-layouts) for more details.
		*/
		layouts;
		/**
		* Controls if the container should bleed into its parent. A bleeding container extends into its parent's padding.
		*/
		bleed = false;
		/**
		* The minimum height, in pixels, of the container, in the `<number>px` format.
		*/
		minHeight;
		/**
		* Defines the container's background image.
		*/
		backgroundImage;
		/**
		* Controls how the container's content should be vertically aligned.
		*/
		verticalContentAlignment;
		/**
		* Controls if the content of the card is to be rendered left-to-right or right-to-left.
		*/
		rtl;
		/**
		* The maximum height, in pixels, of the container, in the `<number>px` format. When the content of a container exceeds the container's maximum height, a vertical scrollbar is displayed.
		*/
		maxHeight;
		/**
		* The width of the column. If expressed as a number, represents the relative weight of the column in the set. If expressed as a string, `auto` will automatically adjust the column's width according to its content, `stretch` will make the column use the remaining horizontal space (shared with other columns with width set to `stretch`) and using the `<number>px` format will give the column an explicit width in pixels.
		*/
		width;
		/**
		* The area of a Layout.AreaGrid layout in which an element should be displayed.
		*/
		"grid.area";
		/**
		* An alternate element to render if the type of this one is unsupported or if the host application doesn't support all the capabilities specified in the requires property.
		*/
		fallback;
		/**
		* The elements in the column.
		*/
		items;
		constructor(...items) {
			this.items = items;
		}
		withOptions(value) {
			Object.assign(this, value);
			return this;
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withRequires(requires) {
			this.requires = requires;
			return this;
		}
		withLang(lang) {
			this.lang = lang;
			return this;
		}
		withIsVisible(isVisible = false) {
			this.isVisible = isVisible;
			return this;
		}
		withSeparator(separator = true) {
			this.separator = separator;
			return this;
		}
		withHeight(height) {
			this.height = height;
			return this;
		}
		withHorizontalAlignment(horizontalAlignment) {
			this.horizontalAlignment = horizontalAlignment;
			return this;
		}
		withSpacing(spacing) {
			this.spacing = spacing;
			return this;
		}
		withTargetWidth(targetWidth) {
			this.targetWidth = targetWidth;
			return this;
		}
		withIsSortKey(isSortKey = true) {
			this.isSortKey = isSortKey;
			return this;
		}
		withSelectAction(selectAction) {
			this.selectAction = selectAction;
			return this;
		}
		withStyle(style) {
			this.style = style;
			return this;
		}
		withShowBorder(showBorder = true) {
			this.showBorder = showBorder;
			return this;
		}
		withRoundedCorners(roundedCorners = true) {
			this.roundedCorners = roundedCorners;
			return this;
		}
		withLayouts(...layouts) {
			this.layouts = layouts;
			return this;
		}
		withBleed(bleed = true) {
			this.bleed = bleed;
			return this;
		}
		withMinHeight(minHeight) {
			this.minHeight = minHeight;
			return this;
		}
		withBackgroundImage(backgroundImage) {
			this.backgroundImage = backgroundImage;
			return this;
		}
		withVerticalContentAlignment(verticalContentAlignment) {
			this.verticalContentAlignment = verticalContentAlignment;
			return this;
		}
		withRtl(rtl) {
			this.rtl = rtl;
			return this;
		}
		withMaxHeight(maxHeight) {
			this.maxHeight = maxHeight;
			return this;
		}
		withWidth(width) {
			this.width = width;
			return this;
		}
		withFallback(fallback) {
			this.fallback = fallback;
			return this;
		}
		withItems(...items) {
			this.items = items;
			return this;
		}
	};
	var SubmitActionData = class SubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		/**
		* Defines the optional Teams-specific portion of the action's data.
		*/
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new SubmitActionData(options);
		}
	};
	function isImBackSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "imBack";
	}
	var ImBackSubmitActionData = class ImBackSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **imBack**.
		*/
		type = "imBack";
		/**
		* The value that will be sent to the Bot.
		*/
		value;
		constructor(value, options = {}) {
			Object.assign(this, options);
			this.value = value;
		}
		static from(options) {
			return new ImBackSubmitActionData(options.value, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isInvokeSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "invoke";
	}
	var InvokeSubmitActionData = class InvokeSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **invoke**.
		*/
		type = "invoke";
		/**
		* The object to send to the Bot with the Invoke request. Can be strongly typed as one of the below values to trigger a specific action in Teams.
		*/
		value;
		constructor(value, options = {}) {
			Object.assign(this, options);
			this.value = value;
		}
		static from(options) {
			return new InvokeSubmitActionData(options.value, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isCollabStageInvokeDataValue(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "tab/tabInfoAction";
	}
	var CollabStageInvokeDataValue = class CollabStageInvokeDataValue {
		/**
		* Must be **tab/tabInfoAction**.
		*/
		type = "tab/tabInfoAction";
		/**
		* Provides information about the iFrame content, rendered in the collab stage popout window.
		*/
		tabInfo;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CollabStageInvokeDataValue(options);
		}
		withTabInfo(tabInfo) {
			this.tabInfo = tabInfo;
			return this;
		}
	};
	var TabInfo = class TabInfo {
		/**
		* The name for the content. This will be displayed as the title of the window hosting the iFrame.
		*/
		name;
		/**
		* The URL to open in an iFrame.
		*/
		contentUrl;
		/**
		* The unique entity id for this content (e.g., random UUID).
		*/
		entityId;
		/**
		* An optional website URL to the content, allowing users to open this content in the browser (if they prefer).
		*/
		websiteUrl;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TabInfo(options);
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withContentUrl(contentUrl) {
			this.contentUrl = contentUrl;
			return this;
		}
		withEntityId(entityId) {
			this.entityId = entityId;
			return this;
		}
		withWebsiteUrl(websiteUrl) {
			this.websiteUrl = websiteUrl;
			return this;
		}
	};
	function isMessageBackSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "messageBack";
	}
	var MessageBackSubmitActionData = class MessageBackSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **messageBack**.
		*/
		type = "messageBack";
		/**
		* The text that will be sent to the Bot.
		*/
		text;
		/**
		* The optional text that will be displayed as a new message in the conversation, as if the end-user sent it. `displayText` is not sent to the Bot.
		*/
		displayText;
		/**
		* Optional additional value that will be sent to the Bot. For instance, `value` can encode specific context for the action, such as unique identifiers or a JSON object.
		*/
		value;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new MessageBackSubmitActionData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withDisplayText(displayText) {
			this.displayText = displayText;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isSigninSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "signin";
	}
	var SigninSubmitActionData = class SigninSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **signin**.
		*/
		type = "signin";
		/**
		* The URL to redirect the end-user for signing in.
		*/
		value;
		constructor(value, options = {}) {
			Object.assign(this, options);
			this.value = value;
		}
		static from(options) {
			return new SigninSubmitActionData(options.value, options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	function isTaskFetchSubmitActionData(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "task/fetch";
	}
	var TaskFetchSubmitActionData = class TaskFetchSubmitActionData {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **task/fetch**.
		*/
		type = "task/fetch";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TaskFetchSubmitActionData(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
	};
	var TeamsSubmitActionProperties = class TeamsSubmitActionProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Defines how feedback is provided to the end-user when the action is executed.
		*/
		feedback;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TeamsSubmitActionProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withFeedback(feedback) {
			this.feedback = feedback;
			return this;
		}
	};
	var TeamsSubmitActionFeedback = class TeamsSubmitActionFeedback {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Defines if a feedback message should be displayed after the action is executed.
		*/
		hide;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TeamsSubmitActionFeedback(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withHide(hide) {
			this.hide = hide;
			return this;
		}
	};
	var RefreshDefinition = class RefreshDefinition {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The Action.Execute action to invoke to refresh the card.
		*/
		action;
		/**
		* The list of user Ids for which the card will be automatically refreshed. In Teams, in chats or channels with more than 60 users, the card will automatically refresh only for users specified in the userIds list. Other users will have to manually click on a "refresh" button. In contexts with fewer than 60 users, the card will automatically refresh for all users.
		*/
		userIds;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new RefreshDefinition(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withAction(action) {
			this.action = action;
			return this;
		}
		withUserIds(...userIds) {
			this.userIds = userIds;
			return this;
		}
	};
	var Authentication = class Authentication {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The text that can be displayed to the end user when prompting them to authenticate.
		*/
		text;
		/**
		* The identifier for registered OAuth connection setting information.
		*/
		connectionName;
		/**
		* The buttons that should be displayed to the user when prompting for authentication. The array MUST contain one button of type “signin”. Other button types are not currently supported.
		*/
		buttons;
		/**
		* Provides information required to enable on-behalf-of single sign-on user authentication.
		*/
		tokenExchangeResource;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Authentication(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withConnectionName(connectionName) {
			this.connectionName = connectionName;
			return this;
		}
		withButtons(...buttons) {
			this.buttons = buttons;
			return this;
		}
		withTokenExchangeResource(tokenExchangeResource) {
			this.tokenExchangeResource = tokenExchangeResource;
			return this;
		}
	};
	var AuthCardButton = class AuthCardButton {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **signin**.
		*/
		type;
		/**
		* The caption of the button.
		*/
		title;
		/**
		* A URL to an image to display alongside the button’s caption.
		*/
		image;
		/**
		* The value associated with the button. The meaning of value depends on the button’s type.
		*/
		value;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new AuthCardButton(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withType(type) {
			this.type = type;
			return this;
		}
		withTitle(title) {
			this.title = title;
			return this;
		}
		withImage(image) {
			this.image = image;
			return this;
		}
		withValue(value) {
			this.value = value;
			return this;
		}
	};
	var TokenExchangeResource = class TokenExchangeResource {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The unique identified of this token exchange instance.
		*/
		id;
		/**
		* An application ID or resource identifier with which to exchange a token on behalf of. This property is identity provider- and application-specific.
		*/
		uri;
		/**
		* An identifier for the identity provider with which to attempt a token exchange.
		*/
		providerId;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TokenExchangeResource(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withUri(uri) {
			this.uri = uri;
			return this;
		}
		withProviderId(providerId) {
			this.providerId = providerId;
			return this;
		}
	};
	var TeamsCardProperties = class TeamsCardProperties {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Controls the width of the card in a Teams chat.
		*
		* Note that setting `width` to "full" will not actually stretch the card to the "full width" of the chat pane. It will only make the card wider than when the `width` property isn't set.
		*/
		width;
		/**
		* The Teams-specific entities associated with the card.
		*/
		entities;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new TeamsCardProperties(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withWidth(width) {
			this.width = width;
			return this;
		}
		withEntities(...entities) {
			this.entities = entities;
			return this;
		}
	};
	function isMention(value) {
		const obj = value;
		return typeof obj === "object" && obj.type === "mention";
	}
	var Mention = class Mention {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* Must be **mention**.
		*/
		type = "mention";
		/**
		* The text that will be substituted with the mention.
		*/
		text;
		/**
		* Defines the entity being mentioned.
		*/
		mentioned;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Mention(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withText(text) {
			this.text = text;
			return this;
		}
		withMentioned(mentioned) {
			this.mentioned = mentioned;
			return this;
		}
	};
	var MentionedEntity = class MentionedEntity {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The Id of a person (typically a Microsoft Entra user Id) or tag.
		*/
		id;
		/**
		* The name of the mentioned entity.
		*/
		name;
		/**
		* The type of the mentioned entity.
		*/
		mentionType = "Person";
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new MentionedEntity(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withId(id) {
			this.id = id;
			return this;
		}
		withName(name) {
			this.name = name;
			return this;
		}
		withMentionType(mentionType) {
			this.mentionType = mentionType;
			return this;
		}
	};
	var CardMetadata = class CardMetadata {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The URL the card originates from. When `webUrl` is set, the card is dubbed an **Adaptive Card-based Loop Component** and, when pasted in Teams or other Loop Component-capable host applications, the URL will unfurl to the same exact card.
		*/
		webUrl;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new CardMetadata(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withWebUrl(webUrl) {
			this.webUrl = webUrl;
			return this;
		}
	};
	var Resources = class Resources {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* String resources that can provide translations in multiple languages. String resources make it possible to craft cards that are automatically localized according to the language settings of the application that displays the card.
		*/
		strings;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new Resources(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withStrings(strings) {
			this.strings = strings;
			return this;
		}
	};
	var StringResource = class StringResource {
		/**
		* Defines an optional key for the object. Keys are seldom needed, but in some scenarios, specifying keys can help maintain visual state in the host application.
		*/
		key;
		/**
		* The default value of the string, which is used when no matching localized value is found.
		*/
		defaultValue;
		/**
		* Localized values of the string, where keys represent the locale (e.g. `en-US`) in the `<ISO 639-1>(-<ISO 3166-1 alpha-2>)` format. `<ISO 639-1>` is the 2-letter language code and `<ISO 3166-1 alpha-2>` is the optional 2-letter country code.
		*/
		localizedValues;
		constructor(options = {}) {
			Object.assign(this, options);
		}
		static from(options) {
			return new StringResource(options);
		}
		withKey(key) {
			this.key = key;
			return this;
		}
		withDefaultValue(defaultValue) {
			this.defaultValue = defaultValue;
			return this;
		}
		withLocalizedValues(localizedValues) {
			this.localizedValues = localizedValues;
			return this;
		}
	};
	exports.ActionSet = ActionSet;
	exports.AdaptiveCard = AdaptiveCard;
	exports.AreaGridLayout = AreaGridLayout;
	exports.AuthCardButton = AuthCardButton;
	exports.Authentication = Authentication;
	exports.BackgroundImage = BackgroundImage;
	exports.Badge = Badge;
	exports.BarChartDataValue = BarChartDataValue;
	exports.CalendarEventAttendee = CalendarEventAttendee;
	exports.CalendarEventProperties = CalendarEventProperties;
	exports.CaptionSource = CaptionSource;
	exports.CardMetadata = CardMetadata;
	exports.Carousel = Carousel;
	exports.CarouselPage = CarouselPage;
	exports.Choice = Choice;
	exports.ChoiceSetInput = ChoiceSetInput;
	exports.CodeBlock = CodeBlock;
	exports.CollabStageInvokeDataValue = CollabStageInvokeDataValue;
	exports.Column = Column;
	exports.ColumnDefinition = ColumnDefinition;
	exports.ColumnSet = ColumnSet;
	exports.ComEventMicrosoftGraphComponent = ComEventMicrosoftGraphComponent;
	exports.ComFileMicrosoftGraphComponent = ComFileMicrosoftGraphComponent;
	exports.ComResourceMicrosoftGraphComponent = ComResourceMicrosoftGraphComponent;
	exports.ComUserMicrosoftGraphComponent = ComUserMicrosoftGraphComponent;
	exports.ComUsersMicrosoftGraphComponent = ComUsersMicrosoftGraphComponent;
	exports.CompoundButton = CompoundButton;
	exports.Container = Container;
	exports.DateInput = DateInput;
	exports.DonutChart = DonutChart;
	exports.DonutChartData = DonutChartData;
	exports.ExecuteAction = ExecuteAction;
	exports.Fact = Fact;
	exports.FactSet = FactSet;
	exports.FileProperties = FileProperties;
	exports.FlowLayout = FlowLayout;
	exports.GaugeChart = GaugeChart;
	exports.GaugeChartLegend = GaugeChartLegend;
	exports.GridArea = GridArea;
	exports.GroupedVerticalBarChart = GroupedVerticalBarChart;
	exports.GroupedVerticalBarChartData = GroupedVerticalBarChartData;
	exports.HorizontalBarChart = HorizontalBarChart;
	exports.HorizontalBarChartDataValue = HorizontalBarChartDataValue;
	exports.HostCapabilities = HostCapabilities;
	exports.Icon = Icon;
	exports.IconInfo = IconInfo;
	exports.IconRun = IconRun;
	exports.ImBackSubmitActionData = ImBackSubmitActionData;
	exports.Image = Image;
	exports.ImageRun = ImageRun;
	exports.ImageSet = ImageSet;
	exports.InsertImageAction = InsertImageAction;
	exports.InvokeSubmitActionData = InvokeSubmitActionData;
	exports.LineChart = LineChart;
	exports.LineChartData = LineChartData;
	exports.LineChartValue = LineChartValue;
	exports.Media = Media;
	exports.MediaSource = MediaSource;
	exports.Mention = Mention;
	exports.MentionedEntity = MentionedEntity;
	exports.MessageBackSubmitActionData = MessageBackSubmitActionData;
	exports.NumberInput = NumberInput;
	exports.OpenUrlAction = OpenUrlAction;
	exports.OpenUrlDialogAction = OpenUrlDialogAction;
	exports.PersonaProperties = PersonaProperties;
	exports.PersonaSetProperties = PersonaSetProperties;
	exports.PieChart = PieChart;
	exports.PopoverAction = PopoverAction;
	exports.ProgressBar = ProgressBar;
	exports.ProgressRing = ProgressRing;
	exports.QueryData = QueryData;
	exports.Rating = Rating;
	exports.RatingInput = RatingInput;
	exports.RefreshDefinition = RefreshDefinition;
	exports.ResetInputsAction = ResetInputsAction;
	exports.ResourceProperties = ResourceProperties;
	exports.ResourceVisualization = ResourceVisualization;
	exports.Resources = Resources;
	exports.RichTextBlock = RichTextBlock;
	exports.ShowCardAction = ShowCardAction;
	exports.SigninSubmitActionData = SigninSubmitActionData;
	exports.StackLayout = StackLayout;
	exports.StackedHorizontalBarChart = StackedHorizontalBarChart;
	exports.StackedHorizontalBarChartData = StackedHorizontalBarChartData;
	exports.StackedHorizontalBarChartDataPoint = StackedHorizontalBarChartDataPoint;
	exports.StringResource = StringResource;
	exports.SubmitAction = SubmitAction;
	exports.SubmitActionData = SubmitActionData;
	exports.TabInfo = TabInfo;
	exports.Table = Table;
	exports.TableCell = TableCell;
	exports.TableRow = TableRow;
	exports.TargetElement = TargetElement;
	exports.TaskFetchSubmitActionData = TaskFetchSubmitActionData;
	exports.TeamsCardProperties = TeamsCardProperties;
	exports.TeamsImageProperties = TeamsImageProperties;
	exports.TeamsSubmitActionFeedback = TeamsSubmitActionFeedback;
	exports.TeamsSubmitActionProperties = TeamsSubmitActionProperties;
	exports.TextBlock = TextBlock;
	exports.TextInput = TextInput;
	exports.TextRun = TextRun;
	exports.ThemedUrl = ThemedUrl;
	exports.TimeInput = TimeInput;
	exports.ToggleInput = ToggleInput;
	exports.ToggleVisibilityAction = ToggleVisibilityAction;
	exports.TokenExchangeResource = TokenExchangeResource;
	exports.VerticalBarChart = VerticalBarChart;
	exports.VerticalBarChartDataValue = VerticalBarChartDataValue;
	exports.isActionSet = isActionSet;
	exports.isAdaptiveCard = isAdaptiveCard;
	exports.isAreaGridLayout = isAreaGridLayout;
	exports.isBadge = isBadge;
	exports.isCarousel = isCarousel;
	exports.isCarouselPage = isCarouselPage;
	exports.isChoiceSetInput = isChoiceSetInput;
	exports.isCodeBlock = isCodeBlock;
	exports.isCollabStageInvokeDataValue = isCollabStageInvokeDataValue;
	exports.isColumn = isColumn;
	exports.isColumnSet = isColumnSet;
	exports.isComEventMicrosoftGraphComponent = isComEventMicrosoftGraphComponent;
	exports.isComFileMicrosoftGraphComponent = isComFileMicrosoftGraphComponent;
	exports.isComResourceMicrosoftGraphComponent = isComResourceMicrosoftGraphComponent;
	exports.isComUserMicrosoftGraphComponent = isComUserMicrosoftGraphComponent;
	exports.isComUsersMicrosoftGraphComponent = isComUsersMicrosoftGraphComponent;
	exports.isCompoundButton = isCompoundButton;
	exports.isContainer = isContainer;
	exports.isDateInput = isDateInput;
	exports.isDonutChart = isDonutChart;
	exports.isExecuteAction = isExecuteAction;
	exports.isFactSet = isFactSet;
	exports.isFlowLayout = isFlowLayout;
	exports.isGaugeChart = isGaugeChart;
	exports.isGroupedVerticalBarChart = isGroupedVerticalBarChart;
	exports.isHorizontalBarChart = isHorizontalBarChart;
	exports.isIcon = isIcon;
	exports.isIconRun = isIconRun;
	exports.isImBackSubmitActionData = isImBackSubmitActionData;
	exports.isImage = isImage;
	exports.isImageRun = isImageRun;
	exports.isImageSet = isImageSet;
	exports.isInsertImageAction = isInsertImageAction;
	exports.isInvokeSubmitActionData = isInvokeSubmitActionData;
	exports.isLineChart = isLineChart;
	exports.isMedia = isMedia;
	exports.isMention = isMention;
	exports.isMessageBackSubmitActionData = isMessageBackSubmitActionData;
	exports.isNumberInput = isNumberInput;
	exports.isOpenUrlAction = isOpenUrlAction;
	exports.isOpenUrlDialogAction = isOpenUrlDialogAction;
	exports.isPieChart = isPieChart;
	exports.isPopoverAction = isPopoverAction;
	exports.isProgressBar = isProgressBar;
	exports.isProgressRing = isProgressRing;
	exports.isQueryData = isQueryData;
	exports.isRating = isRating;
	exports.isRatingInput = isRatingInput;
	exports.isResetInputsAction = isResetInputsAction;
	exports.isRichTextBlock = isRichTextBlock;
	exports.isShowCardAction = isShowCardAction;
	exports.isSigninSubmitActionData = isSigninSubmitActionData;
	exports.isStackLayout = isStackLayout;
	exports.isStackedHorizontalBarChart = isStackedHorizontalBarChart;
	exports.isSubmitAction = isSubmitAction;
	exports.isTable = isTable;
	exports.isTableCell = isTableCell;
	exports.isTableRow = isTableRow;
	exports.isTaskFetchSubmitActionData = isTaskFetchSubmitActionData;
	exports.isTextBlock = isTextBlock;
	exports.isTextInput = isTextInput;
	exports.isTextRun = isTextRun;
	exports.isTimeInput = isTimeInput;
	exports.isToggleInput = isToggleInput;
	exports.isToggleVisibilityAction = isToggleVisibilityAction;
	exports.isVerticalBarChart = isVerticalBarChart;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/im-back.js
var require_im_back = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var IMBackAction = class IMBackAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(value, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = { msteams: new IMBackData(value) };
		}
		static from(options) {
			return new IMBackAction(options.data.msteams.value, options);
		}
		withData(value) {
			super.withData({ msteams: value });
			return this;
		}
		withValue(value) {
			this.data.msteams.value = value;
			return this;
		}
	};
	var IMBackData = class {
		type;
		/**
		* String that needs to be echoed back in the chat.
		*/
		value;
		constructor(value) {
			this.type = "imBack";
			this.value = value;
		}
	};
	exports.IMBackAction = IMBackAction;
	exports.IMBackData = IMBackData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/invoke.js
var require_invoke$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var InvokeAction = class InvokeAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(value, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = { msteams: new InvokeData(value) };
		}
		static from(options) {
			return new InvokeAction(options.data.msteams.value, options);
		}
		withData(value) {
			super.withData({ msteams: value });
			return this;
		}
		withValue(value) {
			this.data.msteams.value = value;
			return this;
		}
	};
	var InvokeData = class {
		type;
		/**
		* Set the value to send with the invoke
		*/
		value;
		constructor(value) {
			this.type = "invoke";
			this.value = value;
		}
	};
	exports.InvokeAction = InvokeAction;
	exports.InvokeData = InvokeData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/message-back.js
var require_message_back = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var MessageBackAction = class MessageBackAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(data, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = { msteams: new MessageBackData(data.text, data.value, data.displayText) };
		}
		static from(options) {
			return new MessageBackAction(options.data.msteams, options);
		}
		withData(value) {
			super.withData({ msteams: value });
			return this;
		}
	};
	var MessageBackData = class {
		type;
		/**
		* Sent to your bot when the action is performed.
		*/
		text;
		/**
		* Used by the user in the chat stream when the action is performed.
		* This text isn't sent to your bot.
		*/
		displayText;
		/**
		* Sent to your bot when the action is performed. You can encode context
		* for the action, such as unique identifiers or a `JSON` object.
		*/
		value;
		constructor(text, value, displayText) {
			this.type = "messageBack";
			this.text = text;
			this.value = value;
			this.displayText = displayText;
		}
		withDisplayText(value) {
			this.displayText = value;
			return this;
		}
	};
	exports.MessageBackAction = MessageBackAction;
	exports.MessageBackData = MessageBackData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/sign-in.js
var require_sign_in$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var SignInAction = class SignInAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(value, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = { msteams: new SignInData(value) };
		}
		static from(options) {
			return new SignInAction(options.data.msteams.value, options);
		}
		withData(value) {
			super.withData({ msteams: value });
			return this;
		}
		withValue(value) {
			this.data.msteams.value = value;
			return this;
		}
	};
	var SignInData = class {
		type;
		/**
		* Set to the `URL` where you want to redirect.
		*/
		value;
		constructor(value) {
			this.type = "signin";
			this.value = value;
		}
	};
	exports.SignInAction = SignInAction;
	exports.SignInData = SignInData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/task-fetch.js
var require_task_fetch$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var TaskFetchAction = class TaskFetchAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially ‘hidden’ properties.
		*/
		data;
		constructor(value, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = {
				...value,
				msteams: { type: "task/fetch" }
			};
		}
		static from(options) {
			return new TaskFetchAction(options.data, options);
		}
		withData(value) {
			this.data = value;
			return this;
		}
		withValue(value) {
			super.withData({
				...this.data,
				...value,
				msteams: { type: "task/fetch" }
			});
			return this;
		}
	};
	var TaskFetchData = class {
		msteams = { type: "task/fetch" };
		constructor(data) {
			if (data) {
				const { msteams, ...rest } = data;
				Object.assign(this, rest);
			}
		}
	};
	exports.TaskFetchAction = TaskFetchAction;
	exports.TaskFetchData = TaskFetchData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/collab-stage.js
var require_collab_stage = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	exports.CollabStageAction = class CollabStageAction extends core.SubmitAction {
		/**
		* Initial data that input fields will be combined with. These are essentially 'hidden' properties.
		*/
		data;
		constructor(tab, options = {}) {
			super(options);
			Object.assign(this, options);
			this.data = new core.SubmitActionData({ msteams: new core.InvokeSubmitActionData(tab ? new core.CollabStageInvokeDataValue({ tabInfo: tab }) : void 0) });
		}
		static from(options) {
			const value = options.data.msteams?.value;
			return new CollabStageAction(value?.tabInfo, options);
		}
		withData(value) {
			super.withData(new core.SubmitActionData({ msteams: value }));
			return this;
		}
		withValue(value) {
			const msteams = this.data.msteams;
			if (msteams) msteams.value = new core.CollabStageInvokeDataValue({ tabInfo: value });
			return this;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/submit/index.js
var require_submit = /* @__PURE__ */ __commonJSMin(((exports) => {
	var imBack = require_im_back();
	var invoke = require_invoke$1();
	var messageBack = require_message_back();
	var signIn = require_sign_in$1();
	var taskFetch = require_task_fetch$1();
	var collabStage = require_collab_stage();
	Object.keys(imBack).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return imBack[k];
			}
		});
	});
	Object.keys(invoke).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return invoke[k];
			}
		});
	});
	Object.keys(messageBack).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageBack[k];
			}
		});
	});
	Object.keys(signIn).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signIn[k];
			}
		});
	});
	Object.keys(taskFetch).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskFetch[k];
			}
		});
	});
	Object.keys(collabStage).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return collabStage[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/actions/index.js
var require_actions = /* @__PURE__ */ __commonJSMin(((exports) => {
	var submit = require_submit();
	Object.keys(submit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return submit[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/utilities/submit-data.js
var require_submit_data = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	const RESERVED_KEYWORD = "action";
	var SubmitData = class extends core.SubmitActionData {
		constructor(action, extraData) {
			super();
			if (extraData) Object.assign(this, extraData);
			this[RESERVED_KEYWORD] = action;
		}
	};
	exports.SubmitData = SubmitData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/utilities/open-dialog-data.js
var require_open_dialog_data = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	const RESERVED_KEYWORD = "dialog_id";
	var OpenDialogData = class extends core.SubmitActionData {
		constructor(dialogId, extraData) {
			super({ msteams: new core.TaskFetchSubmitActionData() });
			if (extraData) Object.assign(this, extraData);
			this[RESERVED_KEYWORD] = dialogId;
		}
	};
	exports.OpenDialogData = OpenDialogData;
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/utilities/index.js
var require_utilities = /* @__PURE__ */ __commonJSMin(((exports) => {
	var submitData = require_submit_data();
	var openDialogData = require_open_dialog_data();
	Object.keys(submitData).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return submitData[k];
			}
		});
	});
	Object.keys(openDialogData).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return openDialogData[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.cards/dist/index.js
var require_dist$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var core = require_core();
	var actions = require_actions();
	var utilities = require_utilities();
	Object.keys(core).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return core[k];
			}
		});
	});
	Object.keys(actions).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return actions[k];
			}
		});
	});
	Object.keys(utilities).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return utilities[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/utils/to-activity-params.js
var require_to_activity_params = /* @__PURE__ */ __commonJSMin(((exports) => {
	var teams_cards = require_dist$1();
	var message = require_message$1();
	function toActivityParams(activity) {
		if (typeof activity === "string") activity = {
			type: "message",
			text: activity
		};
		else if (teams_cards.isAdaptiveCard(activity)) activity = new message.MessageActivity().addCard("adaptive", activity);
		return activity;
	}
	exports.toActivityParams = toActivityParams;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/utils/index.js
var require_utils = /* @__PURE__ */ __commonJSMin(((exports) => {
	var stripMentionsText = require_strip_mentions_text();
	var toActivityParams = require_to_activity_params();
	Object.keys(stripMentionsText).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return stripMentionsText[k];
			}
		});
	});
	Object.keys(toActivityParams).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return toActivityParams[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/message.js
var require_message$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var models = require_models();
	var activity = require_activity();
	var utils = require_utils();
	exports.MessageActivity = class MessageActivity extends activity.Activity {
		/**
		* The text content of the message.
		*/
		text;
		/**
		* The text to speak.
		*/
		speak;
		/**
		* Indicates whether your bot is accepting,
		* expecting, or ignoring user input after the message is delivered to the client. Possible
		* values include: 'acceptingInput', 'ignoringInput', 'expectingInput'
		*/
		inputHint;
		/**
		* The text to display if the channel cannot render cards.
		*/
		summary;
		/**
		* Format of text fields Default:markdown. Possible values include: 'markdown', 'plain', 'xml'
		*/
		textFormat;
		/**
		* The layout hint for multiple attachments. Default: list. Possible values include: 'list',
		* 'carousel'
		*/
		attachmentLayout;
		/**
		* Attachments
		*/
		attachments;
		/**
		* The suggested actions for the activity.
		*/
		suggestedActions;
		/**
		* The importance of the activity. Possible values include: 'low', 'normal', 'high'
		*/
		importance;
		/**
		* A delivery hint to signal to the recipient alternate delivery paths for the activity.
		* The default delivery mode is "default". Possible values include: 'normal', 'notification'
		*/
		deliveryMode;
		/**
		* The time at which the activity should be considered to be "expired" and should not be
		* presented to the recipient.
		*/
		expiration;
		/**
		* A value that is associated with the activity.
		*/
		value;
		constructor(text = "", value = {}) {
			super({
				...value,
				type: "message"
			});
			Object.assign(this, {
				text,
				...value
			});
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new MessageActivity(activity.text, activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({
				stripMentionsText: this.stripMentionsText.bind(this),
				isRecipientMentioned: this.isRecipientMentioned.bind(this),
				getAccountMention: this.getAccountMention.bind(this)
			}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new MessageActivity(this.text, {
				...this.toInterface(),
				...options
			});
		}
		/**
		* The text content of the message.
		*/
		withText(value) {
			this.text = value;
			return this;
		}
		/**
		* The text to speak.
		*/
		withSpeak(value) {
			this.speak = value;
			return this;
		}
		/**
		* Indicates whether your bot is accepting,
		* expecting, or ignoring user input after the message is delivered to the client. Possible
		* values include: 'acceptingInput', 'ignoringInput', 'expectingInput'
		*/
		withInputHint(value) {
			this.inputHint = value;
			return this;
		}
		/**
		* The text to display if the channel cannot render cards.
		*/
		withSummary(value) {
			this.summary = value;
			return this;
		}
		/**
		* Format of text fields Default:markdown. Possible values include: 'markdown', 'plain', 'xml'
		*/
		withTextFormat(value) {
			this.textFormat = value;
			return this;
		}
		/**
		* The layout hint for multiple attachments. Default: list. Possible values include: 'list',
		* 'carousel'
		*/
		withAttachmentLayout(value) {
			this.attachmentLayout = value;
			return this;
		}
		/**
		* The suggested actions for the activity.
		*/
		withSuggestedActions(value) {
			this.suggestedActions = value;
			return this;
		}
		/**
		* The importance of the activity. Possible values include: 'low', 'normal', 'high'
		*/
		withImportance(value) {
			this.importance = value;
			return this;
		}
		/**
		* A delivery hint to signal to the recipient alternate delivery paths for the activity.
		* The default delivery mode is "default". Possible values include: 'normal', 'notification'
		*/
		withDeliveryMode(value) {
			this.deliveryMode = value;
			return this;
		}
		/**
		* The time at which the activity should be considered to be "expired" and should not be
		* presented to the recipient.
		*/
		withExpiration(value) {
			this.expiration = value;
			return this;
		}
		/**
		* Append text
		*/
		addText(text) {
			this.text += text;
			return this;
		}
		/**
		* Attachments
		*/
		addAttachments(...value) {
			if (!this.attachments) this.attachments = [];
			this.attachments.push(...value);
			return this;
		}
		/**
		* `@mention` an account
		* @param account the account to mention
		* @param options options to customize the mention
		*/
		addMention(account, options = {}) {
			const text = options.text || account.name;
			if (options.addText ?? true) this.addText(`<at>${text}</at>`);
			return this.addEntity({
				type: "mention",
				mentioned: account,
				text: `<at>${text}</at>`
			});
		}
		/**
		* Add a card attachment
		*/
		addCard(type, content) {
			return this.addAttachments(models.cardAttachment(type, content));
		}
		/**
		* remove "\<at>...\</at>" text from an activity
		*/
		stripMentionsText(options = {}) {
			this.text = utils.stripMentionsText(this, options);
			return this;
		}
		/**
		* is the recipient account mentioned
		*/
		isRecipientMentioned() {
			return (this.entities || []).filter((e) => e.type === "mention").some((e) => e.mentioned.id === this.recipient.id);
		}
		/**
		* get a mention by the account id if exists
		*/
		getAccountMention(accountId) {
			return (this.entities || []).filter((e) => e.type === "mention").find((e) => e.mentioned.id === accountId);
		}
		/**
		* Add stream info, making
		* this a final stream message
		*/
		addStreamFinal() {
			if (!this.channelData) this.channelData = {};
			this.channelData.streamId = this.id;
			this.channelData.streamType = "final";
			return this.addEntity({
				type: "streaminfo",
				streamId: this.id,
				streamType: "final"
			});
		}
		/**
		* Set the recipient of this message, optionally marking it as a targeted (ephemeral) message.
		* Targeted messages are only visible to the specified recipient in a shared conversation.
		* @param account - The recipient account
		* @param isTargeted - If true, marks this as a targeted message visible only to the recipient
		* @returns this instance for chaining
		*
		* @experimental This API is in preview and may change in the future.
		* Diagnostic: ExperimentalTeamsTargeted
		*/
		withRecipient(account, isTargeted = false) {
			super.withRecipient(account, isTargeted);
			return this;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/message-update.js
var require_message_update = /* @__PURE__ */ __commonJSMin(((exports) => {
	var activity = require_activity();
	exports.MessageUpdateActivity = class MessageUpdateActivity extends activity.Activity {
		/**
		* The text content of the message.
		*/
		text;
		/**
		* The text to speak.
		*/
		speak;
		/**
		* The text to display if the channel cannot render cards.
		*/
		summary;
		/**
		* The time at which the activity should be considered to be "expired" and should not be
		* presented to the recipient.
		*/
		expiration;
		/**
		* A value that is associated with the activity.
		*/
		value;
		constructor(eventType, value = {}) {
			super({
				...value,
				type: "messageUpdate",
				channelData: {
					...value?.channelData,
					eventType
				}
			});
			Object.assign(this, {
				...value,
				channelData: {
					...value?.channelData,
					eventType
				}
			});
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new MessageUpdateActivity(activity.channelData.eventType, activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new MessageUpdateActivity(this.channelData.eventType, {
				...this.toInterface(),
				...options
			});
		}
		/**
		* The text content of the message.
		*/
		withText(value) {
			this.text = value;
			return this;
		}
		/**
		* The text to speak.
		*/
		withSpeak(value) {
			this.speak = value;
			return this;
		}
		/**
		* The text to display if the channel cannot render cards.
		*/
		withSummary(value) {
			this.summary = value;
			return this;
		}
		/**
		* The time at which the activity should be considered to be "expired" and should not be
		* presented to the recipient.
		*/
		withExpiration(value) {
			this.expiration = value;
			return this;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/message-reaction.js
var require_message_reaction = /* @__PURE__ */ __commonJSMin(((exports) => {
	var activity = require_activity();
	exports.MessageReactionActivity = class MessageReactionActivity extends activity.Activity {
		/**
		* The collection of reactions added to the conversation.
		*/
		reactionsAdded;
		/**
		* The collection of reactions removed from the conversation.
		*/
		reactionsRemoved;
		constructor(value = {}) {
			super({
				...value,
				type: "messageReaction"
			});
			Object.assign(this, value);
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new MessageReactionActivity(activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new MessageReactionActivity({
				...this.toInterface(),
				...options
			});
		}
		/**
		* Add a message reaction.
		* @deprecated Use the api.reactions.add instead.
		*/
		addReaction(reaction) {
			if (!this.reactionsAdded) this.reactionsAdded = [];
			this.reactionsAdded.push(reaction);
			return this;
		}
		/**
		* Remove a message reaction.
		* @deprecated Use the api.reactions.remove instead.
		*/
		removeReaction(reaction) {
			if (!this.reactionsRemoved) this.reactionsRemoved = [];
			if (this.reactionsAdded) {
				const i = this.reactionsAdded.findIndex((r) => r.type === reaction.type && r.user?.id === reaction.user?.id);
				if (i > -1) this.reactionsAdded.splice(i, 1);
			}
			this.reactionsRemoved.push(reaction);
			return this;
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/message/index.js
var require_message$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var messageDelete = require_message_delete();
	var message = require_message$2();
	var messageUpdate = require_message_update();
	var messageReaction = require_message_reaction();
	Object.keys(messageDelete).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageDelete[k];
			}
		});
	});
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(messageUpdate).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageUpdate[k];
			}
		});
	});
	Object.keys(messageReaction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageReaction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/meeting-end.js
var require_meeting_end = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/meeting-participant-join.js
var require_meeting_participant_join = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/meeting-participant-leave.js
var require_meeting_participant_leave = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/meeting-start.js
var require_meeting_start = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/read-receipt.js
var require_read_receipt = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/event/index.js
var require_event = /* @__PURE__ */ __commonJSMin(((exports) => {
	var meetingEnd = require_meeting_end();
	var meetingParticipantJoin = require_meeting_participant_join();
	var meetingParticipantLeave = require_meeting_participant_leave();
	var meetingStart = require_meeting_start();
	var readReceipt = require_read_receipt();
	Object.keys(meetingEnd).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingEnd[k];
			}
		});
	});
	Object.keys(meetingParticipantJoin).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingParticipantJoin[k];
			}
		});
	});
	Object.keys(meetingParticipantLeave).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingParticipantLeave[k];
			}
		});
	});
	Object.keys(meetingStart).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return meetingStart[k];
			}
		});
	});
	Object.keys(readReceipt).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return readReceipt[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/file-consent.js
var require_file_consent = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/execute-action.js
var require_execute_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/anon-query-link.js
var require_anon_query_link = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/card-button-clicked.js
var require_card_button_clicked = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/fetch-task.js
var require_fetch_task$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/query.js
var require_query = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/query-link.js
var require_query_link = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/query-setting-url.js
var require_query_setting_url = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/select-item.js
var require_select_item = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/setting.js
var require_setting = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/submit-action.js
var require_submit_action$1 = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message-extension/index.js
var require_message_extension = /* @__PURE__ */ __commonJSMin(((exports) => {
	var anonQueryLink = require_anon_query_link();
	var cardButtonClicked = require_card_button_clicked();
	var fetchTask = require_fetch_task$1();
	var query = require_query();
	var queryLink = require_query_link();
	var querySettingUrl = require_query_setting_url();
	var selectItem = require_select_item();
	var setting = require_setting();
	var submitAction = require_submit_action$1();
	Object.keys(anonQueryLink).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return anonQueryLink[k];
			}
		});
	});
	Object.keys(cardButtonClicked).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cardButtonClicked[k];
			}
		});
	});
	Object.keys(fetchTask).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fetchTask[k];
			}
		});
	});
	Object.keys(query).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return query[k];
			}
		});
	});
	Object.keys(queryLink).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return queryLink[k];
			}
		});
	});
	Object.keys(querySettingUrl).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return querySettingUrl[k];
			}
		});
	});
	Object.keys(selectItem).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return selectItem[k];
			}
		});
	});
	Object.keys(setting).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return setting[k];
			}
		});
	});
	Object.keys(submitAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return submitAction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/config/config-fetch.js
var require_config_fetch = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/config/config-submit.js
var require_config_submit = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/config/index.js
var require_config = /* @__PURE__ */ __commonJSMin(((exports) => {
	var configFetch = require_config_fetch();
	var configSubmit = require_config_submit();
	Object.keys(configFetch).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return configFetch[k];
			}
		});
	});
	Object.keys(configSubmit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return configSubmit[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/tab/tab-fetch.js
var require_tab_fetch = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/tab/tab-submit.js
var require_tab_submit = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/tab/index.js
var require_tab = /* @__PURE__ */ __commonJSMin(((exports) => {
	var tabFetch = require_tab_fetch();
	var tabSubmit = require_tab_submit();
	Object.keys(tabFetch).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabFetch[k];
			}
		});
	});
	Object.keys(tabSubmit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tabSubmit[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/task/task-fetch.js
var require_task_fetch = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/task/task-submit.js
var require_task_submit = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/task/index.js
var require_task = /* @__PURE__ */ __commonJSMin(((exports) => {
	var taskFetch = require_task_fetch();
	var taskSubmit = require_task_submit();
	Object.keys(taskFetch).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskFetch[k];
			}
		});
	});
	Object.keys(taskSubmit).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return taskSubmit[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message/fetch-task.js
var require_fetch_task = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message/submit-action.js
var require_submit_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/message/index.js
var require_message = /* @__PURE__ */ __commonJSMin(((exports) => {
	var fetchTask = require_fetch_task();
	var submitAction = require_submit_action();
	Object.keys(fetchTask).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fetchTask[k];
			}
		});
	});
	Object.keys(submitAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return submitAction[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/handoff-action.js
var require_handoff_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/sign-in/failure.js
var require_failure = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/sign-in/token-exchange.js
var require_token_exchange = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/sign-in/verify-state.js
var require_verify_state = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/sign-in/index.js
var require_sign_in = /* @__PURE__ */ __commonJSMin(((exports) => {
	var failure = require_failure();
	var tokenExchange = require_token_exchange();
	var verifyState = require_verify_state();
	Object.keys(failure).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return failure[k];
			}
		});
	});
	Object.keys(tokenExchange).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tokenExchange[k];
			}
		});
	});
	Object.keys(verifyState).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return verifyState[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/adaptive-card/action.js
var require_action = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/adaptive-card/index.js
var require_adaptive_card = /* @__PURE__ */ __commonJSMin(((exports) => {
	var action = require_action();
	Object.keys(action).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return action[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/invoke/index.js
var require_invoke = /* @__PURE__ */ __commonJSMin(((exports) => {
	var fileConsent = require_file_consent();
	var executeAction = require_execute_action();
	var messageExtension = require_message_extension();
	var config = require_config();
	var tab = require_tab();
	var task = require_task();
	var message = require_message();
	var handoffAction = require_handoff_action();
	var signIn = require_sign_in();
	var adaptiveCard = require_adaptive_card();
	Object.keys(fileConsent).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return fileConsent[k];
			}
		});
	});
	Object.keys(executeAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return executeAction[k];
			}
		});
	});
	Object.keys(messageExtension).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return messageExtension[k];
			}
		});
	});
	Object.keys(config).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return config[k];
			}
		});
	});
	Object.keys(tab).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return tab[k];
			}
		});
	});
	Object.keys(task).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return task[k];
			}
		});
	});
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(handoffAction).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return handoffAction[k];
			}
		});
	});
	Object.keys(signIn).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return signIn[k];
			}
		});
	});
	Object.keys(adaptiveCard).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return adaptiveCard[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/trace.js
var require_trace = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/typing.js
var require_typing = /* @__PURE__ */ __commonJSMin(((exports) => {
	var activity = require_activity();
	exports.TypingActivity = class TypingActivity extends activity.Activity {
		/**
		* The text content of the message.
		*/
		text;
		constructor(value = {}) {
			super({
				type: "typing",
				...value
			});
			Object.assign(this, value);
		}
		/**
		* initialize from interface
		*/
		static from(activity) {
			return new TypingActivity(activity);
		}
		/**
		* convert to interface
		*/
		toInterface() {
			return Object.assign({}, this);
		}
		/**
		* copy to a new instance
		*/
		clone(options = {}) {
			return new TypingActivity({
				...this.toInterface(),
				...options
			});
		}
		/**
		* The text content of the message.
		*/
		withText(value) {
			this.text = value;
			return this;
		}
		/**
		* Append text
		*/
		addText(text) {
			if (!this.text) this.text = "";
			this.text += text;
			return this;
		}
		/**
		* Add stream informative update
		* @param id the stream id
		* @param sequence the sequence number (index) of the chunk
		*/
		addStreamUpdate(sequence = 0) {
			if (!this.channelData) this.channelData = {};
			if (!this.channelData.streamId) this.channelData.streamId = this.id;
			if (!this.channelData.streamType) this.channelData.streamType = "streaming";
			if (!this.channelData.streamSequence) this.channelData.streamSequence = sequence;
			return this.addEntity({
				type: "streaminfo",
				streamId: this.id,
				streamType: this.channelData.streamType,
				streamSequence: this.channelData.streamSequence
			});
		}
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/handoff.js
var require_handoff = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/conversation/conversation-update.js
var require_conversation_update = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/conversation/end-of-conversation.js
var require_end_of_conversation = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/conversation/index.js
var require_conversation = /* @__PURE__ */ __commonJSMin(((exports) => {
	var conversationUpdate = require_conversation_update();
	var endOfConversation = require_end_of_conversation();
	Object.keys(conversationUpdate).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversationUpdate[k];
			}
		});
	});
	Object.keys(endOfConversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return endOfConversation[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/command/command-result.js
var require_command_result = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/command/command-send.js
var require_command_send = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/command/index.js
var require_command = /* @__PURE__ */ __commonJSMin(((exports) => {
	var commandResult = require_command_result();
	var commandSend = require_command_send();
	Object.keys(commandResult).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return commandResult[k];
			}
		});
	});
	Object.keys(commandSend).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return commandSend[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/install-update/add.js
var require_add = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/install-update/remove.js
var require_remove = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/install-update/index.js
var require_install_update = /* @__PURE__ */ __commonJSMin(((exports) => {
	var add = require_add();
	var remove = require_remove();
	Object.keys(add).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return add[k];
			}
		});
	});
	Object.keys(remove).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return remove[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/activities/index.js
var require_activities = /* @__PURE__ */ __commonJSMin(((exports) => {
	var message = require_message$1();
	var event = require_event();
	var invoke = require_invoke();
	var trace = require_trace();
	var typing = require_typing();
	var handoff = require_handoff();
	var conversation = require_conversation();
	var command = require_command();
	var installUpdate = require_install_update();
	var utils = require_utils();
	var activity = require_activity();
	Object.defineProperty(exports, "$Activity", {
		enumerable: true,
		get: function() {
			return activity.Activity;
		}
	});
	Object.keys(message).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return message[k];
			}
		});
	});
	Object.keys(event).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return event[k];
			}
		});
	});
	Object.keys(invoke).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return invoke[k];
			}
		});
	});
	Object.keys(trace).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return trace[k];
			}
		});
	});
	Object.keys(typing).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return typing[k];
			}
		});
	});
	Object.keys(handoff).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return handoff[k];
			}
		});
	});
	Object.keys(conversation).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return conversation[k];
			}
		});
	});
	Object.keys(command).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return command[k];
			}
		});
	});
	Object.keys(installUpdate).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return installUpdate[k];
			}
		});
	});
	Object.keys(utils).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return utils[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/token.js
var require_token = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/jwt-decode/build/cjs/index.js
var require_cjs = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.jwtDecode = exports.InvalidTokenError = void 0;
	var InvalidTokenError = class extends Error {};
	exports.InvalidTokenError = InvalidTokenError;
	InvalidTokenError.prototype.name = "InvalidTokenError";
	function b64DecodeUnicode(str) {
		return decodeURIComponent(atob(str).replace(/(.)/g, (m, p) => {
			let code = p.charCodeAt(0).toString(16).toUpperCase();
			if (code.length < 2) code = "0" + code;
			return "%" + code;
		}));
	}
	function base64UrlDecode(str) {
		let output = str.replace(/-/g, "+").replace(/_/g, "/");
		switch (output.length % 4) {
			case 0: break;
			case 2:
				output += "==";
				break;
			case 3:
				output += "=";
				break;
			default: throw new Error("base64 string is not of the correct length");
		}
		try {
			return b64DecodeUnicode(output);
		} catch (err) {
			return atob(output);
		}
	}
	function jwtDecode(token, options) {
		if (typeof token !== "string") throw new InvalidTokenError("Invalid token specified: must be a string");
		options || (options = {});
		const pos = options.header === true ? 0 : 1;
		const part = token.split(".")[pos];
		if (typeof part !== "string") throw new InvalidTokenError(`Invalid token specified: missing part #${pos + 1}`);
		let decoded;
		try {
			decoded = base64UrlDecode(part);
		} catch (e) {
			throw new InvalidTokenError(`Invalid token specified: invalid base64 for part #${pos + 1} (${e.message})`);
		}
		try {
			return JSON.parse(decoded);
		} catch (e) {
			throw new InvalidTokenError(`Invalid token specified: invalid json for part #${pos + 1} (${e.message})`);
		}
	}
	exports.jwtDecode = jwtDecode;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/caller.js
var require_caller = /* @__PURE__ */ __commonJSMin(((exports) => {
	exports.CallerIds = {
		azure: "urn:botframework:azure",
		gov: "urn:botframework:azureusgov",
		bot: "urn:botframework:aadappid"
	};
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/json-web-token.js
var require_json_web_token = /* @__PURE__ */ __commonJSMin(((exports) => {
	var jwtDecode = require_cjs();
	var caller = require_caller();
	var JsonWebToken = class {
		get audience() {
			return this._payload.aud;
		}
		get issuer() {
			return this._payload.iss;
		}
		get keyId() {
			return this._payload["kid"];
		}
		get appId() {
			return this._payload["appid"];
		}
		get appDisplayName() {
			return this._payload["app_displayname"];
		}
		get tenantId() {
			return this._payload["tid"];
		}
		get version() {
			return this._payload["version"];
		}
		get serviceUrl() {
			let v = this._payload["serviceurl"] || "https://smba.trafficmanager.net/teams";
			if (v.endsWith("/")) v = v.slice(0, v.length - 1);
			return v;
		}
		get from() {
			if (this.appId) return "bot";
			return "azure";
		}
		get fromId() {
			if (this.from === "bot") return `${caller.CallerIds.bot}:${this.appId}`;
			return caller.CallerIds.azure;
		}
		get expiration() {
			if (this._payload.exp) return this._payload.exp * 1e3;
		}
		_value;
		_payload;
		constructor(value) {
			this._value = value;
			this._payload = jwtDecode.jwtDecode(value);
		}
		isExpired(bufferMs = 1e3 * 60 * 5) {
			if (!this.expiration) return false;
			return this.expiration < Date.now() + bufferMs;
		}
		toString() {
			return this._value;
		}
	};
	exports.JsonWebToken = JsonWebToken;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/credentials.js
var require_credentials = /* @__PURE__ */ __commonJSMin((() => {}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/cloud-environment.js
var require_cloud_environment = /* @__PURE__ */ __commonJSMin(((exports) => {
	const PUBLIC = Object.freeze({
		loginEndpoint: "https://login.microsoftonline.com",
		loginTenant: "botframework.com",
		botScope: "https://api.botframework.com/.default",
		tokenServiceUrl: "https://token.botframework.com",
		openIdMetadataUrl: "https://login.botframework.com/v1/.well-known/openidconfiguration",
		tokenIssuer: "https://api.botframework.com",
		graphScope: "https://graph.microsoft.com/.default"
	});
	const US_GOV = Object.freeze({
		loginEndpoint: "https://login.microsoftonline.us",
		loginTenant: "MicrosoftServices.onmicrosoft.us",
		botScope: "https://api.botframework.us/.default",
		tokenServiceUrl: "https://tokengcch.botframework.azure.us",
		openIdMetadataUrl: "https://login.botframework.azure.us/v1/.well-known/openidconfiguration",
		tokenIssuer: "https://api.botframework.us",
		graphScope: "https://graph.microsoft.us/.default"
	});
	const US_GOV_DOD = Object.freeze({
		loginEndpoint: "https://login.microsoftonline.us",
		loginTenant: "MicrosoftServices.onmicrosoft.us",
		botScope: "https://api.botframework.us/.default",
		tokenServiceUrl: "https://apiDoD.botframework.azure.us",
		openIdMetadataUrl: "https://login.botframework.azure.us/v1/.well-known/openidconfiguration",
		tokenIssuer: "https://api.botframework.us",
		graphScope: "https://dod-graph.microsoft.us/.default"
	});
	const CHINA = Object.freeze({
		loginEndpoint: "https://login.partner.microsoftonline.cn",
		loginTenant: "microsoftservices.partner.onmschina.cn",
		botScope: "https://api.botframework.azure.cn/.default",
		tokenServiceUrl: "https://token.botframework.azure.cn",
		openIdMetadataUrl: "https://login.botframework.azure.cn/v1/.well-known/openidconfiguration",
		tokenIssuer: "https://api.botframework.azure.cn",
		graphScope: "https://microsoftgraph.chinacloudapi.cn/.default"
	});
	function withOverrides(base, overrides) {
		return Object.freeze({
			loginEndpoint: overrides.loginEndpoint ?? base.loginEndpoint,
			loginTenant: overrides.loginTenant ?? base.loginTenant,
			botScope: overrides.botScope ?? base.botScope,
			tokenServiceUrl: overrides.tokenServiceUrl ?? base.tokenServiceUrl,
			openIdMetadataUrl: overrides.openIdMetadataUrl ?? base.openIdMetadataUrl,
			tokenIssuer: overrides.tokenIssuer ?? base.tokenIssuer,
			graphScope: overrides.graphScope ?? base.graphScope
		});
	}
	const CLOUD_ENVIRONMENTS = {
		public: PUBLIC,
		usgov: US_GOV,
		usgovdod: US_GOV_DOD,
		china: CHINA
	};
	function cloudFromName(name) {
		const env = CLOUD_ENVIRONMENTS[name.toLowerCase()];
		if (!env) throw new Error(`Unknown cloud environment: '${name}'. Valid values are: Public, USGov, USGovDoD, China.`);
		return env;
	}
	exports.CHINA = CHINA;
	exports.PUBLIC = PUBLIC;
	exports.US_GOV = US_GOV;
	exports.US_GOV_DOD = US_GOV_DOD;
	exports.cloudFromName = cloudFromName;
	exports.withOverrides = withOverrides;
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/auth/index.js
var require_auth = /* @__PURE__ */ __commonJSMin(((exports) => {
	var token = require_token();
	var jsonWebToken = require_json_web_token();
	var credentials = require_credentials();
	var cloudEnvironment = require_cloud_environment();
	Object.keys(token).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return token[k];
			}
		});
	});
	Object.keys(jsonWebToken).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return jsonWebToken[k];
			}
		});
	});
	Object.keys(credentials).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return credentials[k];
			}
		});
	});
	Object.keys(cloudEnvironment).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return cloudEnvironment[k];
			}
		});
	});
}));
//#endregion
//#region node_modules/@microsoft/teams.api/dist/index.js
var require_dist = /* @__PURE__ */ __commonJSMin(((exports) => {
	var clients = require_clients();
	var models = require_models();
	var activities = require_activities();
	var auth = require_auth();
	Object.keys(clients).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return clients[k];
			}
		});
	});
	Object.keys(models).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return models[k];
			}
		});
	});
	Object.keys(activities).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return activities[k];
			}
		});
	});
	Object.keys(auth).forEach(function(k) {
		if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports, k)) Object.defineProperty(exports, k, {
			enumerable: true,
			get: function() {
				return auth[k];
			}
		});
	});
}));
//#endregion
export { require_http as n, require_logging as r, require_dist as t };

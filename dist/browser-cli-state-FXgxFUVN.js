import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as inheritOptionFromParent } from "./command-options-Dhjl7AMa.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as danger } from "./globals-YU5FjfZK.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as runCommandWithRuntime } from "./cli-utils-CdDa8OYO.js";
import { l as parseBooleanValue } from "./config-F211Ihcd.js";
import "./core-api-CznnLkt_.js";
import "./core-api-B5Vt3O83.js";
import { t as callBrowserRequest } from "./browser-cli-shared-BiWbz8Jo.js";
import { t as runBrowserResizeWithOutput } from "./browser-cli-resize-CBJCO8s9.js";
//#region extensions/browser/src/cli/browser-cli-state.cookies-storage.ts
function resolveUrl(opts, command) {
	return normalizeOptionalString(opts.url) ?? normalizeOptionalString(inheritOptionFromParent(command, "url"));
}
function resolveTargetId(rawTargetId, command) {
	return normalizeOptionalString(rawTargetId) ?? normalizeOptionalString(inheritOptionFromParent(command, "targetId"));
}
async function runMutationRequest(params) {
	try {
		const result = await callBrowserRequest(params.parent, params.request, { timeoutMs: 2e4 });
		if (params.parent?.json) {
			defaultRuntime.writeJson(result);
			return;
		}
		defaultRuntime.log(params.successMessage);
	} catch (err) {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	}
}
function registerBrowserCookiesAndStorageCommands(browser, parentOpts) {
	const cookies = browser.command("cookies").description("Read/write cookies");
	cookies.option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		const targetId = resolveTargetId(opts.targetId, cmd);
		try {
			const result = await callBrowserRequest(parent, {
				method: "GET",
				path: "/cookies",
				query: {
					targetId,
					profile
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			defaultRuntime.writeJson(result.cookies ?? []);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	cookies.command("set").description("Set a cookie (requires --url or domain+path)").argument("<name>", "Cookie name").argument("<value>", "Cookie value").option("--url <url>", "Cookie URL scope (recommended)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (name, value, opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		const targetId = resolveTargetId(opts.targetId, cmd);
		const url = resolveUrl(opts, cmd);
		if (!url) {
			defaultRuntime.error(danger("Missing required --url option for cookies set"));
			defaultRuntime.exit(1);
			return;
		}
		await runMutationRequest({
			parent,
			request: {
				method: "POST",
				path: "/cookies/set",
				query: profile ? { profile } : void 0,
				body: {
					targetId,
					cookie: {
						name,
						value,
						url
					}
				}
			},
			successMessage: `cookie set: ${name}`
		});
	});
	cookies.command("clear").description("Clear all cookies").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		const targetId = resolveTargetId(opts.targetId, cmd);
		await runMutationRequest({
			parent,
			request: {
				method: "POST",
				path: "/cookies/clear",
				query: profile ? { profile } : void 0,
				body: { targetId }
			},
			successMessage: "cookies cleared"
		});
	});
	const storage = browser.command("storage").description("Read/write localStorage/sessionStorage");
	function registerStorageKind(kind) {
		const cmd = storage.command(kind).description(`${kind}Storage commands`);
		cmd.command("get").description(`Get ${kind}Storage (all keys or one key)`).argument("[key]", "Key (optional)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (key, opts, cmd2) => {
			const parent = parentOpts(cmd2);
			const profile = parent?.browserProfile;
			const targetId = resolveTargetId(opts.targetId, cmd2);
			try {
				const result = await callBrowserRequest(parent, {
					method: "GET",
					path: `/storage/${kind}`,
					query: {
						key: normalizeOptionalString(key),
						targetId,
						profile
					}
				}, { timeoutMs: 2e4 });
				if (parent?.json) {
					defaultRuntime.writeJson(result);
					return;
				}
				defaultRuntime.writeJson(result.values ?? {});
			} catch (err) {
				defaultRuntime.error(danger(String(err)));
				defaultRuntime.exit(1);
			}
		});
		cmd.command("set").description(`Set a ${kind}Storage key`).argument("<key>", "Key").argument("<value>", "Value").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (key, value, opts, cmd2) => {
			const parent = parentOpts(cmd2);
			const profile = parent?.browserProfile;
			const targetId = resolveTargetId(opts.targetId, cmd2);
			await runMutationRequest({
				parent,
				request: {
					method: "POST",
					path: `/storage/${kind}/set`,
					query: profile ? { profile } : void 0,
					body: {
						key,
						value,
						targetId
					}
				},
				successMessage: `${kind}Storage set: ${key}`
			});
		});
		cmd.command("clear").description(`Clear all ${kind}Storage keys`).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (opts, cmd2) => {
			const parent = parentOpts(cmd2);
			const profile = parent?.browserProfile;
			const targetId = resolveTargetId(opts.targetId, cmd2);
			await runMutationRequest({
				parent,
				request: {
					method: "POST",
					path: `/storage/${kind}/clear`,
					query: profile ? { profile } : void 0,
					body: { targetId }
				},
				successMessage: `${kind}Storage cleared`
			});
		});
	}
	registerStorageKind("local");
	registerStorageKind("session");
}
//#endregion
//#region extensions/browser/src/cli/browser-cli-state.ts
function parseOnOff(raw) {
	const parsed = parseBooleanValue(raw);
	return parsed === void 0 ? null : parsed;
}
function runBrowserCommand(action) {
	return runCommandWithRuntime(defaultRuntime, action, (err) => {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	});
}
async function runBrowserSetRequest(params) {
	await runBrowserCommand(async () => {
		const profile = params.parent?.browserProfile;
		const result = await callBrowserRequest(params.parent, {
			method: "POST",
			path: params.path,
			query: profile ? { profile } : void 0,
			body: params.body
		}, { timeoutMs: 2e4 });
		if (params.parent?.json) {
			defaultRuntime.writeJson(result);
			return;
		}
		defaultRuntime.log(params.successMessage);
	});
}
function registerBrowserStateCommands(browser, parentOpts) {
	registerBrowserCookiesAndStorageCommands(browser, parentOpts);
	const set = browser.command("set").description("Browser environment settings");
	set.command("viewport").description("Set viewport size (alias for resize)").argument("<width>", "Viewport width", (v) => Number(v)).argument("<height>", "Viewport height", (v) => Number(v)).option("--target-id <id>", "CDP target id (or unique prefix)").action(async (width, height, opts, cmd) => {
		const parent = parentOpts(cmd);
		const profile = parent?.browserProfile;
		await runBrowserCommand(async () => {
			await runBrowserResizeWithOutput({
				parent,
				profile,
				width,
				height,
				targetId: opts.targetId,
				timeoutMs: 2e4,
				successMessage: `viewport set: ${width}x${height}`
			});
		});
	});
	set.command("offline").description("Toggle offline mode").argument("<on|off>", "on/off").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (value, opts, cmd) => {
		const parent = parentOpts(cmd);
		const offline = parseOnOff(value);
		if (offline === null) {
			defaultRuntime.error(danger("Expected on|off"));
			defaultRuntime.exit(1);
			return;
		}
		await runBrowserSetRequest({
			parent,
			path: "/set/offline",
			body: {
				offline,
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `offline: ${offline}`
		});
	});
	set.command("headers").description("Set extra HTTP headers (JSON object)").argument("[headersJson]", "JSON object of headers (alternative to --headers-json)").option("--headers-json <json>", "JSON object of headers").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (headersJson, opts, cmd) => {
		const parent = parentOpts(cmd);
		await runBrowserCommand(async () => {
			const headersJsonValue = normalizeOptionalString(opts.headersJson) ?? normalizeOptionalString(headersJson);
			if (!headersJsonValue) throw new Error("Missing headers JSON (pass --headers-json or positional JSON argument)");
			const parsed = JSON.parse(headersJsonValue);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Headers JSON must be a JSON object");
			const headers = {};
			for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") headers[k] = v;
			const profile = parent?.browserProfile;
			const result = await callBrowserRequest(parent, {
				method: "POST",
				path: "/set/headers",
				query: profile ? { profile } : void 0,
				body: {
					headers,
					targetId: normalizeOptionalString(opts.targetId)
				}
			}, { timeoutMs: 2e4 });
			if (parent?.json) {
				defaultRuntime.writeJson(result);
				return;
			}
			defaultRuntime.log("headers set");
		});
	});
	set.command("credentials").description("Set HTTP basic auth credentials").option("--clear", "Clear credentials", false).argument("[username]", "Username").argument("[password]", "Password").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (username, password, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/credentials",
			body: {
				username: normalizeOptionalString(username),
				password,
				clear: Boolean(opts.clear),
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: opts.clear ? "credentials cleared" : "credentials set"
		});
	});
	set.command("geo").description("Set geolocation (and grant permission)").option("--clear", "Clear geolocation + permissions", false).argument("[latitude]", "Latitude", (v) => Number(v)).argument("[longitude]", "Longitude", (v) => Number(v)).option("--accuracy <m>", "Accuracy in meters", (v) => Number(v)).option("--origin <origin>", "Origin to grant permissions for").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (latitude, longitude, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/geolocation",
			body: {
				latitude: Number.isFinite(latitude) ? latitude : void 0,
				longitude: Number.isFinite(longitude) ? longitude : void 0,
				accuracy: Number.isFinite(opts.accuracy) ? opts.accuracy : void 0,
				origin: normalizeOptionalString(opts.origin),
				clear: Boolean(opts.clear),
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: opts.clear ? "geolocation cleared" : "geolocation set"
		});
	});
	set.command("media").description("Emulate prefers-color-scheme").argument("<dark|light|none>", "dark/light/none").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (value, opts, cmd) => {
		const parent = parentOpts(cmd);
		const v = normalizeOptionalLowercaseString(value);
		const colorScheme = v === "dark" ? "dark" : v === "light" ? "light" : v === "none" ? "none" : null;
		if (!colorScheme) {
			defaultRuntime.error(danger("Expected dark|light|none"));
			defaultRuntime.exit(1);
			return;
		}
		await runBrowserSetRequest({
			parent,
			path: "/set/media",
			body: {
				colorScheme,
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `media colorScheme: ${colorScheme}`
		});
	});
	set.command("timezone").description("Override timezone (CDP)").argument("<timezoneId>", "Timezone ID (e.g. America/New_York)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (timezoneId, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/timezone",
			body: {
				timezoneId,
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `timezone: ${timezoneId}`
		});
	});
	set.command("locale").description("Override locale (CDP)").argument("<locale>", "Locale (e.g. en-US)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (locale, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/locale",
			body: {
				locale,
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `locale: ${locale}`
		});
	});
	set.command("device").description("Apply a Playwright device descriptor (e.g. \"iPhone 14\")").argument("<name>", "Device name (Playwright devices)").option("--target-id <id>", "CDP target id (or unique prefix)").action(async (name, opts, cmd) => {
		await runBrowserSetRequest({
			parent: parentOpts(cmd),
			path: "/set/device",
			body: {
				name,
				targetId: normalizeOptionalString(opts.targetId)
			},
			successMessage: `device: ${name}`
		});
	});
}
//#endregion
export { registerBrowserStateCommands };

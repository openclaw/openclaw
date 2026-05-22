import { x as isPlainObject } from "./utils-D5swhEXt.js";
//#region src/config/env-substitution.ts
/**
* Environment variable substitution for config values.
*
* Supports `${VAR_NAME}` syntax in string values, substituted at config load time.
* - Only uppercase env vars are matched: `[A-Z_][A-Z0-9_]*`
* - Escape with `$${}` to output literal `${}`
* - Missing env vars throw `MissingEnvVarError` with context
*
* @example
* ```json5
* {
*   models: {
*     providers: {
*       "vercel-gateway": {
*         apiKey: "${VERCEL_GATEWAY_API_KEY}"
*       }
*     }
*   }
* }
* ```
*/
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
var MissingEnvVarError = class extends Error {
	constructor(varName, configPath) {
		super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
		this.varName = varName;
		this.configPath = configPath;
		this.name = "MissingEnvVarError";
	}
};
function parseEnvTokenAt(value, index) {
	if (value[index] !== "$") return null;
	const next = value[index + 1];
	const afterNext = value[index + 2];
	if (next === "$" && afterNext === "{") {
		const start = index + 3;
		const end = value.indexOf("}", start);
		if (end !== -1) {
			const name = value.slice(start, end);
			if (ENV_VAR_NAME_PATTERN.test(name)) return {
				kind: "escaped",
				name,
				end
			};
		}
	}
	if (next === "{") {
		const start = index + 2;
		const end = value.indexOf("}", start);
		if (end !== -1) {
			const name = value.slice(start, end);
			if (ENV_VAR_NAME_PATTERN.test(name)) return {
				kind: "substitution",
				name,
				end
			};
		}
	}
	return null;
}
function substituteString(value, env, configPath, opts) {
	if (!value.includes("$")) return value;
	const chunks = [];
	for (let i = 0; i < value.length; i += 1) {
		const char = value[i];
		if (char !== "$") {
			chunks.push(char);
			continue;
		}
		const token = parseEnvTokenAt(value, i);
		if (token?.kind === "escaped") {
			chunks.push(`\${${token.name}}`);
			i = token.end;
			continue;
		}
		if (token?.kind === "substitution") {
			const envValue = env[token.name];
			if (envValue === void 0 || envValue === "") {
				if (opts?.onMissing) {
					opts.onMissing({
						varName: token.name,
						configPath
					});
					chunks.push(`\${${token.name}}`);
					i = token.end;
					continue;
				}
				throw new MissingEnvVarError(token.name, configPath);
			}
			chunks.push(envValue);
			i = token.end;
			continue;
		}
		chunks.push(char);
	}
	return chunks.join("");
}
function containsEnvVarReference(value) {
	if (!value.includes("$")) return false;
	for (let i = 0; i < value.length; i += 1) {
		if (value[i] !== "$") continue;
		const token = parseEnvTokenAt(value, i);
		if (token?.kind === "escaped") {
			i = token.end;
			continue;
		}
		if (token?.kind === "substitution") return true;
	}
	return false;
}
function substituteAny(value, env, path, opts) {
	if (typeof value === "string") return substituteString(value, env, path, opts);
	if (Array.isArray(value)) return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`, opts));
	if (isPlainObject(value)) {
		const result = {};
		for (const [key, val] of Object.entries(value)) result[key] = substituteAny(val, env, path ? `${path}.${key}` : key, opts);
		return result;
	}
	return value;
}
/**
* Resolves `${VAR_NAME}` environment variable references in config values.
*
* @param obj - The parsed config object (after JSON5 parse and $include resolution)
* @param env - Environment variables to use for substitution (defaults to process.env)
* @param opts - Options: `onMissing` callback to collect warnings instead of throwing.
* @returns The config object with env vars substituted
* @throws {MissingEnvVarError} If a referenced env var is not set or empty (unless `onMissing` is set)
*/
function resolveConfigEnvVars(obj, env = process.env, opts) {
	return substituteAny(obj, env, "", opts);
}
//#endregion
export { containsEnvVarReference as n, resolveConfigEnvVars as r, MissingEnvVarError as t };

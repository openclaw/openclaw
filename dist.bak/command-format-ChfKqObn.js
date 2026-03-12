import path from "node:path";

//#region src/cli/cli-name.ts
const DEFAULT_CLI_NAME = "openclaw";
const KNOWN_CLI_NAMES = new Set([DEFAULT_CLI_NAME]);
const CLI_PREFIX_RE$1 = /^(?:((?:pnpm|npm|bunx|npx)\s+))?(openclaw)\b/;
function resolveCliName(argv = process.argv) {
	const argv1 = argv[1];
	if (!argv1) return DEFAULT_CLI_NAME;
	const base = path.basename(argv1).trim();
	if (KNOWN_CLI_NAMES.has(base)) return base;
	return DEFAULT_CLI_NAME;
}
function replaceCliName(command, cliName = resolveCliName()) {
	if (!command.trim()) return command;
	if (!CLI_PREFIX_RE$1.test(command)) return command;
	return command.replace(CLI_PREFIX_RE$1, (_match, runner) => {
		return `${runner ?? ""}${cliName}`;
	});
}

//#endregion
//#region src/cli/profile-utils.ts
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
function isValidProfileName(value) {
	if (!value) return false;
	return PROFILE_NAME_RE.test(value);
}
function normalizeProfileName(raw) {
	const profile = raw?.trim();
	if (!profile) return null;
	if (profile.toLowerCase() === "default") return null;
	if (!isValidProfileName(profile)) return null;
	return profile;
}

//#endregion
//#region src/cli/command-format.ts
const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b|^openclaw\b/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;
function formatCliCommand(command, env = process.env) {
	const normalizedCommand = replaceCliName(command, resolveCliName());
	const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
	if (!profile) return normalizedCommand;
	if (!CLI_PREFIX_RE.test(normalizedCommand)) return normalizedCommand;
	if (PROFILE_FLAG_RE.test(normalizedCommand) || DEV_FLAG_RE.test(normalizedCommand)) return normalizedCommand;
	return normalizedCommand.replace(CLI_PREFIX_RE, (match) => `${match} --profile ${profile}`);
}

//#endregion
export { replaceCliName as n, resolveCliName as r, formatCliCommand as t };
import { n as normalizeProfileName } from "./profile-utils-7b3ZHGpe.js";
import { n as resolveCliName, t as replaceCliName } from "./cli-name-DM57t00s.js";
//#region src/cli/command-format.ts
const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b|^openclaw\b/;
const CONTAINER_FLAG_RE = /(?:^|\s)--container(?:\s|=|$)/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;
const UPDATE_COMMAND_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b.*(?:^|\s)update(?:\s|$)|^openclaw\b.*(?:^|\s)update(?:\s|$)/;
const CONTAINER_HINT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
function formatCliCommand(command, env = process.env) {
	const normalizedCommand = replaceCliName(command, resolveCliName());
	const rawContainer = env.OPENCLAW_CONTAINER_HINT?.trim();
	const container = rawContainer && CONTAINER_HINT_RE.test(rawContainer) ? rawContainer : void 0;
	const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
	if (!container && !profile) return normalizedCommand;
	if (!CLI_PREFIX_RE.test(normalizedCommand)) return normalizedCommand;
	const additions = [];
	if (container && !CONTAINER_FLAG_RE.test(normalizedCommand) && !UPDATE_COMMAND_RE.test(normalizedCommand)) additions.push(`--container ${container}`);
	if (!container && profile && !PROFILE_FLAG_RE.test(normalizedCommand) && !DEV_FLAG_RE.test(normalizedCommand)) additions.push(`--profile ${profile}`);
	if (additions.length === 0) return normalizedCommand;
	return normalizedCommand.replace(CLI_PREFIX_RE, (match) => `${match} ${additions.join(" ")}`);
}
//#endregion
export { formatCliCommand as t };

import { n as normalizeProfileName } from "./profile-utils-DxxxMjB_.js";
import { n as resolveCliName, t as replaceCliName } from "./cli-name-C9PM6wRj.js";
//#region src/cli/command-format.ts
const CLI_PREFIX_RE = /^(?:pnpm|npm|bunx|npx)\s+openclaw\b|^openclaw\b/;
const PROFILE_FLAG_RE = /(?:^|\s)--profile(?:\s|=|$)/;
const DEV_FLAG_RE = /(?:^|\s)--dev(?:\s|$)/;
function formatCliCommand(command, env = process.env) {
	const normalizedCommand = replaceCliName(command, resolveCliName());
	const profile = normalizeProfileName(env.OPENCLAW_PROFILE);
	if (!profile) {return normalizedCommand;}
	if (!CLI_PREFIX_RE.test(normalizedCommand)) {return normalizedCommand;}
	if (PROFILE_FLAG_RE.test(normalizedCommand) || DEV_FLAG_RE.test(normalizedCommand)) {return normalizedCommand;}
	return normalizedCommand.replace(CLI_PREFIX_RE, (match) => `${match} --profile ${profile}`);
}
//#endregion
export { formatCliCommand as t };

import { t as formatCliCommand } from "./command-format-ut6bcRZg.js";
//#region src/pairing/pairing-messages.ts
function buildPairingReply(params) {
	const { channel, idLine, code } = params;
	const approveCommand = formatCliCommand(`openclaw pairing approve ${channel} ${code}`);
	return [
		"OpenClaw: access not configured.",
		"",
		idLine,
		"Pairing code:",
		"```",
		code,
		"```",
		"",
		"Ask the bot owner to approve with:",
		formatCliCommand(`openclaw pairing approve ${channel} ${code}`),
		"```",
		approveCommand,
		"```"
	].join("\n");
}
//#endregion
export { buildPairingReply as t };

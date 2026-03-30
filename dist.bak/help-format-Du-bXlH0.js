import { Ot as theme } from "./entry.js";

//#region src/cli/help-format.ts
function formatHelpExample(command, description) {
	return `  ${theme.command(command)}\n    ${theme.muted(description)}`;
}
function formatHelpExampleLine(command, description) {
	if (!description) return `  ${theme.command(command)}`;
	return `  ${theme.command(command)} ${theme.muted(`# ${description}`)}`;
}
function formatHelpExamples(examples, inline = false) {
	const formatter = inline ? formatHelpExampleLine : formatHelpExample;
	return examples.map(([command, description]) => formatter(command, description)).join("\n");
}

//#endregion
export { formatHelpExamples as t };
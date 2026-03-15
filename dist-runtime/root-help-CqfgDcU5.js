import "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import "./theme-UkqnBJaj.js";
import "./ansi-YpD2Ho3J.js";
import "./utils-Do8MzKyM.js";
import "./links-Cx-Xmp-Y.js";
import { n as VERSION } from "./version-Dubp0iGu.js";
import { t as getCoreCliCommandDescriptors } from "./core-command-descriptors-B0usyESy.js";
import { n as getSubCliEntries } from "./subcli-descriptors-DPHkAO_t.js";
import "./banner-BvJ0G81T.js";
import { t as configureProgramHelp } from "./help-BzPcw1YR.js";
import { Command } from "commander";
//#region src/cli/program/root-help.ts
function buildRootHelpProgram() {
	const program = new Command();
	configureProgramHelp(program, {
		programVersion: VERSION,
		channelOptions: [],
		messageChannelOptions: "",
		agentChannelOptions: ""
	});
	for (const command of getCoreCliCommandDescriptors()) {program.command(command.name).description(command.description);}
	for (const command of getSubCliEntries()) {program.command(command.name).description(command.description);}
	return program;
}
function outputRootHelp() {
	buildRootHelpProgram().outputHelp();
}
//#endregion
export { outputRootHelp };

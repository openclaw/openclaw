import "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import "./theme-CL08MjAq.js";
import "./ansi-CeMmGDji.js";
import "./utils-BiUV1eIQ.js";
import "./links-DPi3kBux.js";
import { n as VERSION } from "./version-Dubp0iGu.js";
import { t as getCoreCliCommandDescriptors } from "./core-command-descriptors-B0usyESy.js";
import { n as getSubCliEntries } from "./subcli-descriptors-DPHkAO_t.js";
import "./banner-C3WTRyuk.js";
import { t as configureProgramHelp } from "./help-BJyF0nRV.js";
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
	for (const command of getCoreCliCommandDescriptors()) program.command(command.name).description(command.description);
	for (const command of getSubCliEntries()) program.command(command.name).description(command.description);
	return program;
}
function outputRootHelp() {
	buildRootHelpProgram().outputHelp();
}
//#endregion
export { outputRootHelp };

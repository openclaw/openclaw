#!/usr/bin/env node
// @openclaw/agent-sdk CLI — Entry point for pack, validate, enable, disable.

import { Command } from "commander";
import { disableCommand } from "./commands/disable.js";
import { enableCommand } from "./commands/enable.js";
import { packCommand } from "./commands/pack.js";
import { testCommand } from "./commands/test.js";
import { validateCommand } from "./commands/validate.js";

const program = new Command();
program.name("openclaw-agent").description("Agent SDK packaging CLI").version("0.2.0");

program.addCommand(packCommand);
program.addCommand(validateCommand);
program.addCommand(enableCommand);
program.addCommand(disableCommand);
program.addCommand(testCommand);

program.parse();

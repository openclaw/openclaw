#!/usr/bin/env node
import {
  parseSnesTeamArgs,
  runSnesTeam,
  snesTeamHelp,
  snesTeamSucceeded,
} from "./lib/snes-team-orchestrator.mjs";

let args;
try {
  args = parseSnesTeamArgs(["--mode", "create-game", ...process.argv.slice(2)]);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(snesTeamHelp());
  process.exit(2);
}

if (args.help) {
  console.log(snesTeamHelp());
  process.exit(0);
}

const report = runSnesTeam(args);
if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`SNES create-game: ${report.status}`);
  if (report.project) console.log(`Project: ${report.project}`);
  if (report.template?.id) console.log(`Template: ${report.template.id}`);
  if (report.nextMilestone) console.log(`Next: ${report.nextMilestone}`);
  if (report.blocker) console.log(`Blocker: ${report.blocker}`);
}
process.exit(snesTeamSucceeded(report) ? 0 : 1);

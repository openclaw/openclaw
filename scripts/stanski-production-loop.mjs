#!/usr/bin/env node
import {
  parseStanskiProductionArgs,
  productionSucceeded,
  runStanskiProduction,
  stanskiProductionHelp,
} from "./lib/stanski-production-loop.mjs";

const args = parseStanskiProductionArgs(process.argv.slice(2));
if (args.help) {
  console.log(stanskiProductionHelp());
  process.exit(0);
}

const report = await runStanskiProduction(args);
if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Stanski production loop: ${report.status}`);
  console.log(`Completed: ${report.completedCount}/${report.totalCount}`);
  if (report.nextMilestone) {
    console.log(`Next: ${report.nextMilestone.id} ${report.nextMilestone.name}`);
  }
  if (report.state?.blockedMilestone) {
    console.log(
      `Blocked: ${report.state.blockedMilestone.id} ${report.state.blockedMilestone.reason}`,
    );
  }
}
process.exit(productionSucceeded(report) ? 0 : 1);

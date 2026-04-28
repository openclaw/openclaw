import { readJsonFile, runVitestJsonReport } from "../test-report-utils.mjs";
import { intFlag, parseFlagArgs, stringFlag } from "./arg-utils.mjs";

export function parseVitestReportArgs(argv, defaults) {
  return parseFlagArgs(
    argv,
    {
      config: defaults.config,
      limit: defaults.limit,
      reportPath: defaults.reportPath ?? "",
    },
    [
      stringFlag("--config", "config"),
      intFlag("--limit", "limit", { min: 1 }),
      stringFlag("--report", "reportPath"),
    ],
  );
}

export function loadVitestReportFromArgs(args, prefix) {
  const reportPath = runVitestJsonReport({
    config: args.config,
    reportPath: args.reportPath,
    prefix,
  });
  return readJsonFile(reportPath);
}

export function formatMs(value, digits = 1) {
  return `${value.toFixed(digits)}ms`;
}

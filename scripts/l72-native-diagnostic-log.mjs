import fs from "node:fs";
import { stripVTControlCharacters } from "node:util";
const text = stripVTControlCharacters(fs.readFileSync(process.argv[2], "utf8"));
if (
  text.includes("Fixture cleanup unverified; retained") ||
  text.includes("[vitest] retained temporary namespace") ||
  text.includes("descendant completion is unverified")
) {
  throw new Error("Failed invocation retained unverified resources; no next phase admitted");
}
const marker = "[darwin-managed-cleanup] ";
const reports = text.split("\n").flatMap((line) => {
  const index = line.indexOf(marker);
  return index < 0 ? [] : [JSON.parse(line.slice(index + marker.length))];
});
if (
  reports.length === 0 ||
  reports.some(
    (report) =>
      report.joined !== true ||
      report.outputClosed !== true ||
      report.processTreeState !== "terminated",
  )
) {
  throw new Error(
    "Failed invocation lacks complete joined native cleanup observations; stopping diagnosis",
  );
}
console.log(`Preserving failed phase with ${reports.length} joined native cleanup observations.`);

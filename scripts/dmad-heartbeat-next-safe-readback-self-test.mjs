#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL,
  buildHeartbeatNextSafeReadbackReport,
  buildMachineLineFromJsonPayload,
  readHeartbeatNextSafeMachineLine,
  readMachineLineFromJsonOutput,
  readMachineLineFromPlainOutput,
  readNextSafeFromMachineLine,
  runHeartbeatNextSafeReadbackCli,
  validateHeartbeatMachineLine,
  writeHeartbeatNextSafeReadbackReport,
} from "./dmad-heartbeat-next-safe-readback.mjs";

const machineLine =
  "nextSafe=controlled_task_runner_check;dmadGate=timeout-smoke:gate:ultra:verify:ultra:full;dmadPublish=verified;status=dry_run_ok;dmadGate=1;summaryDmad=true;readOnly=true";

assert.equal(readMachineLineFromPlainOutput(`task=x\nmachine_line=${machineLine}\n`), machineLine);
assert.equal(
  readMachineLineFromPlainOutput("task=x\ndmad_publish_status=dmadPublish=verified\n"),
  null,
);
assert.deepEqual(validateHeartbeatMachineLine(machineLine), { ok: true, missing: [] });
assert.deepEqual(validateHeartbeatMachineLine("nextSafe=x"), {
  ok: false,
  missing: ["dmadGate=", "dmadPublish=", "readOnly=true"],
});
assert.equal(readNextSafeFromMachineLine(machineLine), "controlled_task_runner_check");
assert.equal(
  readNextSafeFromMachineLine("dmadGate=x;nextSafe=paper_loop;readOnly=true"),
  "paper_loop",
);
assert.equal(readNextSafeFromMachineLine("nextSafe=;readOnly=true"), null);

const jsonPayload = {
  task: { id: "controlled_task_runner_check" },
  dmad_validation_hint: { machineLine: "dmadGate=timeout-smoke:gate:ultra:verify:ultra:full" },
  dmad_publish_status: {
    machineLine: "dmadPublish=verified;status=dry_run_ok;dmadGate=1;summaryDmad=true",
  },
  readOnlyMode: true,
};
assert.equal(buildMachineLineFromJsonPayload({ ...jsonPayload, machineLine }), machineLine);
assert.equal(buildMachineLineFromJsonPayload(jsonPayload), machineLine);
assert.equal(readMachineLineFromJsonOutput(JSON.stringify(jsonPayload)), machineLine);
assert.equal(readMachineLineFromJsonOutput("not json"), null);

let calls = [];
const plainReadback = await readHeartbeatNextSafeMachineLine({
  repoRoot: "repo",
  runNextSafe: async (_repoRoot, options) => {
    calls.push(options);
    return { exitCode: 0, stdout: `machine_line=${machineLine}\n`, stderr: "" };
  },
});
assert.equal(plainReadback.source, "plain_machine_line");
assert.equal(plainReadback.machineLine, machineLine);
assert.deepEqual(calls, [{ json: false }]);

calls = [];
const fallbackReadback = await readHeartbeatNextSafeMachineLine({
  repoRoot: "repo",
  runNextSafe: async (_repoRoot, options) => {
    calls.push(options);
    return options.json
      ? { exitCode: 0, stdout: JSON.stringify(jsonPayload), stderr: "" }
      : { exitCode: 0, stdout: "task=x\n", stderr: "" };
  },
});
assert.equal(fallbackReadback.source, "json_fallback");
assert.equal(fallbackReadback.machineLine, machineLine);
assert.equal(fallbackReadback.fallbackReason, "plain_missing=machine_line");
assert.deepEqual(calls, [{ json: false }, { json: true }]);

const report = buildHeartbeatNextSafeReadbackReport(
  plainReadback,
  new Date("2026-05-25T00:00:00.000Z"),
);
assert.equal(report.schema, "openclaw.dmad.heartbeat-next-safe-readback.v1");
assert.equal(report.status, "ready");
assert.equal(report.generatedAt, "2026-05-25T00:00:00.000Z");
assert.equal(report.mode, "state_write");
assert.equal(report.nextSafe, "controlled_task_runner_check");
assert.equal(report.heartbeat.nextSafe, "controlled_task_runner_check");
assert.equal(report.heartbeat.decision, "NOTIFY");
assert.equal(report.heartbeat.dispatchable, true);
assert.equal(
  report.heartbeat.message,
  "next_safe=controlled_task_runner_check;status=ready;freshness=ok;mode=state_write;dispatchable=true",
);
assert.match(report.heartbeat.xml, /<heartbeat>/);
assert.match(
  report.heartbeat.xml,
  /<automation_id>evaluate-openclaw-dmad-stability-and-improvements<\/automation_id>/,
);
assert.match(report.heartbeat.xml, /<message>next_safe=controlled_task_runner_check;/);
assert.equal(report.automationReadPoint.source, "latest_artifact");
assert.equal(report.automationReadPoint.artifact, HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL);
assert.equal(report.automationReadPoint.selector, "heartbeat.xml");
assert.equal(report.automationReadPoint.nextSafe, "controlled_task_runner_check");
assert.equal(report.automationReadPoint.dispatchable, true);
assert.equal(report.automationReadPoint.stdoutRequired, false);
assert.equal(report.automationReadPoint.blockedReason, null);
assert.equal(report.automationReadPoint.message, report.heartbeat.message);
assert.equal(report.automationReadPoint.xml, report.heartbeat.xml);
assert.equal(report.machineLine, machineLine);
assert.equal(report.fallbackReason, null);
assert.equal(report.blockedReason, null);
assert.equal(report.freshness.status, "ok");
assert.equal(report.freshness.ageMs, 0);
assert.equal(report.readOnly, true);
assert.equal(report.validation.ok, true);
assert.equal(report.safety.noExternalWrite, true);
assert.equal(report.reportPath, HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL);

const fallbackReport = buildHeartbeatNextSafeReadbackReport(
  fallbackReadback,
  new Date("2026-05-25T00:00:01.000Z"),
);
assert.equal(fallbackReport.status, "ready");
assert.equal(fallbackReport.mode, "state_write");
assert.equal(fallbackReport.fallbackReason, "plain_missing=machine_line");

const explicitNoWriteReport = buildHeartbeatNextSafeReadbackReport(
  plainReadback,
  new Date("2026-05-25T00:00:01.500Z"),
  { mode: "no_write" },
);
assert.equal(explicitNoWriteReport.mode, "no_write");

const staleReport = buildHeartbeatNextSafeReadbackReport(
  plainReadback,
  new Date("2026-05-25T00:00:00.000Z"),
  {
    freshnessNow: new Date("2026-05-25T00:00:02.000Z"),
    maxAgeMs: 1000,
  },
);
assert.equal(staleReport.status, "blocked");
assert.equal(staleReport.freshness.status, "blocked");
assert.equal(staleReport.freshness.reason, "generatedAt_ageMs=2000_exceeds_1000");
assert.equal(staleReport.blockedReason, "generatedAt_ageMs=2000_exceeds_1000");
assert.equal(staleReport.heartbeat.decision, "DONT_NOTIFY");
assert.equal(staleReport.heartbeat.dispatchable, false);
assert.match(staleReport.heartbeat.message, /dispatchable=false/);
assert.match(staleReport.heartbeat.message, /blocked_reason=generatedAt_ageMs=2000_exceeds_1000/);
assert.match(staleReport.heartbeat.xml, /<decision>DONT_NOTIFY<\/decision>/);
assert.equal(staleReport.automationReadPoint.dispatchable, false);
assert.equal(staleReport.automationReadPoint.blockedReason, "generatedAt_ageMs=2000_exceeds_1000");

let cliOutput = "";
let cliWriteCalls = 0;
const cliReport = await runHeartbeatNextSafeReadbackCli({
  argv: ["--json", "--no-write-state"],
  repoRoot: "repo",
  runNextSafe: async (_repoRoot, options) => {
    assert.deepEqual(options, { json: false });
    return { exitCode: 0, stdout: `machine_line=${machineLine}\n`, stderr: "" };
  },
  writeReport: async () => {
    cliWriteCalls += 1;
    throw new Error("writeReport must not run with --no-write-state");
  },
  stdout: {
    write(chunk) {
      cliOutput += chunk;
      return true;
    },
  },
  now: new Date("2026-05-25T00:00:02.000Z"),
});
const cliJson = JSON.parse(cliOutput);
assert.equal(cliWriteCalls, 0);
assert.equal(cliReport.generatedAt, "2026-05-25T00:00:02.000Z");
assert.equal(cliReport.mode, "no_write");
assert.equal(cliJson.mode, "no_write");
assert.equal(cliJson.nextSafe, "controlled_task_runner_check");
assert.equal(
  cliJson.heartbeat.message,
  "next_safe=controlled_task_runner_check;status=ready;freshness=ok;mode=no_write;dispatchable=true",
);
assert.match(cliJson.heartbeat.xml, /mode=no_write/);
assert.equal(cliJson.automationReadPoint.stdoutRequired, false);
assert.equal(cliJson.automationReadPoint.selector, "heartbeat.xml");
assert.equal(cliJson.automationReadPoint.nextSafe, "controlled_task_runner_check");
assert.equal(cliJson.automationReadPoint.dispatchable, true);
assert.equal(cliJson.freshness.status, "ok");
assert.equal(cliJson.machineLine, machineLine);
assert.equal(cliJson.fallbackReason, null);

cliOutput = "";
const staleCliReport = await runHeartbeatNextSafeReadbackCli({
  argv: ["--no-write-state"],
  repoRoot: "repo",
  runNextSafe: async () => ({ exitCode: 0, stdout: `machine_line=${machineLine}\n`, stderr: "" }),
  writeReport: async () => {
    throw new Error("writeReport must not run with --no-write-state");
  },
  stdout: {
    write(chunk) {
      cliOutput += chunk;
      return true;
    },
  },
  now: new Date("2026-05-25T00:00:00.000Z"),
  freshnessNow: new Date("2026-05-25T00:00:02.000Z"),
  maxAgeMs: 1000,
});
assert.equal(staleCliReport.status, "blocked");
assert.equal(staleCliReport.automationReadPoint.dispatchable, false);
assert.match(cliOutput, /^next_safe=controlled_task_runner_check$/m);
assert.match(cliOutput, /^dispatchable=false$/m);
assert.match(cliOutput, /^freshness=blocked$/m);
assert.match(cliOutput, /^freshness_reason=generatedAt_ageMs=2000_exceeds_1000$/m);
assert.match(cliOutput, /^blocked_reason=generatedAt_ageMs=2000_exceeds_1000$/m);
assert.match(cliOutput, /^dispatch_blocked_reason=generatedAt_ageMs=2000_exceeds_1000$/m);

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dmad-heartbeat-readback-"));
try {
  const writtenRel = await writeHeartbeatNextSafeReadbackReport(tempRoot, report);
  assert.equal(writtenRel, HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL);
  const written = JSON.parse(
    await fs.readFile(path.join(tempRoot, HEARTBEAT_NEXT_SAFE_READBACK_REPORT_REL), "utf8"),
  );
  assert.equal(written.machineLine, machineLine);
  assert.equal(written.nextSafe, "controlled_task_runner_check");
  assert.equal(written.heartbeat.nextSafe, "controlled_task_runner_check");
  assert.match(written.heartbeat.message, /^next_safe=controlled_task_runner_check;/);
  assert.match(written.heartbeat.xml, /<heartbeat>/);
  assert.equal(written.automationReadPoint.stdoutRequired, false);
  assert.equal(written.automationReadPoint.dispatchable, true);
  assert.equal(written.automationReadPoint.xml, written.heartbeat.xml);
  assert.equal(written.mode, "state_write");
  assert.equal(written.status, "ready");
  assert.equal(written.freshness.status, "ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

await assert.rejects(
  readHeartbeatNextSafeMachineLine({
    repoRoot: "repo",
    runNextSafe: async (_repoRoot, options) =>
      options.json
        ? { exitCode: 0, stdout: JSON.stringify({ task: { id: "x" } }), stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "failed" },
  }),
  /DMAD heartbeat next-safe readback failed/,
);

console.log("[dmad-heartbeat-next-safe-readback-self-test] PASS");

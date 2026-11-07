/**
 * Prepare legacy facts coverage before a canonical team-shape-stress Gateway opens.
 * Use --gateway-preload with a task-local module that imports this function and
 * calls it with { campaignRoot: absoluteOutputDirectory, temporaryRoot: originalTMPDIR }.
 * Capture originalTMPDIR in that module before launching the campaign: the harness
 * gives its child an arm-local TMPDIR, which can have unsafe external-volume ancestors.
 * Both revisions receive the same preparation. This only deletes derived facts from
 * the harness's fresh synthetic main-agent database, after Doctor has exited and
 * before Gateway imports. It does not alter the canonical stress workload.
 * Foreground append reservation samples are bounded to 100,000 numeric records;
 * filter by the result's measurementStartedAt/duration, and report dropped samples.
 */
import { channel } from "node:diagnostics_channel";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isMainThread } from "node:worker_threads";

/** @param {string} root */
function captureAppendReservations(root) {
  /** @type {Array<{atEpochMs: number; writerExecutionMs: number; queueWaitMs: number; elapsedMs: number}>} */
  const samples = [];
  let dropped = 0;
  let invalid = 0;
  channel("openclaw.agent-database.reservation").subscribe((message) => {
    if (
      !message ||
      typeof message !== "object" ||
      !("workerOperations" in message) ||
      !Array.isArray(message.workerOperations) ||
      !message.workerOperations.includes("session.actor.appendTranscriptEvent")
    ) {
      return;
    }
    if (
      !("writerExecutionMs" in message) ||
      typeof message.writerExecutionMs !== "number" ||
      !("queueWaitMs" in message) ||
      typeof message.queueWaitMs !== "number" ||
      !("elapsedMs" in message) ||
      typeof message.elapsedMs !== "number"
    ) {
      invalid++;
      return;
    }
    if (samples.length === 100_000) {
      dropped++;
      return;
    }
    samples.push({
      atEpochMs: Date.now(),
      writerExecutionMs: message.writerExecutionMs,
      queueWaitMs: message.queueWaitMs,
      elapsedMs: message.elapsedMs,
    });
  });
  process.once("exit", () =>
    writeFileSync(
      path.join(root, "transcript-facts-append-reservations.json"),
      JSON.stringify({ pid: process.pid, dropped, invalid, samples }),
    ),
  );
}

/** @param {{ campaignRoot: string; temporaryRoot: string }} options */
export function prepareTranscriptFactsBackfillStress(options) {
  if (!isMainThread || process.argv[2] !== "gateway" || process.argv[3] !== "run") {
    return;
  }
  const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
  if (
    process.argv[process.argv.indexOf("--bind") + 1] !== "loopback" ||
    !Number.isInteger(port) ||
    port < 40000 ||
    port > 65535
  ) {
    throw new Error("Facts preparation requires the isolated loopback stress Gateway");
  }
  const root = realpathSync(process.env.OPENCLAW_STATE_DIR ?? "");
  const campaign = realpathSync(options.campaignRoot);
  if (path.dirname(root) !== campaign) {
    throw new Error("Facts preparation state is outside the selected stress campaign");
  }
  /** @type {unknown} */
  const summary = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
  if (
    !summary ||
    typeof summary !== "object" ||
    !("format" in summary) ||
    summary.format !== "openclaw-team-shape-v1"
  ) {
    throw new Error("Facts preparation requires a canonical synthetic fixture");
  }
  const temporaryRoot = realpathSync(options.temporaryRoot);
  process.env.TMPDIR = temporaryRoot;
  const load = os.loadavg();
  const reportPath = path.join(root, "transcript-facts-preparation.json");
  const report = {
    pid: process.pid,
    port,
    startedAt: new Date().toISOString(),
    hostLoadAverage: load,
  };
  if ((load[0] ?? Infinity) > 40) {
    writeFileSync(
      reportPath,
      JSON.stringify({ ...report, refused: "host load exceeds 40" }, null, 2),
    );
    throw new Error("Facts stress arm invalid: initial host load exceeds 40");
  }
  const databasePath = realpathSync(
    path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  );
  if (!databasePath.startsWith(`${root}${path.sep}`)) {
    throw new Error("Facts preparation database escaped the synthetic state directory");
  }
  const database = new DatabaseSync(databasePath);
  try {
    const sessions = database.prepare("SELECT session_id FROM session_windows").all();
    if (
      sessions.length === 0 ||
      sessions.some(
        (row) =>
          typeof row.session_id !== "string" || !/^team-shape-session-\d+$/.test(row.session_id),
      )
    ) {
      throw new Error("Facts preparation refuses nonsynthetic session identities");
    }
    database.exec("BEGIN IMMEDIATE");
    try {
      const deleted = database.prepare("DELETE FROM session_transcript_active_event_facts").run();
      const active = database
        .prepare("SELECT count(*) AS count FROM session_transcript_active_events")
        .get();
      database.exec("COMMIT");
      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            ...report,
            sessions: sessions.length,
            activeRows: active?.count,
            factsRemoved: Number(deleted.changes),
            finishedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } catch (error) {
      if (database.isTransaction) {
        database.exec("ROLLBACK");
      }
      throw error;
    }
  } finally {
    database.close();
  }
  captureAppendReservations(root);
}

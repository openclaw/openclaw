import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { snapshotFsPath } from "./snapshot-capture-binding.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
export function createSnapshotAcquisitionRecorder(root, { identity, pid, threadId, operationId }) {
  const acquisitions = [];
  return (directory) => {
    acquisitions.push({
      directory,
      at: String(process.hrtime.bigint()),
      operationId: operationId(),
    });
    fs.writeFileSync(
      path.join(root, "snapshot-cleanup-attempts-" + pid + "-" + threadId + ".json"),
      JSON.stringify({ pid, threadId, identity, acquisitions }),
      { mode: 0o600 },
    );
  };
}

export function snapshotEvidenceRecords(root) {
  const names = fs.readdirSync(root).toSorted();
  const rows = (pattern) =>
    names.filter((name) => pattern.test(name)).map((name) => read(root, name));
  return {
    copies: rows(/^snapshot-cleanup-copy-[0-9a-f]{64}[.]json$/u),
    natives: rows(/^snapshot-cleanup-native-[0-9a-f]{64}\.json$/u),
    attempts: rows(/^snapshot-cleanup-attempts-\d+-\d+\.json$/u),
    doctors: rows(/^snapshot-cleanup-doctor-\d+\.json$/u),
  };
}

function snapshotAcquisitionSummary(records, selected) {
  const counts = { selected: 0, unselectedBefore: 0, unselectedAfter: 0, unknown: 0 };
  const digest = createHash("sha256");
  const directories = [];
  for (const attempt of records.attempts) {
    if (!Array.isArray(attempt.acquisitions)) {
      counts.unknown += attempt.directories?.length ?? 1;
      continue;
    }
    for (const entry of attempt.acquisitions) {
      digest.update(JSON.stringify([attempt.pid, attempt.threadId, entry]) + "\n");
      if (selected?.native?.operationId && entry.operationId === selected.native.operationId) {
        counts.selected++;
        directories.push(entry.directory);
      } else if (/^\d+$/u.test(entry.at ?? "") && /^\d+$/u.test(selected?.injectedAt ?? "")) {
        counts[
          BigInt(entry.at) < BigInt(selected.injectedAt) ? "unselectedBefore" : "unselectedAfter"
        ]++;
      } else {
        counts.unknown++;
      }
    }
  }
  return { ...counts, digest: digest.digest("hex"), directories };
}

export function summarizeSnapshotCleanupEvidence(root) {
  const records = snapshotEvidenceRecords(root);
  const fault = records.copies.length === 1 ? records.copies[0] : undefined;
  const native = fault && records.natives.find((row) => row.key === fault.native?.key);
  const doctor = fault && records.doctors.find((row) => row.pid === fault.doctor?.pid);
  const optional = (name) => (fs.existsSync(path.join(root, name)) ? read(root, name) : undefined);
  const fixture = optional("snapshot-cleanup-fixture.json");
  const outer = optional("snapshot-cleanup-result.json");
  const acquisitions = snapshotAcquisitionSummary(records, fault);
  const unknown = [];
  if (!fault) {
    unknown.push("selected-fault");
  }
  if (!native?.binding) {
    unknown.push("native-request-binding");
  }
  if (!native?.close) {
    unknown.push("native-close");
  }
  if (!native?.retirement) {
    unknown.push("parent-retirement");
  }
  if (!doctor?.result) {
    unknown.push("doctor-result");
  }
  if (!outer) {
    unknown.push("outer-result");
  }
  if (acquisitions.unknown) {
    unknown.push("acquisition-order");
  }
  if (native?.observationError) {
    unknown.push("native-observation-error");
  }
  if ((native?.stops?.length ?? 0) > 4) {
    unknown.push("retirement-observation-overflow");
  }
  if (native?.transport === "ipc" && !native.reply) {
    unknown.push("native-reply");
  }
  const identity = fault?.identity;
  const binding = native?.binding;
  // Critical facts lead; repeated paths, inventories and unselected rows stay private.
  const result = {
    version: 2,
    fault: fault && {
      pid: fault.pid,
      threadId: fault.threadId,
      operationId: native?.operationId,
      request: native?.request,
      writer: fault.writer,
      cleanupDenials: fault.cleanupDenials,
      terminalRefusal: fault.terminalRefusal,
      retainedAtRefusal: fault.retainedAtRefusal,
      failure: fault.failure && {
        sha256: fault.failure.sha256,
        resultSha256: fault.failure.resultSha256,
        channel: fault.failure.channel,
        ipcRequestId: fault.failure.ipcRequestId,
        excerpt: fault.failure.message.slice(-192),
        excerptOmitted: fault.failure.message.length > 192 || fault.failure.truncated,
      },
      sourcePreservedAtRefusal: fault.sourcePreservedAtRefusal,
      sourceFamily: fault.afterWriter,
      unpublishedAtRefusal: fault.unpublishedAtRefusal,
      groupIncompleteAtRefusal: fault.groupIncompleteAtRefusal,
      innerRemoved: fault.removed,
    },
    doctor: doctor && {
      pid: doctor.pid,
      start: doctor.start,
      fullPayloadVerified: doctor.fullPayloadVerified,
      updateInProgress: doctor.updateInProgress,
      result: doctor.result && {
        status: doctor.result.status,
        sha256: doctor.result.sha256,
        failureFactCount: doctor.result.failureFacts?.length ?? 0,
      },
    },
    outer,
    custody: native && {
      child: native.pid,
      childStart: native.childStart,
      parentStart: native.parentStart,
      transport: native.transport,
      ipcRequestId: native.ipcRequestId,
      reply: native.reply && {
        id: native.reply.id,
        ok: native.reply.ok,
        sha256: native.reply.sha256,
        receivedAt: native.reply.receivedAt,
      },
      stopCount: native.stops?.length,
      stopDigest: hash(JSON.stringify(native.stops ?? [])),
      stops: native.stops
        ?.slice(0, 4)
        .map(({ kind, signal, accepted, at }) => ({ kind, signal, accepted, at })),
      retirementOwner: native.stops?.[0]?.owner,
      close: native.close,
      closedAt: native.closedAt,
      retirement: native.retirement,
    },
    acquisitions: { ...acquisitions, directories: undefined },
    binding: binding && {
      sourceIdentity: binding.sourceIdentity,
      sourceSha256: hash(binding.source),
      targetSha256: hash(binding.target),
      stagingRootSha256: hash(native.stagingRoot),
      markerIdentity: binding.markerIdentity,
      owner: binding.owner,
      snapshot: binding.snapshot,
    },
    identity: identity && {
      commit: identity.commit,
      entrypoint: identity.entrypoint,
      entrypointSha256: identity.entrypointSha256,
      manifestSha256: identity.manifestSha256,
      buildInfoSha256: identity.buildInfoSha256,
      payloadSha256: identity.payloadSha256,
    },
    baseline: fixture?.baseline,
    candidate: optional("snapshot-cleanup-candidate.json"),
    inventoryOmitted: true,
    unknown,
    overflow: false,
  };
  // Bound the JSON-string representation, which the existing host publisher caps.
  if (Buffer.byteLength(JSON.stringify(JSON.stringify(result))) > 7 * 1024) {
    return {
      version: 2,
      overflow: true,
      unknown: ["critical-summary-overflow"],
      digest: hash(JSON.stringify(result)),
    };
  }
  return result;
}

export function assertSelectedSnapshotAcquisitions(records, observed, expectedPayload) {
  assert(
    observed.native?.binding && observed.native.operationId,
    "Fault lacks required caller binding",
  );
  const selected = records.natives.filter((row) => row.operationId === observed.native.operationId);
  assert.equal(selected.length, 1, "Selected operation issued another native request");
  assert.equal(selected[0].pid, observed.pid, "Fault does not belong to the selected native child");
  for (const row of records.attempts) {
    assert.equal(row.identity.payloadSha256, expectedPayload);
    assert.equal(row.identity.commit, observed.identity.commit);
  }
  const counts = snapshotAcquisitionSummary(records, observed);
  assert.equal(counts.unknown, 0, "Unobserved acquisition identity or ordering");
  assert.deepEqual(
    counts.directories,
    [observed.staging],
    "Selected operation reacquired the source",
  );
  return { native: selected[0], counts };
}

// Parent removal is a separate owner event from child unlink denial and native close.
export function observeSnapshotParentRetirement(requests, readFailure, onUpdate) {
  const remove = fs.rmSync;
  const removeAsync = fs.promises.rm;
  const find = (file) => requests.find((request) => snapshotFsPath(file) === request.stagingRoot);
  const update = (request) => {
    try {
      onUpdate(request);
    } catch (error) {
      request.observationError =
        error instanceof Error ? error.message : "Retirement observation failed";
    }
  };
  const before = (file) => {
    const request = find(file);
    if (request) {
      let fault;
      try {
        fault = readFailure(request);
      } catch {
        /* Missing evidence must not interrupt real cleanup. */
      }
      request.retirement = {
        afterNativeClose: Boolean(request.close && request.closedAt),
        producerRefused: fault?.terminalRefusal === true && fault.native.key === request.key,
        startedAt: String(process.hrtime.bigint()),
        removed: false,
      };
      update(request);
    }
    return request;
  };
  const after = (request) => {
    if (request) {
      request.retirement.removed = !fs.existsSync(request.stagingRoot);
      request.retirement.finishedAt = String(process.hrtime.bigint());
      update(request);
    }
  };
  const failed = (request, error) => {
    if (request) {
      request.retirement.error =
        error instanceof Error ? error.message.slice(0, 512) : "Non-Error cleanup failure";
      update(request);
    }
  };
  fs.rmSync = (file, options) => {
    const request = before(file);
    try {
      const result = remove(file, options);
      after(request);
      return result;
    } catch (error) {
      failed(request, error);
      throw error;
    }
  };
  fs.promises.rm = async (file, options) => {
    const request = before(file);
    try {
      await removeAsync(file, options);
      after(request);
    } catch (error) {
      failed(request, error);
      throw error;
    }
  };
  syncBuiltinESMExports();
  return () => {
    fs.rmSync = remove;
    fs.promises.rm = removeAsync;
    syncBuiltinESMExports();
  };
}

export function assertSnapshotFailureCustody(native, fault) {
  assert.equal(native.observationError, undefined, "Selected observation was incomplete");
  for (const field of [
    "key",
    "pid",
    "childStart",
    "parentPid",
    "parentStart",
    "transport",
    "ipcRequestId",
  ]) {
    assert.equal(
      native[field],
      fault.native[field],
      "Refusal changed native request identity: " + field,
    );
  }
  assert.match(native.childStart, /^[0-9]+$/u);
  assert.match(native.parentStart, /^[0-9]+$/u);
  assert(native.close && native.closedAt, "Selected native child close was not observed");
  const stops = native.stops ?? [];
  if (native.transport === "ipc") {
    assert.equal(
      fault.failure?.channel,
      "process.send",
      "Persistent refusal was not a real IPC reply",
    );
    assert.equal(
      native.reply?.id,
      native.ipcRequestId,
      "Parent did not receive the selected failure reply",
    );
    assert.equal(native.reply?.ok, false, "Selected persistent reply did not fail");
    assert.equal(
      native.reply?.sha256,
      fault.failure?.resultSha256,
      "Parent and child failure replies differ",
    );
    assert(stops.length > 0, "Failed-reply owner retirement was not observed");
    assert(
      stops.every(
        (stop) =>
          stop.kind === "failed-reply-retirement" &&
          stop.signal === "SIGKILL" &&
          stop.owner?.name === "retire" &&
          BigInt(stop.at) >= BigInt(native.reply.receivedAt) &&
          BigInt(stop.at) <= BigInt(native.closedAt),
      ),
      "External cancellation or unobserved kill cannot prove refusal retirement",
    );
    assert(
      (native.close.code === 1 && native.close.signal === null) ||
        (native.close.code === null &&
          native.close.signal === "SIGKILL" &&
          stops.some((stop) => stop.accepted)),
      "Persistent child close was not the observed failed-reply retirement",
    );
  } else {
    assert.equal(native.transport, "one-shot", "Unknown capture transport");
    assert.equal(fault.failure?.channel, "stdout");
    assert.equal(stops.length, 0, "One-shot capture was externally interrupted");
    assert.equal(native.close.code, 1, "Selected native worker did not exit with refusal code 1");
    assert.equal(native.close.signal, null, "One-shot child did not report normal refusal");
  }
  assert.equal(
    native.retirement?.afterNativeClose,
    true,
    "Parent retirement preceded native close or was unobserved",
  );
  assert.equal(
    native.retirement?.producerRefused,
    true,
    "Parent retirement lacks observed producer refusal",
  );
  assert.equal(
    native.retirement?.removed,
    true,
    "Parent staging retirement did not settle failed scratch",
  );
  assert(
    BigInt(native.retirement.startedAt) >= BigInt(native.closedAt),
    "Parent cleanup ordering is not proven",
  );
}

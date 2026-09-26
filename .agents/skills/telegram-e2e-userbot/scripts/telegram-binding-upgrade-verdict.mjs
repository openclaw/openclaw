import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertCandidateInstalled } from "./published-upgrade-artifact.mjs";

export function requireNormalGatewayStop(stopped, runtime, phase) {
  if (
    stopped.phase !== phase ||
    stopped.joined !== true ||
    stopped.outcomeType !== "exit" ||
    stopped.exitCode !== 0 ||
    stopped.signal !== null ||
    stopped.cleanupUnconfirmed ||
    stopped.graceMs !== 60000 ||
    stopped.runtime?.build?.commit !== runtime.installedCommit ||
    stopped.runtime?.entrySha256 !== runtime.entrySha256 ||
    stopped.runtime?.packageRoot !== runtime.installedRoot
  ) {
    throw new Error("GATEWAY_ORDERLY_SHUTDOWN_RECEIPTS_MISSING");
  }
}

function readPublicUpgradeEvidence(proof, stage) {
  const read = (name) => {
    try {
      return JSON.parse(readFileSync(join(proof, name), "utf8"));
    } catch {
      return undefined;
    }
  };
  const exitCode = (value) => (Number.isInteger(value) ? value : null);
  const duration = (value) => (Number.isFinite(value) && value >= 0 ? value : null);
  const signal = (value) =>
    ["SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV", "SIGINT"].includes(value) ? value : null;
  const build = (value) =>
    value &&
    /^[0-9a-f]{40}$/.test(value.commit ?? "") &&
    /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(value.version ?? "")
      ? { commit: value.commit, version: value.version }
      : undefined;
  const update = read("updater-readback.json");
  const cleanup = read("cleanup.json");
  const reason = read("failure.json")?.message;
  const failureCodes = new Set([
    "CANDIDATE_ARCHIVE_INSPECTION_FAILED",
    "PINNED_TDLIB_PREPARATION_FAILED",
    "PUBLISHED_BASELINE_IDENTITY_OR_LIFECYCLE_INVALID",
    "DISTINCT_VALID_CANDIDATE_REQUIRED",
    "TDLIB_PREPARE_FAILED",
    "TDLIB_VERIFY_FAILED",
    "RECEIPT_CLEANUP_UNCONFIRMED",
    "UPDATER_DEADLINE",
    "PUBLISHED_UPDATER_FAILED_OR_UNSETTLED",
    "OWNED_CHILD_EXITED_BEFORE_READY",
    "INSTALLED_GATEWAY_READINESS_DEADLINE",
    "AUTHORITATIVE_CHECKPOINT_FAILED",
    "GATEWAY_ORDERLY_SHUTDOWN_RECEIPTS_MISSING",
    "INSTALLED_RUNTIME_ARTIFACT_CHANGED",
  ]);
  const stages = new Set([
    "input-admission",
    "installed-provenance",
    "owned-runtime-admission",
    "compiled-diagnostic-redactor",
    "native-failure-inspection",
    "waiting-for-explicit-condition",
    "parent-history",
    "child-identity-before",
    "child-history",
    "child-identity-after",
    "phase-conditions",
    "final-artifact-check",
  ]);
  const codes = new Set([
    "CHECKPOINT_PROGRAM_ERROR",
    "CHECKPOINT_RPC_FAILED",
    "CHECKPOINT_RPC_JSON_INVALID",
    "CHECKPOINT_RPC_ERROR_ENVELOPE",
    "CONDITION_DEADLINE",
    "VERIFICATION_DEADLINE",
    "AUTHORITATIVE_CHECKPOINT_STATE_MISSING",
    "NATIVE_ACTION_FAILED",
    "NATIVE_FIXTURE_REPORTED_FAILURE",
    "MALFORMED_RECORDER_EVENT",
    "SPAWN_NOT_ACCEPTED",
    "SPAWN_ARGUMENTS_MISMATCH",
    "SPAWN_RESULT_ID_MISMATCH",
    "SPAWN_USER_TURN_MISMATCH",
    "MOCK_CALL_ID_MISMATCH",
    "MULTIPLE_PARENT_SPAWN_CALLS",
    "ACCEPTED_SPAWN_CONTRACT_MISMATCH",
    "CHILD_CANONICAL_IDENTITY_MISSING",
    "CHILD_IDENTITY_CHANGED",
    "CHILD_IDENTITY_CHANGED_DURING_READ",
    "PARENT_HISTORY_SHAPE_INVALID",
    "CHILD_HISTORY_SHAPE_INVALID",
    "FOLLOWUP_PRECEDED_CHECKPOINT",
    "FOLLOWUP_ROUTED_TO_CHILD",
    "INSTALLED_RUNTIME_CHANGED_DURING_CHECKPOINT",
  ]);
  const checkpoints = ["spawn", "before", "after"].flatMap((phase) => {
    const value = read(`routing-${phase}.json.diagnostic.json`);
    if (!value) {
      return [];
    }
    return [
      {
        phase,
        status: ["running", "waiting", "completed", "failed"].includes(value.status)
          ? value.status
          : "unknown",
        stage: stages.has(value.stage) ? value.stage : "unknown",
        code: codes.has(value.code) ? value.code : undefined,
        timedOut: value.timedOut === true,
        missing: Array.isArray(value.missing)
          ? value.missing.filter(
              (name) =>
                typeof name === "string" &&
                /^(?:(?:SPAWN|PARENT|CHILD|BEFORE|AFTER)_(?:NATIVE_SEND_RECEIPT|NATIVE_ACK|TRANSCRIPT_ACK|TRANSCRIPT_USER)|PARENT_SPAWN_CALL|SPAWN_TOOL_RESULT)$/.test(
                  name,
                ),
            )
          : [],
        ...(value.rpc
          ? {
              rpc: {
                method: ["sessions.get", "sessions.describe"].includes(value.rpc.method)
                  ? value.rpc.method
                  : "unknown",
                exitCode: exitCode(value.rpc.exitCode),
                signal: signal(value.rpc.signal),
                remoteCode: [
                  "INVALID_REQUEST",
                  "UNAVAILABLE",
                  "INTERNAL_ERROR",
                  "NOT_FOUND",
                  "UNAUTHORIZED",
                ].includes(value.rpc.remoteCode)
                  ? value.rpc.remoteCode
                  : undefined,
              },
            }
          : {}),
      },
    ];
  });
  return {
    reason: failureCodes.has(reason) ? reason : undefined,
    stage: ["preflight", "live-scenario", "final-judgment"].includes(stage) ? stage : "unknown",
    ...(update
      ? {
          updater: {
            exitCode: exitCode(update.exitCode),
            joined: update.joined === true,
            durationMs: duration(update.durationMs),
            timedOut: update.timedOut === true,
            outcomeUncertain: update.outcomeUncertain === true,
            before: build(update.beforeBuild),
            after: build(update.afterBuild),
          },
        }
      : {}),
    gatewayStops: ["baseline-before-update", "candidate-restart", "candidate-final"].flatMap(
      (phase) => {
        const value = read(`gateway-stop-${phase}.json`);
        return value
          ? [
              {
                phase,
                joined: value.joined === true,
                exitCode: exitCode(value.exitCode),
                signal: signal(value.signal),
                durationMs: duration(value.durationMs),
                cleanupUnconfirmed: value.cleanupUnconfirmed === true,
              },
            ]
          : [];
      },
    ),
    checkpoints,
    cleanup: cleanup
      ? {
          confirmed: cleanup.ok === true && cleanup.leaseReleased === true,
          fixtureConfirmed: cleanup.ok === true,
          leaseReleased: cleanup.leaseReleased === true ? true : null,
          retainedLease: cleanup.retainedLease === true ? true : null,
          ownedGroupDeleted: cleanup.groupDeleted === true,
        }
      : { confirmed: false, receiptMissing: true },
  };
}

export function publicUpgradeFailure(proof, stage) {
  return {
    ok: false,
    scenario: "telegram-published-upgrade-bindings",
    code: "PUBLISHED_UPGRADE_PROOF_FAILED",
    ...readPublicUpgradeEvidence(proof, stage),
  };
}

export function publicUpgradeReport(result, upgrade, proof) {
  const evidence = readPublicUpgradeEvidence(proof, "final-judgment");
  if (
    !evidence.cleanup.confirmed ||
    evidence.gatewayStops.length !== 3 ||
    evidence.updater?.exitCode !== 0 ||
    !evidence.updater.joined
  ) {
    throw new Error("CURATED_UPGRADE_EVIDENCE_INCOMPLETE");
  }
  return {
    ok: result.ok === true,
    scenario: "telegram-published-upgrade-bindings",
    baseline: {
      version: upgrade.baseline.buildInfo.version,
      commit: upgrade.baseline.buildInfo.commit,
    },
    candidate: {
      version: upgrade.candidate.buildInfo.version,
      commit: upgrade.candidate.buildInfo.commit,
      sha256: upgrade.candidate.sha256,
    },
    topicReturnedToParentAcrossUpgradeAndRestart:
      result.topicReturnedToParentAcrossRestart === true,
    orderlyGatewayStops: evidence.gatewayStops.length,
    verifiedRestarts: result.verifiedRestarts,
    nativePhases: result.nativePhases,
    providerRequests: result.providerRequests,
    cleanupConfirmed: evidence.cleanup.confirmed,
    mockProvider: true,
    ...evidence,
  };
}

export function judgeBindingUpgrade({
  result,
  proof,
  recordPath,
  fixture,
  runId,
  upgrade,
  cleanup,
}) {
  const read = (name) => JSON.parse(readFileSync(join(proof, name), "utf8"));
  assertCandidateInstalled(upgrade);
  const summary = read("summary.json");
  const actions = summary.scenario?.gatewayActions ?? [];
  if (
    result.exitCode !== 0 ||
    !summary.recordingComplete ||
    summary.actionError ||
    summary.scenario?.actionFailure ||
    actions.length !== 5 ||
    actions.some((action) => action.status !== "completed") ||
    actions.map((action) => action.type).join(",") !==
      "command,restartGateway,command,restartGateway,command"
  ) {
    throw new Error("SCENARIO_ACTIONS_INCOMPLETE");
  }
  if (statSync(recordPath).size > 128 * 1024 * 1024) {
    throw new Error("EVENT_EVIDENCE_OVER_BOUND");
  }
  const events = readFileSync(recordPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const sends = events.filter((event) => event.kind === "action" && event.actionType === "send");
  if (
    sends.length !== 3 ||
    sends.some(
      (event, index) => event.status !== "completed" || event.text !== fixture.userTexts[index],
    )
  ) {
    throw new Error("SYNTHETIC_SEND_RECEIPTS_INCOMPLETE");
  }
  for (const sent of sends) {
    if (
      !events.some(
        (event) =>
          event.kind === "message" &&
          event.isOutgoing === true &&
          event.text === sent.text &&
          event.topicType === "messageTopicForum" &&
          event.topicId === fixture.topicId,
      )
    ) {
      throw new Error("NATIVE_SENT_TOPIC_EVIDENCE_MISSING");
    }
  }
  const restart1 = actions[1];
  const restart2 = actions[3];
  if (
    sends[0].elapsedMs >= restart1.elapsedMs ||
    sends[1].elapsedMs < restart1.elapsedMs ||
    sends[1].elapsedMs >= restart2.elapsedMs ||
    sends[2].elapsedMs < restart2.elapsedMs
  ) {
    throw new Error("RESTART_TURN_ORDER_MISMATCH");
  }
  for (const phase of ["PARENT", "CHILD", "BEFORE", "AFTER"]) {
    const origin = sends[phase === "BEFORE" ? 1 : phase === "AFTER" ? 2 : 0];
    const matched = events.filter(
      (event) =>
        event.isSut === true &&
        ["message", "edit"].includes(event.kind) &&
        event.text?.trim() === `TELEGRAM_BINDING_ACK_${phase}_${runId}` &&
        event.elapsedMs >= origin.elapsedMs &&
        (!["PARENT", "CHILD"].includes(phase) || event.elapsedMs < restart1.elapsedMs) &&
        (phase !== "BEFORE" || event.elapsedMs < restart2.elapsedMs) &&
        event.topicType === "messageTopicForum" &&
        event.topicId === fixture.topicId,
    );
    if (!matched.length) {
      throw new Error(`NATIVE_${phase}_ACK_MISSING`);
    }
  }
  const spawned = read("routing-spawn.json");
  const before = read("routing-before.json");
  const after = read("routing-after.json");
  for (const [index, name] of ["spawn", "before", "after"].entries()) {
    const value = [spawned, before, after][index];
    const diagnostic = read(`routing-${name}.json.diagnostic.json`);
    if (
      value.status !== "READ_CHECKPOINT_ONLY" ||
      value.phase !== name ||
      value.runId !== runId ||
      diagnostic.status !== "completed" ||
      value.parentKey !== spawned.parentKey ||
      value.childKey !== spawned.childKey ||
      value.sessionId !== spawned.sessionId ||
      value.toolCallId !== spawned.toolCallId ||
      value.runtime?.stateDir !== spawned.runtime?.stateDir ||
      value.runtime?.mode !== "compiled" ||
      value.runtime?.installedCommit !==
        (name === "spawn" ? upgrade.baseline.buildInfo.commit : upgrade.candidate.buildInfo.commit)
    ) {
      throw new Error("CHILD_IDENTITY_CHECKPOINTS_MISSING");
    }
  }
  // The baseline's spawn takes over the topic; the candidate must route later
  // turns back to the parent while the child's own transcript stays intact.
  if (
    spawned.phases?.CHILD?.session !== "child" ||
    after.phases?.CHILD?.session !== "child" ||
    before.phases?.BEFORE?.session !== "parent" ||
    after.phases?.BEFORE?.session !== "parent" ||
    after.phases?.AFTER?.session !== "parent"
  ) {
    throw new Error("PARENT_ROUTING_CHECKPOINTS_MISSING");
  }
  const requestPath = join(proof, "mock-openai-requests.ndjson");
  if (statSync(requestPath).size > 128 * 1024 * 1024) {
    throw new Error("PROVIDER_EVIDENCE_OVER_BOUND");
  }
  const bodies = readFileSync(requestPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      return typeof row.body === "string" ? JSON.parse(row.body) : null;
    })
    .filter(Boolean);
  const providerText = (value) =>
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value
            .filter((part) => part?.type === "input_text")
            .map((part) => part.text)
            .join("\n")
        : "";
  const currentProviderText = (content) => {
    const value = providerText(content);
    if (
      value.includes("[Chat messages since your last reply - for context]") ||
      value.includes("[Recent chat messages - for context]")
    ) {
      const boundary = "\n[Current message - respond to this]\n";
      const index = value.lastIndexOf(boundary);
      return index < 0 ? "" : value.slice(index + boundary.length);
    }
    return value;
  };
  for (const phase of ["SPAWN", "BEFORE", "AFTER"]) {
    if (
      !bodies.some((body) => {
        const user = (Array.isArray(body.input) ? body.input : []).findLast(
          (item) =>
            item.role === "user" &&
            !providerText(item.content).startsWith("<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n"),
        );
        return (
          user &&
          new RegExp(
            `(^|[^A-Za-z0-9_-])TELEGRAM_BINDING_${phase}_${runId}($|[^A-Za-z0-9_-])`,
            "u",
          ).test(currentProviderText(user.content))
        );
      })
    ) {
      throw new Error(`CURRENT_PROVIDER_${phase}_REQUEST_MISSING`);
    }
  }
  if (
    !bodies.some(
      (body) =>
        Array.isArray(body.input) &&
        body.input.some((item) => {
          if (item.type !== "function_call_output" || item.call_id !== before.callId) {
            return false;
          }
          try {
            const receipt = JSON.parse(providerText(item.output));
            return receipt.status === "accepted" && receipt.childSessionKey === before.childKey;
          } catch {
            return false;
          }
        }),
    )
  ) {
    throw new Error("PROVIDER_ACCEPTED_TARGET_CORRELATION_MISSING");
  }
  const updateReceipt = read("updater-readback.json");
  if (
    updateReceipt.exitCode !== 0 ||
    !updateReceipt.joined ||
    !updateReceipt.baselineJoinedBeforeUpdate ||
    updateReceipt.beforeBuild.commit !== upgrade.baseline.buildInfo.commit ||
    updateReceipt.afterBuild.commit !== upgrade.candidate.buildInfo.commit ||
    !updateReceipt.lifecyclePendingAbsent ||
    !updateReceipt.legacyInstallGuardAbsent ||
    updateReceipt.stateDir !== spawned.runtime.stateDir ||
    updateReceipt.beforeEntrySha256 !== spawned.runtime.entrySha256 ||
    updateReceipt.afterEntrySha256 !== before.runtime.entrySha256 ||
    before.runtime.entrySha256 !== after.runtime.entrySha256 ||
    JSON.stringify(before.runtime) !== JSON.stringify(after.runtime)
  ) {
    throw new Error("PUBLISHED_UPGRADE_IDENTITY_OR_STATE_MISMATCH");
  }
  for (const [phase, runtime] of [
    ["baseline-before-update", spawned.runtime],
    ["candidate-restart", before.runtime],
    ["candidate-final", after.runtime],
  ]) {
    const stopped = read(`gateway-stop-${phase}.json`);
    requireNormalGatewayStop(stopped, runtime, phase);
  }
  if (cleanup?.ok !== true) {
    throw new Error("CLEANUP_NOT_CONFIRMED");
  }
  return {
    ok: true,
    candidateCommit: upgrade.candidate.buildInfo.commit,
    topicReturnedToParentAcrossRestart: true,
    verifiedRestarts: 2,
    publishedDriverUpgrade: true,
    beforeBuild: updateReceipt.beforeBuild,
    afterBuild: updateReceipt.afterBuild,
    nativePhases: ["PARENT", "CHILD", "BEFORE", "AFTER"],
    providerRequests: bodies.length,
    cleanupDeleted: cleanup.deleted,
    cleanupOwnedGroupDeleted: cleanup.groupDeleted === true,
    limitation: "Deterministic mock provider; no real model-quality claim.",
  };
}

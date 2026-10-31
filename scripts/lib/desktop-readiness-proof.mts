import assert from "node:assert/strict";
import { constants } from "node:os";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  redactSupportDiagnosticLine,
  redactTextForSupport,
} from "../../src/logging/diagnostic-support-redaction.js";

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  assert(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum,
    "Invalid desktop readiness number",
  );
  return value;
}

function category<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  const found = choices.find((choice) => choice === value);
  assert(found, "Invalid desktop readiness category");
  return found;
}

function probe(value: unknown) {
  assert(isRecord(value), "Invalid desktop readiness probe");
  const error =
    value.error === undefined
      ? undefined
      : category(value.error, [
          "timeout",
          "child-exit",
          "fetch-failed",
          "invalid-json",
          "body-failed",
          "aborted",
        ]);
  const status = value.status === undefined ? undefined : integer(value.status, 599);
  const ready = value.ready;
  assert(ready === undefined || typeof ready === "boolean", "Invalid desktop readiness state");
  assert(
    value.failing === undefined || (Array.isArray(value.failing) && value.failing.length <= 8),
    "Invalid desktop readiness failures",
  );
  return {
    attempt: integer(value.attempt),
    phase: category(value.phase, ["headers", "body", "complete"]),
    elapsedMs: integer(value.elapsedMs),
    outcome:
      error ??
      (ready && status !== undefined && status >= 200 && status < 300 ? "ready" : "not-ready"),
    ...(status === undefined ? {} : { status }),
    ...(ready === undefined ? {} : { ready }),
    ...(error === undefined ? {} : { error }),
    ...(Array.isArray(value.failing)
      ? {
          failing: value.failing.map((reason) =>
            category(reason, [
              "startup-sidecars",
              "gateway-draining",
              "state-database",
              "internal",
              "other",
            ]),
          ),
          omittedFailing: integer(value.omittedFailing),
        }
      : {}),
  };
}

function logTail(value: unknown) {
  assert(typeof value === "string" && value.length <= 256 * 1024, "Invalid desktop readiness log");
  // Redact whole multi-line credentials before taking a tail that could split them.
  return redactTextForSupport(value)
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .slice(-20)
    .map((line) =>
      /\b(?:models?|modelId|model_id)\b/iu.test(line)
        ? "[model diagnostic omitted]"
        : redactSupportDiagnosticLine(line, { env: {}, stateDir: "" }, 300),
    );
}

/** Project only probe facts and support-redacted log tails; never copy arbitrary task metadata. */
export function desktopGatewayReadiness(value: unknown) {
  assert(Array.isArray(value) && value.length <= 2, "Invalid desktop readiness attempts");
  return value.map((entry) => {
    assert(
      isRecord(entry) && entry.probe === "GET /readyz" && isRecord(entry.child),
      "Invalid desktop readiness diagnostic",
    );
    assert(
      Array.isArray(entry.probes) && entry.probes.length <= 8192,
      "Invalid desktop readiness history",
    );
    const startedAtMs = integer(entry.startedAtMs);
    const deadlineMs = integer(entry.deadlineMs);
    assert(deadlineMs >= startedAtMs, "Invalid desktop readiness deadline");
    const attempts = integer(entry.attempts);
    const omittedProbes = integer(entry.omittedProbes);
    assert(
      attempts === entry.probes.length + omittedProbes,
      "Incomplete desktop readiness history",
    );
    const outcome = category(entry.outcome, ["ready", "timeout", "child-exit", "aborted"]);
    assert(entry.logs === null || isRecord(entry.logs), "Invalid desktop readiness logs");
    return {
      probe: "GET /readyz" as const,
      startedAtMs,
      deadlineMs,
      elapsedMs: integer(entry.elapsedMs),
      outcome,
      attempts,
      probes: entry.probes.map((item) => {
        assert(isRecord(item), "Invalid desktop readiness probe");
        return {
          ...probe(item),
          startedAtMs: integer(item.startedAtMs),
          deadlineMs: integer(item.deadlineMs),
        };
      }),
      omittedProbes,
      lastProbe: entry.lastProbe === null ? null : probe(entry.lastProbe),
      child: {
        exitCode: entry.child.exitCode === null ? null : integer(entry.child.exitCode, 255),
        signalCode:
          entry.child.signalCode === null
            ? null
            : category(entry.child.signalCode, Object.keys(constants.signals)),
      },
      logs:
        entry.logs === null
          ? null
          : { stdout: logTail(entry.logs.stdout), stderr: logTail(entry.logs.stderr) },
    };
  });
}

export function desktopReadinessLines(
  carrier: "node" | "ssh",
  entries: ReturnType<typeof desktopGatewayReadiness>,
) {
  return entries.flatMap((entry) => {
    const prefix = `[desktop-resize-proof] test-${carrier} gateway-start`;
    const summary = `${prefix} ${entry.outcome} elapsed=${entry.elapsedMs}ms`;
    return entry.outcome === "ready"
      ? [summary]
      : [
          `${summary} startedAtMs=${entry.startedAtMs} deadlineMs=${entry.deadlineMs} attempts=${entry.attempts} lastProbe=${JSON.stringify(entry.lastProbe)} child=${JSON.stringify(entry.child)}`,
          ...Object.entries(entry.logs ?? {}).flatMap(([stream, lines]) =>
            lines.map((line) => `${prefix} ${stream}: ${line}`),
          ),
        ];
  });
}

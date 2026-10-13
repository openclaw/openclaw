import { setTimeout as sleep } from "node:timers/promises";
import { readBoundedResponseText } from "./bounded-response.mjs";

export function isClawHubPublishAttemptId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/u.test(value);
}

// A legacy router returns version JSON here. Only a missing state permits fallback;
// a new server's unknown or malformed state must never authorize another publish.
export function classifyClawHubPublication(body, { name, version }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`Invalid ClawHub publication state for ${name}@${version}.`);
  }
  if (!Object.hasOwn(body, "state")) {
    return null;
  }
  const { state, stage, attemptId, recoverable, ...identity } = body;
  let fields;
  switch (state) {
    case "published":
    case "absent":
      fields = [];
      break;
    case "pending":
      fields = ["stage", "attemptId"];
      if (
        !["staging", "checks", "finalization"].includes(stage) ||
        (stage === "staging"
          ? Object.hasOwn(body, "attemptId")
          : !isClawHubPublishAttemptId(attemptId))
      ) {
        fields = null;
      }
      break;
    case "failed":
      fields = typeof recoverable === "boolean" ? ["recoverable", "attemptId"] : null;
      break;
  }
  if (
    !fields ||
    identity.name !== name ||
    identity.version !== version ||
    Object.keys(body).some((key) => !["name", "version", "state", ...fields].includes(key)) ||
    (Object.hasOwn(body, "attemptId") && !isClawHubPublishAttemptId(attemptId))
  ) {
    throw new Error(`Invalid ClawHub publication state for ${name}@${version}.`);
  }
  const { name: _name, version: _version, ...publication } = body;
  return publication;
}

// The scheduled ClawHub worker owns scans and finalization. Observation must
// neither resubmit bytes nor follow a replacement for a sealed original attempt.
export async function waitForClawHubPublicVersion(entry, { deadline, fetchImpl, onState }) {
  const url = `https://clawhub.ai/api/v1/packages/${encodeURIComponent(entry.name)}/versions/${encodeURIComponent(entry.version)}/publication`;
  for (;;) {
    const remaining = deadline - Date.now();
    // Earlier batches can use the wait budget while later attempts are already
    // public. Always read once; the deadline stops waiting, not completion proof.
    const readBudget = remaining > 0 ? Math.min(60_000, remaining) : 60_000;
    const signal = AbortSignal.timeout(readBudget);
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (!response.ok) {
      throw new Error(`ClawHub publication read returned HTTP ${response.status}.`);
    }
    const body = JSON.parse(
      await readBoundedResponseText(response, "ClawHub publication", 256 * 1024, { signal }),
    );
    const publication = classifyClawHubPublication(body, entry);
    if (!publication) {
      throw new Error(`ClawHub did not return authoritative publication state: ${entry.name}.`);
    }
    onState(publication);
    if (publication.state === "published") {
      return;
    }
    if (publication.attemptId !== entry.attemptId) {
      throw new Error(`ClawHub publication changed the sealed attempt: ${entry.name}.`);
    }
    if (publication.state !== "pending") {
      throw new Error(`ClawHub publication ${publication.state}: ${entry.name}.`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `ClawHub publication remains pending: ${entry.name}@${entry.version}, attempt ${entry.attemptId ?? "unavailable"}. Retry postpublish verification, not publication.`,
      );
    }
    await sleep(Math.min(10_000, Math.max(0, deadline - Date.now())));
  }
}

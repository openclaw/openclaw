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

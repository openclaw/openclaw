import { Value } from "typebox/value";
import { expect, it } from "vitest";
import { isSessionGitHubReadinessResult } from "./compiled/protocol.generated/predicates.js";
import { SessionGitHubReadinessResultSchema } from "./schema/session-github-publication.js";

it.each([
  { status: "requested" },
  { status: "publishing" },
  {
    status: "published",
    url: "https://github.com/example/project/pull/1",
    repository: "example/project",
    branch: "feature",
    headCommit: "a".repeat(40),
  },
  { status: "failed", code: "unavailable" },
])("closes the $status readiness receipt in source and compiled validation", (fields) => {
  const receipt = { requestId: "existing-request", ...fields };
  const result = {
    policy: { read: "admitted", write: "unknown" },
    custody: { kind: "unbound_workspace" },
    target: { kind: "unknown", reason: "not-qualified" },
    request: { kind: "observed", selection: "exact", receipt },
    remedies: [],
  };
  const checks = [
    (value: unknown) => Value.Check(SessionGitHubReadinessResultSchema, value),
    isSessionGitHubReadinessResult,
  ];
  for (const check of checks) {
    expect(check(result)).toBe(true);
    for (const property of ["publisher", "message", "nextAction", "confirmation", "unexpected"]) {
      expect(
        check({
          ...result,
          request: {
            ...result.request,
            receipt: { ...receipt, [property]: "not a readiness fact" },
          },
        }),
        property,
      ).toBe(false);
    }
  }
});

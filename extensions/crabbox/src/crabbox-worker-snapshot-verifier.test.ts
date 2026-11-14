import { expect, it } from "vitest";
import { crabboxProjectSnapshotFailure } from "./crabbox-worker-snapshot-verifier.js";

it("preserves closed cache diagnostics without accepting raw verifier output", () => {
  const diagnostic = {
    schema: "openclaw.project-snapshot-diagnostic.v1",
    cacheCheck: "cache-path",
    cacheKind: "manifests",
    path: "/private/fixture",
    content: "synthetic private data",
  };
  expect(crabboxProjectSnapshotFailure(JSON.stringify(diagnostic)).message).toContain(
    "cache-path/manifests",
  );
  for (const stderr of [
    JSON.stringify(diagnostic),
    JSON.stringify({ ...diagnostic, cacheKind: "/private/fixture" }),
    JSON.stringify({ ...diagnostic, cacheCheck: "synthetic private data" }),
    "raw verifier output /private/fixture",
    "x".repeat(513),
  ]) {
    expect(crabboxProjectSnapshotFailure(stderr).message).not.toMatch(
      /private|fixture|synthetic|raw verifier/,
    );
  }
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ready, build, descriptor, invoke } from "./retained-repair-lifecycle-test-support.mjs";

export function retirementFixture(t, f = ready(t)) {
  const installed = dirname(f.library);
  const replacement = directory => {
    mkdirSync(directory, { mode: 0o755 });
    return ["openclaw-release-deploy", "release-lib.mjs", "gateway-suspension-contract.mjs", "startup-profile.mjs"].map((name, index) => {
      copyFileSync(join(installed, name), join(directory, name));
      chmodSync(join(directory, name), index ? 0o644 : 0o755);
      return descriptor(join(directory, name));
    });
  };
  const request = { version: 1, operation: randomUUID(), source: descriptor(f.journal),
    oldClosure: ["openclaw-release-deploy", "release-lib.mjs", "gateway-suspension-contract.mjs", "startup-profile.mjs"].map(name => descriptor(join(installed, name))),
    replacement: replacement(join(f.root, "first-approved")) };
  f.library = request.replacement[1].path;
  const prepared = invoke(f, "retained-controller-adoption", "prepare", request);
  assert.equal(prepared.status, 0, prepared.stderr);
  const applied = invoke(f, "retained-controller-adoption", "apply", JSON.parse(prepared.stdout));
  assert.equal(applied.status, 0, applied.stderr);
  f.library = f.env.OPENCLAW_TEAM_RELEASE_LIB;
  build(f, "begin", f.request);
  f.retirementRequest = { adoption: { ...request, operation: randomUUID(),
    oldClosure: JSON.parse(applied.stdout).closure, replacement: replacement(join(f.root, "next-approved")) },
    buildIntent: descriptor(f.prefix + ".build-intent.json") };
  f.retirementRunner = f.retirementRequest.adoption.replacement[1].path;
  f.archive = join(f.serving, "journal", "retired-build-" + f.request.operation);
  f.retirementOriginals = ["build-intent", "build-original", "build-witness"].map(suffix => {
    const path = f.prefix + "." + suffix + ".json";
    return { path, bytes: readFileSync(path), descriptor: descriptor(path) };
  });
  return f;
}
export function retire(f, action = "retire-build", request = f.retirementRequest, preload) {
  const installed = f.library;
  f.library = f.retirementRunner;
  try { return invoke(f, "retained-controller-adoption", action, request, preload); }
  finally { f.library = installed; }
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ready, invoke, descriptor } from "./retained-repair-lifecycle-test-support.mjs";
import { reconcileConfig } from "./retained-repair-test-support.mjs";
import { names } from "./retained-controller-adoption-test-support.mjs";
import { runOwner } from "./worker-config-owner-fixture.mjs";

export function historicalShellFixture(t, { laterClosure = true, historical = true } = {}) {
  const f = ready(t);
  f.owner = f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE;
  // The shell and library are unchanged; only external service/build IO is synthetic.
  const systemctl = f.commandPaths.systemctl, wrapper = join(f.root, "systemctl-prepare");
  writeFileSync(wrapper, `#!/usr/bin/env bash\nset -euo pipefail
if [[ "$2" == openclaw-hourly-update.timer || "$2" == openclaw-nightly-update.timer ]]; then
  case "$1" in is-enabled) echo disabled; exit 1;; is-active) echo inactive; exit 3;; esac
fi
exec '${systemctl}' "$@"\n`, { mode: 0o755 });
  Object.assign(f.env, { OPENCLAW_TEAM_SYSTEMCTL: wrapper, OPENCLAW_TEAM_BUSCTL: f.commandPaths.busctl, OPENCLAW_TEAM_SS: f.commandPaths.ss });
  writeFileSync(join(dirname(systemctl), "git"), `#!/usr/bin/env bash\nset -euo pipefail
for arg in "$@"; do if [[ "$arg" == fetch ]]; then exit 0; fi; done
exec /usr/bin/git "$@"\n`, { mode: 0o755 });
  f.configSha = reconcileConfig(f);
  const current = readFileSync(f.journal), installed = dirname(f.library);
  if (historical) writeFileSync(f.journal, JSON.stringify({ ...f.record, createdAt: "2026-10-30T04:00:00.000Z" }) + "\n");
  const old = adopt(f);
  if (historical) {
    writeFileSync(f.journal + ".next", current, { mode: 0o600 });
    renameSync(f.journal + ".next", f.journal);
  }
  if (historical && laterClosure) for (const [index, name] of names.entries()) {
    const path = join(installed, name);
    writeFileSync(path + ".next", Buffer.concat([readFileSync(path), Buffer.from(index ? "\n// later audited revision\n" : "\n# later audited revision\n")]), { mode: index ? 0o644 : 0o755 });
    renameSync(path + ".next", path);
  }
  f.historical = { gate: descriptor(join(dirname(f.journal), "controller-adoption.json")), complete: old.adoption.complete };
  f.before = preserved(f);
  return f;
}

export function adoptionRequest(f, historical) {
  const stage = join(f.root, "approved-" + randomUUID());
  mkdirSync(stage, { mode: 0o755 });
  for (const [index, name] of names.entries()) {
    copyFileSync(join(import.meta.dirname, name), join(stage, name));
    chmodSync(join(stage, name), index ? 0o644 : 0o755);
  }
  const installed = dirname(f.env.OPENCLAW_TEAM_RELEASE_LIB);
  return { version: 1, operation: randomUUID(), source: descriptor(f.journal),
    oldClosure: names.map(name => descriptor(join(installed, name))), replacement: names.map(name => descriptor(join(stage, name))),
    ...(historical ? { historical } : {}) };
}

export function adopt(f, historical) {
  const request = adoptionRequest(f, historical), installedLibrary = f.env.OPENCLAW_TEAM_RELEASE_LIB;
  f.library = request.replacement[1].path;
  try {
    const prepared = invoke(f, "retained-controller-adoption", historical ? "historical-successor" : "prepare", request);
    assert.equal(prepared.status, 0, prepared.stderr);
    const applied = invoke(f, "retained-controller-adoption", "apply", JSON.parse(prepared.stdout));
    assert.equal(applied.status, 0, applied.stderr);
    return JSON.parse(applied.stdout);
  } finally { f.library = installedLibrary; }
}

export function prepare(f, operation = randomUUID()) {
  return runOwner(f, ["--prepare-retained-repair", operation, f.request.target.sha, f.record.candidate.sha,
    f.pid, f.start, descriptor(f.journal).sha256, f.configSha]);
}

export function preserved(f) {
  return { journal: descriptor(f.journal), lock: descriptor(f.lockFile), config: descriptor(f.config),
    pointers: ["current", "previous"].map(name => readlinkSync(join(f.serving, name))) };
}

// Read-only acquisition benchmark; never invokes a build, model, or store API.
// node --import ./scripts/tsx.mjs scripts/bench-android-release-history.mts --remote <URL> --source <SHA> --baseline-ref <public-ref>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { parse } from "yaml";
import {
  collectReleaseInventory,
  collectSelectedReleaseEvidence,
} from "./lib/mobile-release-evidence.ts";
import { parseStrictIntegerOption } from "./lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    remote: { type: "string" },
    source: { type: "string" },
    base: { type: "string", default: "origin/main" },
    "baseline-ref": { type: "string", multiple: true, default: [] },
    samples: { type: "string", default: "5" },
  },
});
if (!values.remote || !values.source) {
  throw new Error("Use --remote <URL> --source <SHA> [--base <ref>] [--baseline-ref <ref> ...].");
}
const samples = parseStrictIntegerOption({
  raw: values.samples,
  label: "--samples",
  min: 1,
  fallback: 5,
});
const sourceSha = values.source;
const remote = values.remote;
const workflow = ".github/workflows/android-store-release.yml";
const root = process.cwd();
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
function historyStep(text: string): string {
  const steps: { name: string; run?: string }[] = parse(text).jobs.release.steps;
  const step = steps.find(({ name }) => name === "Fetch release source history")?.run;
  assert.ok(step, "Missing release history step");
  return step;
}
const commands = {
  baseline: historyStep(git(root, "show", `${values.base}:${workflow}`)),
  candidate: historyStep(fs.readFileSync(path.join(root, workflow), "utf8")),
};
const results: { variant: string; historySeconds: number; totalSeconds: number; bytes: number }[] =
  [];
let expectedEvidence: string | undefined;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "android-release-history-bench-"));
console.log(
  JSON.stringify({
    sourceSha,
    base: git(root, "rev-parse", values.base),
    samples,
    state: "fresh-object-store",
    host: {
      platform: process.platform,
      cpus: os.availableParallelism(),
      load: os.loadavg(),
      freeBytes: os.freemem(),
    },
  }),
);
try {
  for (let sample = 1; sample <= samples; sample++) {
    for (const [variant, command] of Object.entries(commands)) {
      const checkout = path.join(temporary, `${sample}-${variant}`);
      fs.mkdirSync(checkout);
      try {
        git(checkout, "init");
        git(checkout, "remote", "add", "origin", remote);
        git(checkout, "fetch", "--no-tags", "--depth=1", "origin", sourceSha);
        git(checkout, "checkout", "--detach", sourceSha);
        const start = performance.now();
        execFileSync("/bin/bash", ["-c", command], {
          cwd: checkout,
          env: { ...process.env, GITHUB_SHA: sourceSha },
          stdio: ["ignore", "pipe", "pipe"],
        });
        const historySeconds = (performance.now() - start) / 1000;
        git(checkout, "fetch", "--no-tags", "origin", "refs/heads/main");
        git(checkout, "merge-base", "--is-ancestor", sourceSha, "FETCH_HEAD");
        const evidence = values["baseline-ref"].map((ref) => {
          git(checkout, "fetch", "--no-tags", "origin", ref);
          const source = {
            rootDir: checkout,
            platform: "android" as const,
            baseline: git(checkout, "rev-parse", "FETCH_HEAD"),
            source: sourceSha,
            deadline: Date.now() + 5 * 60_000,
          };
          const inventory = collectReleaseInventory(source);
          const selected = inventory.files.slice(0, 10).map(({ id }) => ({ id, focus: [] }));
          return {
            ref,
            inventory,
            evidence: collectSelectedReleaseEvidence(source, inventory, selected),
          };
        });
        const evidenceSha256 = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
        expectedEvidence ??= evidenceSha256;
        assert.equal(evidenceSha256, expectedEvidence, "Release-note evidence changed");
        assert.equal(git(checkout, "rev-parse", "HEAD"), sourceSha);
        assert.equal(git(checkout, "status", "--porcelain"), "");
        const counts = git(checkout, "count-objects", "-v");
        const packedKiB = Number(/^size-pack: (\d+)$/mu.exec(counts)?.[1]);
        const looseKiB = Number(/^size: (\d+)$/mu.exec(counts)?.[1]);
        const result = {
          variant,
          historySeconds,
          totalSeconds: (performance.now() - start) / 1000,
          bytes: (packedKiB + looseKiB) * 1024,
        };
        results.push(result);
        console.log(JSON.stringify({ sample, ...result, evidenceSha256 }));
      } finally {
        fs.rmSync(checkout, { recursive: true, force: true });
      }
    }
  }
  for (const variant of Object.keys(commands)) {
    const rows = results.filter((row) => row.variant === variant);
    const summary = Object.fromEntries(
      (["historySeconds", "totalSeconds", "bytes"] as const).map((key) => {
        const sorted = rows.map((row) => row[key]).toSorted((a, b) => a - b);
        return [
          key,
          {
            min: sorted[0],
            median: sorted[Math.floor(sorted.length / 2)],
            p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
            max: sorted.at(-1),
          },
        ];
      }),
    );
    console.log(JSON.stringify({ variant, samples, summary }));
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

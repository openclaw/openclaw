// Read-only acquisition benchmark; never invokes a build, model, or store API.
// node --import ./scripts/tsx.mjs scripts/bench-android-release-history.mts --platform ios --remote <URL> --source <SHA> --base <SHA> --baseline-ref <public-ref>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  collectReleaseInventory,
  collectSelectedReleaseEvidence,
} from "./lib/mobile-release-evidence.ts";
import { parseStrictIntegerOption } from "./lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    platform: { type: "string", default: "android" },
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
const platform = values.platform;
if (platform !== "ios" && platform !== "android") {
  throw new Error("--platform must be ios or android.");
}
const root = process.cwd();
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}
const results: {
  variant: string;
  historySeconds: number;
  totalSeconds: number;
  bytes: number;
  commits: number;
  objects: number;
}[] = [];
let expectedEvidence: string | undefined;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-release-history-bench-"));
// Load the committed baseline collector, so equality is independent of the candidate.
fs.writeFileSync(
  path.join(temporary, "baseline.ts"),
  git(root, "show", `${values.base}:scripts/lib/mobile-release-evidence.ts`),
);
fs.symlinkSync(path.join(root, "node_modules"), path.join(temporary, "node_modules"), "dir");
const baselineCollector: typeof import("./lib/mobile-release-evidence.ts") = await import(
  pathToFileURL(path.join(temporary, "baseline.ts")).href
);
const collectors = {
  baseline: baselineCollector,
  candidate: { collectReleaseInventory, collectSelectedReleaseEvidence },
};
console.log(
  JSON.stringify({
    sourceSha,
    platform,
    baselines: values["baseline-ref"],
    base: git(root, "rev-parse", values.base),
    samples,
    state: "fresh-filtered-object-store; endpoint reads without checkout",
    diffHashDigits: 12,
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
    for (const [variant, collector] of Object.entries(collectors)) {
      const checkout = path.join(temporary, `${sample}-${variant}`);
      fs.mkdirSync(checkout);
      try {
        git(checkout, "init");
        // Auto abbreviation changes with object count; hold patch formatting constant.
        git(checkout, "config", "core.abbrev", "12");
        git(checkout, "remote", "add", "origin", remote);
        git(checkout, "fetch", "--no-tags", "--filter=blob:none", "--depth=1", "origin", sourceSha);
        git(checkout, "update-ref", "--no-deref", "HEAD", sourceSha);
        const start = performance.now();
        if (variant === "baseline") {
          git(
            checkout,
            "fetch",
            "--no-tags",
            "--filter=blob:none",
            "--unshallow",
            "origin",
            sourceSha,
          );
        }
        const evidence = values["baseline-ref"].map((ref) => {
          const shallow = git(checkout, "rev-parse", "--is-shallow-repository") === "true";
          git(
            checkout,
            "fetch",
            "--no-tags",
            "--refmap=",
            ...(shallow ? ["--filter=blob:none", "--depth=1"] : []),
            "origin",
            ref,
          );
          const source: Parameters<typeof collectReleaseInventory>[0] = {
            rootDir: checkout,
            platform,
            baseline: git(checkout, "rev-parse", "FETCH_HEAD"),
            source: sourceSha,
            deadline: Date.now() + 5 * 60_000,
          };
          const inventory = collector.collectReleaseInventory(source);
          const selected = inventory.files.slice(0, 10).map(({ id }) => ({ id, focus: [] }));
          return { ref, source, inventory, selected };
        });
        const historySeconds = (performance.now() - start) / 1000;
        const selectedEvidence = evidence.map(({ ref, source, inventory, selected }) => ({
          ref,
          inventory,
          evidence: collector.collectSelectedReleaseEvidence(source, inventory, selected),
        }));
        const totalSeconds = (performance.now() - start) / 1000;
        const evidenceSha256 = createHash("sha256")
          .update(JSON.stringify(selectedEvidence))
          .digest("hex");
        expectedEvidence ??= evidenceSha256;
        assert.equal(evidenceSha256, expectedEvidence, "Release-note evidence changed");
        assert.equal(git(checkout, "rev-parse", "HEAD"), sourceSha);
        assert.equal(git(checkout, "for-each-ref", "--format=%(refname)"), "");
        const counts = git(checkout, "count-objects", "-v");
        const packedKiB = Number(/^size-pack: (\d+)$/mu.exec(counts)?.[1]);
        const looseKiB = Number(/^size: (\d+)$/mu.exec(counts)?.[1]);
        const result = {
          variant,
          historySeconds,
          totalSeconds,
          commits: git(checkout, "cat-file", "--batch-all-objects", "--batch-check=%(objecttype)")
            .split("\n")
            .filter((type) => type === "commit").length,
          objects:
            Number(/^count: (\d+)$/mu.exec(counts)?.[1]) +
            Number(/^in-pack: (\d+)$/mu.exec(counts)?.[1]),
          bytes: (packedKiB + looseKiB) * 1024,
        };
        results.push(result);
        console.log(JSON.stringify({ sample, ...result, evidenceSha256 }));
      } finally {
        fs.rmSync(checkout, { recursive: true, force: true });
      }
    }
  }
  for (const variant of Object.keys(collectors)) {
    const rows = results.filter((row) => row.variant === variant);
    const summary = Object.fromEntries(
      (["historySeconds", "totalSeconds", "bytes", "commits", "objects"] as const).map((key) => {
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

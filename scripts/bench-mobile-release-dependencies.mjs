// Nonpublishing, opt-in benchmark. Run from a clean, committed checkout:
// node scripts/bench-mobile-release-dependencies.mjs --samples 5
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { samples: { type: "string", default: "5" } } });
const samples = Number(values.samples);
assert(Number.isSafeInteger(samples) && samples >= 5, "Use at least five interleaved samples.");
const root = process.cwd();
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-release-dependencies-bench-"));
const source = path.join(temporary, "source");
const rows = [];
function run(command, args, cwd = source, env = process.env) {
  return execFileSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
const sha = run("git", ["rev-parse", "HEAD"], root).trim();
assert.equal(run("git", ["status", "--porcelain"], root).trim(), "", "Commit the workload first.");
console.log(
  JSON.stringify({
    sha,
    samples,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    rule: "same generated assets; >=25% fewer packages; >=20% lower cold install+consumer median; no >20% p95 regression in either store state",
    storeStates: [
      "empty pnpm store/cache, absent node_modules",
      "same store/cache, absent node_modules",
    ],
  }),
);
let expectedOutputs;
try {
  run("git", ["clone", "--shared", "--no-checkout", root, source], root);
  run("git", ["checkout", "--detach", sha]);
  const modules = run("git", ["ls-files", "package.json", "**/package.json"])
    .trim()
    .split("\n")
    .map((file) => path.join(path.dirname(file), "node_modules"));
  const outputs = [
    "apps/shared/OpenClawKit/.build/protocol",
    "apps/android/app/build/generated/openclaw-protocol",
    "apps/shared/mermaid/assets/mermaid",
  ];
  const generated = [
    ...outputs,
    "apps/shared/mermaid/assets/apple-build-inputs.json",
    "apps/shared/OpenClawKit/Sources/OpenClawChatUI/Resources/Mermaid",
  ];
  for (let sample = 1; sample <= samples; sample++) {
    for (const variant of ["baseline", "candidate"]) {
      const store = path.join(temporary, `${sample}-${variant}`);
      const env = {
        ...process.env,
        CI: "true",
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        PNPM_CONFIG_STORE_DIR: path.join(store, "store"),
        PNPM_CONFIG_CACHE_DIR: path.join(store, "cache"),
        NODE_BIN: path.dirname(process.execPath),
        GITHUB_WORKSPACE: source,
        FROZEN_LOCKFILE: "true",
        DEPENDENCY_CACHE: "false",
        DEPENDENCY_CACHE_HIT: "false",
      };
      for (const state of ["cold", "warm"]) {
        for (const directory of [...modules, ...generated]) {
          fs.rmSync(path.join(source, directory), { recursive: true, force: true });
        }
        const load = os.loadavg();
        const freeBytes = os.freemem();
        const start = performance.now();
        if (variant === "baseline") {
          run("/bin/bash", [".github/actions/setup-node-env/install-dependencies.sh"], source, env);
        } else {
          run(process.execPath, ["scripts/install-mobile-release-dependencies.mjs"], source, env);
        }
        const installSeconds = (performance.now() - start) / 1000;
        // Real consumers; no model, signing, or store API calls.
        const node = (...args) => run(process.execPath, args, source, env);
        node("scripts/mobile-release.mjs", "--help");
        node(
          "--input-type=module",
          "-e",
          'import OpenAI from "openai"; import { zodTextFormat } from "openai/helpers/zod"; import { z } from "zod"; new OpenAI({apiKey:"not-a-real-key"}); zodTextFormat(z.object({notes:z.string()}),"notes");',
        );
        node("--import", "tsx", "scripts/ios-version.ts", "--json");
        node("--import", "./scripts/tsx.mjs", "scripts/android-version.ts", "--json");
        node("scripts/prepare-native-protocol.mjs", "--language", "all", "--check");
        node("scripts/android-app-i18n.ts", "generate");
        node("scripts/prepare-apple-mermaid.mjs");
        const totalSeconds = (performance.now() - start) / 1000;
        const hash = createHash("sha256");
        function hashTree(relative) {
          for (const entry of fs
            .readdirSync(path.join(source, relative), { withFileTypes: true })
            .toSorted((a, b) => a.name.localeCompare(b.name, "en"))) {
            if (entry.name === ".cache") {
              continue;
            }
            const file = path.join(relative, entry.name);
            if (entry.isDirectory()) {
              hashTree(file);
            } else {
              hash.update(file).update(fs.readFileSync(path.join(source, file)));
            }
          }
        }
        outputs.forEach(hashTree);
        const outputHash = hash.digest("hex");
        expectedOutputs ??= outputHash;
        assert.equal(
          outputHash,
          expectedOutputs,
          "Generated protocol and Mermaid outputs changed.",
        );
        const packages = fs
          .readdirSync(path.join(source, "node_modules/.pnpm"), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== "node_modules").length;
        const kib = Number(run("du", ["-sk", path.join(source, "node_modules")]).split(/\s+/)[0]);
        const row = {
          sample,
          variant,
          state,
          packages,
          kib,
          installSeconds,
          totalSeconds,
          load,
          freeBytes,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
      fs.rmSync(store, { recursive: true, force: true });
    }
  }
  for (const state of ["cold", "warm"]) {
    for (const variant of ["baseline", "candidate"]) {
      const selected = rows.filter((row) => row.state === state && row.variant === variant);
      const summary = {};
      for (const key of ["packages", "kib", "installSeconds", "totalSeconds"]) {
        const sorted = selected.map((row) => row[key]).toSorted((a, b) => a - b);
        summary[key] = {
          min: sorted[0],
          median: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          max: sorted.at(-1),
        };
      }
      console.log(JSON.stringify({ summary: true, state, variant, ...summary }));
    }
  }
} catch (error) {
  console.error(error.stderr?.toString() ?? error);
  process.exitCode = 1;
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

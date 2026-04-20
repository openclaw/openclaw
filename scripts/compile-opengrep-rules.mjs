#!/usr/bin/env node
/**
 * compile-opengrep-rules.mjs
 *
 * Compiles per-case OpenGrep rules from a GHSA detector-review run into two
 * super-config YAMLs (precise + broad) under security/opengrep/, plus a
 * compile-manifest.json with full traceability back to each source advisory.
 *
 * Usage:
 *   node scripts/compile-opengrep-rules.mjs --run-dir <path> [--out-dir <path>]
 *
 * Inputs:
 *   --run-dir <path>   Required. A run dir produced by run-ghsa-detector-review-batch.mjs
 *                      (e.g. .artifacts/ghsa-detector-review-runs/<run-id>/).
 *   --out-dir <path>   Optional. Default: <repo>/security/opengrep/.
 *
 * Outputs (idempotent; overwrites existing):
 *   <out-dir>/precise.yml              Super-config of all general/precise rules
 *   <out-dir>/broad.yml                Super-config of all broad/review-aid rules
 *   <out-dir>/compile-manifest.json    Per-rule provenance map
 *
 * Each rule's id is rewritten to `ghsa-detector.<ghsa-lower>.<original-id>`
 * (ASCII-sanitized). Each rule's metadata is augmented with:
 *   - ghsa: "GHSA-xxxx-xxxx-xxxx"
 *   - advisory-url: github.com/<owner>/<repo>/security/advisories/<GHSA>
 *   - detector-bucket: "precise" | "broad"
 *   - source-run: "<run-id>"
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDocument, stringify } from "yaml";

const REPO_BASENAME = "openclaw/openclaw";

function printHelp() {
  console.log(`Usage: node scripts/compile-opengrep-rules.mjs --run-dir <path> [options]

Options:
  --run-dir <path>     Required. Detector-review run directory.
  --out-dir <path>     Output directory (default: <repo>/security/opengrep).
  --advisory-repo <r>  GitHub owner/repo used in advisory-url metadata.
                       Default: ${REPO_BASENAME}
  --help               Show this help.
`);
}

function parseArgs(argv) {
  const opts = {
    runDir: "",
    outDir: "",
    advisoryRepo: REPO_BASENAME,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--run-dir":
        opts.runDir = path.resolve(argv[i + 1] ?? "");
        i += 1;
        break;
      case "--out-dir":
        opts.outDir = path.resolve(argv[i + 1] ?? "");
        i += 1;
        break;
      case "--advisory-repo":
        opts.advisoryRepo = argv[i + 1] ?? REPO_BASENAME;
        i += 1;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!opts.runDir) {
    printHelp();
    throw new Error("--run-dir is required");
  }
  return opts;
}

function sanitizeIdComponent(value) {
  // Opengrep rule ids should be ASCII; allow [a-zA-Z0-9._-].
  return (
    String(value || "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "rule"
  );
}

function ghsaLower(ghsa) {
  return String(ghsa || "").toLowerCase();
}

function buildAdvisoryUrl(advisoryRepo, ghsa) {
  return `https://github.com/${advisoryRepo}/security/advisories/${ghsa}`;
}

// NOTE on test-file exclusion: we used to inject a long `paths.exclude`
// list into every compiled rule. That added ~16k lines of YAML noise across
// the compiled rulepacks and duplicated the list in workflow `--exclude`
// flags. Both have been replaced by a single `.semgrepignore` file at the
// repo root, which opengrep picks up automatically. If you need to scan
// from a directory other than the repo root, use opengrep's
// `--project-root` (experimental) or run `scripts/run-opengrep.sh`.

function rewriteRule(rule, params) {
  const originalId = String(rule.id ?? "rule");
  const newId = `ghsa-detector.${ghsaLower(params.ghsa)}.${sanitizeIdComponent(originalId)}`;
  const metadata = { ...rule.metadata };
  metadata.ghsa = params.ghsa;
  metadata["advisory-url"] = params.advisoryUrl;
  metadata["detector-bucket"] = params.bucket;
  metadata["source-run"] = params.sourceRun;
  metadata["source-rule-id"] = originalId;
  return { ...rule, id: newId, metadata };
}

async function readRuleFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return { rules: [], error: null }; // file doesn't exist; that's fine
  }
  if (!raw.trim()) {
    return { rules: [], error: null };
  }
  let doc;
  try {
    doc = parseDocument(raw, { keepSourceTokens: false });
  } catch (error) {
    return { rules: [], error: `parse-error: ${error.message}` };
  }
  if (doc.errors && doc.errors.length > 0) {
    return { rules: [], error: `yaml-errors: ${doc.errors.map((e) => e.message).join("; ")}` };
  }
  const data = doc.toJSON();
  if (!data || !Array.isArray(data.rules)) {
    return { rules: [], error: "no-rules-array" };
  }
  return { rules: data.rules, error: null };
}

async function listCases(runDir) {
  const casesDir = path.join(runDir, "cases");
  let entries;
  try {
    entries = await fs.readdir(casesDir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Run dir does not contain cases/: ${casesDir}`, { cause: error });
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .toSorted();
}

function ghsaIdFromSlug(slug) {
  return slug.toUpperCase();
}

function caseRuleDir(runDir, caseSlug) {
  // The agent writes artifacts under .tmp/ghsa-detector-review/<slug>/opengrep/.
  return path.join(runDir, "cases", caseSlug, ".tmp", "ghsa-detector-review", caseSlug, "opengrep");
}

async function compile(opts) {
  const runId = path.basename(opts.runDir);
  const cases = await listCases(opts.runDir);

  const buckets = {
    precise: { rules: [], skipped: [] },
    broad: { rules: [], skipped: [] },
  };
  const manifest = {
    runId,
    runDir: opts.runDir,
    advisoryRepo: opts.advisoryRepo,
    generatedAt: new Date().toISOString(),
    totals: {},
    cases: {},
  };

  for (const slug of cases) {
    const ghsa = ghsaIdFromSlug(slug);
    const advisoryUrl = buildAdvisoryUrl(opts.advisoryRepo, ghsa);
    const ruleDir = caseRuleDir(opts.runDir, slug);

    const caseEntry = { precise: [], broad: [], errors: {} };

    for (const [bucket, fileName] of [
      ["precise", "general-rule.yml"],
      ["broad", "broad-rule.yml"],
    ]) {
      const filePath = path.join(ruleDir, fileName);
      const { rules, error } = await readRuleFile(filePath);
      if (error) {
        buckets[bucket].skipped.push({ ghsa, file: filePath, error });
        caseEntry.errors[bucket] = error;
        continue;
      }
      for (const rule of rules) {
        const rewritten = rewriteRule(rule, {
          ghsa,
          advisoryUrl,
          bucket,
          sourceRun: runId,
        });
        buckets[bucket].rules.push(rewritten);
        caseEntry[bucket].push(rewritten.id);
      }
    }

    if (
      caseEntry.precise.length ||
      caseEntry.broad.length ||
      Object.keys(caseEntry.errors).length
    ) {
      manifest.cases[ghsa] = caseEntry;
    }
  }

  manifest.totals = {
    cases: cases.length,
    casesWithAnyRule: Object.keys(manifest.cases).length,
    preciseRules: buckets.precise.rules.length,
    broadRules: buckets.broad.rules.length,
    preciseSkipped: buckets.precise.skipped.length,
    broadSkipped: buckets.broad.skipped.length,
  };

  return { buckets, manifest };
}

function buildBucketHeader(bucket, manifest, ruleCount) {
  const count =
    ruleCount ?? (bucket === "precise" ? manifest.totals.preciseRules : manifest.totals.broadRules);
  return [
    `# OpenGrep super-config: ${bucket}`,
    `#`,
    `# Auto-generated by scripts/compile-opengrep-rules.mjs.`,
    `# DO NOT EDIT BY HAND. Re-run the compile script after editing source rules.`,
    `#`,
    `# Source run id : ${manifest.runId}`,
    `# Source run dir: ${manifest.runDir}`,
    `# Generated at  : ${manifest.generatedAt}`,
    `# Rule count    : ${count}`,
    "",
  ].join("\n");
}

function detectIdCollisions(rules) {
  const seen = new Map();
  const dupes = [];
  for (const r of rules) {
    if (seen.has(r.id)) {
      dupes.push({ id: r.id, ghsas: [seen.get(r.id), r.metadata?.ghsa] });
    } else {
      seen.set(r.id, r.metadata?.ghsa || "");
    }
  }
  return dupes;
}

function disambiguateCollisions(rules) {
  // Append a numeric suffix per collision so opengrep validate doesn't trip on
  // duplicate ids (which can happen if the same source-rule-id appears across
  // multiple advisories, though our naming already includes ghsa).
  const seen = new Map();
  const out = [];
  for (const r of rules) {
    let id = r.id;
    if (seen.has(id)) {
      const next = (seen.get(id) ?? 1) + 1;
      seen.set(id, next);
      id = `${id}-${next}`;
    } else {
      seen.set(id, 1);
    }
    out.push({ ...r, id });
  }
  return out;
}

function runCommand(argv, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: String(err) }));
  });
}

/**
 * Run opengrep against a synthetic empty target with the given super-config and
 * collect the line numbers reported as InvalidRuleSchemaError. Returns a Set of
 * 1-based line numbers in the super-config that are inside an invalid rule.
 *
 * If opengrep exits with no schema errors at all, returns an empty Set.
 */
async function findInvalidRuleSpans(superConfigPath) {
  // Use a tiny empty tmp dir as the scan target so opengrep does the rule
  // validation step without scanning real code.
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), "opengrep-empty-"));
  try {
    const result = await runCommand(
      [
        "opengrep",
        "scan",
        "--no-strict",
        "--config",
        superConfigPath,
        "--json",
        "--no-git-ignore",
        emptyDir,
      ],
      { timeoutMs: 120_000 },
    );
    // opengrep emits machine-readable JSON on stdout when --json is set, even
    // for InvalidRuleSchemaError. If the binary is missing, crashed, or printed
    // nothing parseable we MUST treat that as a hard validation failure rather
    // than "no schema errors" — otherwise we'd silently publish unvalidated
    // rules. The caller distinguishes this via the `validatorOk` flag.
    if (!result.stdout || result.stdout.trim() === "") {
      const tail = (result.stderr || "").trim().slice(-500);
      return {
        invalidLines: new Set(),
        errorCount: 0,
        validatorOk: false,
        validatorError: `opengrep produced no JSON output (exit code ${result.code}). stderr tail: ${tail || "(empty)"}`,
      };
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (parseErr) {
      return {
        invalidLines: new Set(),
        errorCount: 0,
        validatorOk: false,
        validatorError: `opengrep stdout was not valid JSON (exit code ${result.code}): ${String(parseErr).slice(0, 200)}`,
      };
    }
    const invalidLines = new Set();
    let errorCount = 0;
    for (const err of parsed.errors || []) {
      if (err.type !== "InvalidRuleSchemaError") {
        continue;
      }
      errorCount += 1;
      for (const span of err.spans || []) {
        const start = span.start?.line;
        const end = span.end?.line ?? start;
        if (typeof start === "number" && typeof end === "number") {
          for (let line = start; line <= end; line += 1) {
            invalidLines.add(line);
          }
        }
      }
    }
    return { invalidLines, errorCount, validatorOk: true };
  } finally {
    await fs.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Given a parsed YAML document of `{ rules: [...] }`, return the list of rule
 * indices whose YAML span overlaps any of the invalidLines reported by opengrep.
 */
function rulesOverlappingLines(superConfigText, invalidLines) {
  // Quick line-tracking: walk the file, track which rule-index a line belongs
  // to by detecting `  - id:` (the canonical start of a rule when rendered by
  // our writer).
  const lines = superConfigText.split("\n");
  const ruleStarts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s{2}-\s+id:\s*/.test(lines[i])) {
      ruleStarts.push(i + 1);
    } // 1-based
  }
  const bad = new Set();
  for (const ln of invalidLines) {
    // Find the highest rule-start that's <= ln
    let lo = 0;
    let hi = ruleStarts.length - 1;
    let pick = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ruleStarts[mid] <= ln) {
        pick = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (pick >= 0) {
      bad.add(pick);
    }
  }
  return bad;
}

/**
 * Iteratively validate the given bucket: write super-config, run opengrep to
 * find invalid rules, drop them, and rewrite. Repeat until no invalid rules
 * remain or until we hit a max-iteration cap.
 *
 * Returns { rules, droppedCount, droppedDetails }
 */
async function pruneInvalidRulesForBucket(rules, manifest, bucket, outDir, maxIterations = 4) {
  let working = rules.slice();
  const droppedDetails = [];
  for (let iter = 0; iter < maxIterations; iter += 1) {
    const yamlText =
      buildBucketHeader(bucket, manifest, working.length) +
      stringify({ rules: working }, { lineWidth: 0 });
    const tmpPath = path.join(outDir, `.tmp-${bucket}.yml`);
    await fs.writeFile(tmpPath, yamlText);
    const { invalidLines, errorCount, validatorOk, validatorError } =
      await findInvalidRuleSpans(tmpPath);
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    if (!validatorOk) {
      // Hard fail: we couldn't actually validate. Refusing to ship potentially
      // invalid rules with a misleading manifest is the only safe behavior.
      throw new Error(
        `opengrep schema validation failed for bucket '${bucket}'. Install opengrep ` +
          `(https://opengrep.dev) and retry. Validator error: ${validatorError}`,
      );
    }
    if (errorCount === 0 || invalidLines.size === 0) {
      return { rules: working, droppedDetails };
    }
    const badIndices = rulesOverlappingLines(yamlText, invalidLines);
    if (badIndices.size === 0) {
      // Errors exist but couldn't be mapped to rules; bail.
      return { rules: working, droppedDetails };
    }
    const next = [];
    for (let i = 0; i < working.length; i += 1) {
      if (badIndices.has(i)) {
        droppedDetails.push({
          id: working[i].id,
          ghsa: working[i].metadata?.ghsa,
        });
      } else {
        next.push(working[i]);
      }
    }
    working = next;
  }
  return { rules: working, droppedDetails };
}

async function writeOutputs(buckets, manifest, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  for (const [bucket, info] of Object.entries(buckets)) {
    const collisions = detectIdCollisions(info.rules);
    if (collisions.length > 0) {
      console.error(
        `[warn] ${bucket}: ${collisions.length} duplicate rule ids will be auto-suffixed (-2, -3, ...).`,
      );
    }
    const disambiguated = disambiguateCollisions(info.rules);

    // Use opengrep itself to find rules with InvalidRuleSchemaError and drop
    // them so the published super-config is loadable end-to-end.
    console.error(`[info] ${bucket}: validating ${disambiguated.length} rules with opengrep...`);
    const { rules: validRules, droppedDetails } = await pruneInvalidRulesForBucket(
      disambiguated,
      manifest,
      bucket,
      outDir,
    );
    info.invalid = droppedDetails;
    if (droppedDetails.length > 0) {
      console.error(
        `[warn] ${bucket}: dropped ${droppedDetails.length} rules with invalid schema.`,
      );
    }

    const yaml = stringify({ rules: validRules }, { lineWidth: 0 });
    const filePath = path.join(outDir, `${bucket}.yml`);
    await fs.writeFile(filePath, buildBucketHeader(bucket, manifest, validRules.length) + yaml);

    // Update manifest counts to reflect the post-prune state
    if (bucket === "precise") {
      manifest.totals.preciseRules = validRules.length;
      manifest.totals.preciseInvalid = droppedDetails.length;
    } else if (bucket === "broad") {
      manifest.totals.broadRules = validRules.length;
      manifest.totals.broadInvalid = droppedDetails.length;
    }
    // Also surface invalid rule ids in the manifest for traceability
    manifest[`${bucket}Invalid`] = droppedDetails;
  }
  const manifestPath = path.join(outDir, "compile-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function printSummary(buckets, manifest, outDir) {
  console.log(`compile-opengrep-rules: done`);
  console.log(`  out-dir          : ${outDir}`);
  console.log(`  cases scanned    : ${manifest.totals.cases}`);
  console.log(`  cases with rules : ${manifest.totals.casesWithAnyRule}`);
  console.log(
    `  precise rules    : ${manifest.totals.preciseRules} (yaml-skipped: ${manifest.totals.preciseSkipped}, schema-invalid: ${manifest.totals.preciseInvalid ?? 0})`,
  );
  console.log(
    `  broad rules      : ${manifest.totals.broadRules} (yaml-skipped: ${manifest.totals.broadSkipped}, schema-invalid: ${manifest.totals.broadInvalid ?? 0})`,
  );
  const totalDropped =
    (manifest.totals.preciseSkipped ?? 0) +
    (manifest.totals.broadSkipped ?? 0) +
    (manifest.totals.preciseInvalid ?? 0) +
    (manifest.totals.broadInvalid ?? 0);
  if (totalDropped > 0) {
    console.log("\nFirst few skipped/invalid rules:");
    for (const bucket of ["precise", "broad"]) {
      for (const s of (buckets[bucket].skipped ?? []).slice(0, 3)) {
        console.log(`  [${bucket}] ${s.ghsa}: yaml: ${s.error.split("\n")[0]}`);
      }
      for (const s of (buckets[bucket].invalid ?? []).slice(0, 3)) {
        console.log(`  [${bucket}] ${s.ghsa}: schema-invalid id=${s.id}`);
      }
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.outDir) {
    // Default: assume script lives at openclaw/scripts/<this>; output to openclaw/security/opengrep
    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    opts.outDir = path.resolve(scriptDir, "..", "security", "opengrep");
  }
  const { buckets, manifest } = await compile(opts);
  await writeOutputs(buckets, manifest, opts.outDir);
  printSummary(buckets, manifest, opts.outDir);
}

main().catch((err) => {
  console.error(`compile-opengrep-rules: error: ${err.message ?? err}`);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * compile-opengrep-rules.mjs
 *
 * Compiles per-case OpenGrep rules from a GHSA detector-review run and appends
 * newly generated precise rules to security/opengrep/precise.yml, plus a
 * compile-manifest.json with traceability back to each source advisory.
 *
 * Usage:
 *   node scripts/compile-opengrep-rules.mjs --run-dir <path> [--out-dir <path>]
 *
 * Inputs:
 *   --run-dir <path>   Required. A run dir produced by run-ghsa-detector-review-batch.mjs
 *                      (e.g. .artifacts/ghsa-detector-review-runs/<run-id>/).
 *   --out-dir <path>   Optional. Default: <repo>/security/opengrep/.
 *
 * Outputs:
 *   <out-dir>/precise.yml              Existing precise super-config plus new precise rules
 *   <out-dir>/compile-manifest.json    Per-rule provenance map
 *
 * Each rule's id is rewritten to `ghsa-detector.<ghsa-lower>.<original-id>`
 * (ASCII-sanitized). Each rule's metadata is augmented with:
 *   - ghsa: "GHSA-xxxx-xxxx-xxxx"
 *   - advisory-url: github.com/<owner>/<repo>/security/advisories/<GHSA>
 *   - detector-bucket: "precise"
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
  --replace-precise    Replace precise.yml instead of appending new rule ids.
  --help               Show this help.
`);
}

function parseArgs(argv) {
  const opts = {
    runDir: "",
    outDir: "",
    advisoryRepo: REPO_BASENAME,
    replacePrecise: false,
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
      case "--replace-precise":
        opts.replacePrecise = true;
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

    const bucket = "precise";
    const filePath = path.join(ruleDir, "general-rule.yml");
    const { rules, error } = await readRuleFile(filePath);
    if (error) {
      buckets.precise.skipped.push({ ghsa, file: filePath, error });
      caseEntry.errors.precise = error;
    } else {
      for (const rule of rules) {
        const rewritten = rewriteRule(rule, {
          ghsa,
          advisoryUrl,
          bucket,
          sourceRun: runId,
        });
        buckets.precise.rules.push(rewritten);
        caseEntry.precise.push(rewritten.id);
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
    preciseRulesGenerated: buckets.precise.rules.length,
    preciseSkipped: buckets.precise.skipped.length,
    broadRules: 0,
    broadSkipped: 0,
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

async function readExistingRules(filePath) {
  const { rules, error } = await readRuleFile(filePath);
  if (error) {
    throw new Error(`Could not read existing precise rules from ${filePath}: ${error}`);
  }
  return rules;
}

function appendNewRules(existingRules, generatedRules) {
  const existingIds = new Set(existingRules.map((rule) => String(rule.id ?? "")));
  const appendedRules = [];
  const skippedDuplicateIds = [];
  for (const rule of generatedRules) {
    const id = String(rule.id ?? "");
    if (existingIds.has(id)) {
      skippedDuplicateIds.push(id);
      continue;
    }
    existingIds.add(id);
    appendedRules.push(rule);
  }
  return {
    rules: [...existingRules, ...appendedRules],
    appendedRules,
    skippedDuplicateIds,
  };
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

async function writeOutputs(buckets, manifest, outDir, opts) {
  await fs.mkdir(outDir, { recursive: true });

  const precisePath = path.join(outDir, "precise.yml");
  const existingRules = opts.replacePrecise ? [] : await readExistingRules(precisePath);
  const collisions = detectIdCollisions(buckets.precise.rules);
  if (collisions.length > 0) {
    console.error(
      `[warn] precise: ${collisions.length} duplicate generated rule ids will be auto-suffixed (-2, -3, ...).`,
    );
  }
  const disambiguated = disambiguateCollisions(buckets.precise.rules);
  const appendResult = opts.replacePrecise
    ? { rules: disambiguated, appendedRules: disambiguated, skippedDuplicateIds: [] }
    : appendNewRules(existingRules, disambiguated);

  // Use opengrep itself to find rules with InvalidRuleSchemaError and drop
  // them so the published super-config is loadable end-to-end.
  console.error(`[info] precise: validating ${appendResult.rules.length} rules with opengrep...`);
  const { rules: validRules, droppedDetails } = await pruneInvalidRulesForBucket(
    appendResult.rules,
    manifest,
    "precise",
    outDir,
  );
  buckets.precise.invalid = droppedDetails;
  if (droppedDetails.length > 0) {
    console.error(`[warn] precise: dropped ${droppedDetails.length} rules with invalid schema.`);
  }

  const yaml = stringify({ rules: validRules }, { lineWidth: 0 });
  await fs.writeFile(precisePath, buildBucketHeader("precise", manifest, validRules.length) + yaml);

  manifest.totals.preciseRulesExisting = existingRules.length;
  manifest.totals.preciseRulesAppended = appendResult.appendedRules.length;
  manifest.totals.preciseRulesDuplicateSkipped = appendResult.skippedDuplicateIds.length;
  manifest.totals.preciseRules = validRules.length;
  manifest.totals.preciseInvalid = droppedDetails.length;
  manifest.totals.broadRules = 0;
  manifest.totals.broadInvalid = 0;
  manifest.preciseInvalid = droppedDetails;
  manifest.preciseDuplicateSkipped = appendResult.skippedDuplicateIds;

  const manifestPath = path.join(outDir, "compile-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

function printSummary(buckets, manifest, outDir) {
  console.log(`compile-opengrep-rules: done`);
  console.log(`  out-dir          : ${outDir}`);
  console.log(`  cases scanned    : ${manifest.totals.cases}`);
  console.log(`  cases with rules : ${manifest.totals.casesWithAnyRule}`);
  console.log(
    `  precise rules    : ${manifest.totals.preciseRules} total (${manifest.totals.preciseRulesExisting ?? 0} existing, ${manifest.totals.preciseRulesAppended ?? 0} appended, ${manifest.totals.preciseRulesDuplicateSkipped ?? 0} duplicate skipped, yaml-skipped: ${manifest.totals.preciseSkipped}, schema-invalid: ${manifest.totals.preciseInvalid ?? 0})`,
  );
  console.log("  broad rules      : skipped (not written to repo)");
  const totalDropped =
    (manifest.totals.preciseSkipped ?? 0) +
    (manifest.totals.broadSkipped ?? 0) +
    (manifest.totals.preciseInvalid ?? 0) +
    (manifest.totals.broadInvalid ?? 0);
  if (totalDropped > 0) {
    console.log("\nFirst few skipped/invalid rules:");
    for (const s of (buckets.precise.skipped ?? []).slice(0, 3)) {
      console.log(`  [precise] ${s.ghsa}: yaml: ${s.error.split("\n")[0]}`);
    }
    for (const s of (buckets.precise.invalid ?? []).slice(0, 3)) {
      console.log(`  [precise] ${s.ghsa}: schema-invalid id=${s.id}`);
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
  await writeOutputs(buckets, manifest, opts.outDir, opts);
  printSummary(buckets, manifest, opts.outDir);
}

main().catch((err) => {
  console.error(`compile-opengrep-rules: error: ${err.message ?? err}`);
  process.exit(1);
});

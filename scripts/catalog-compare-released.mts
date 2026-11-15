// Show how a candidate model-catalog bundle changes behavior for released OpenClaw installs.
// The report always exits 0 once every release was compared. `--check` is the publish
// gate instead: each release that reads the candidate's wire version must accept it
// and keep every published row, or the command exits 1.
// See the "Model Listing" rules in src/plugins/AGENTS.md.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import {
  diffRuns,
  formatReport,
  type Change,
  type ReleaseRun,
} from "./lib/catalog-compare-released-diff.mts";
import {
  catalogRowCount,
  catalogSchemaVersion,
  releasedReaderVerdict,
  releasedSchemaVersions,
  type ReleaseVerdict,
} from "./lib/catalog-compare-released-gate.mts";

const run = promisify(execFile);
const DIST_TAGS = ["latest", "extended-stable", "beta"];
const CACHE_ROOT = path.join(os.tmpdir(), "openclaw-catalog-compare-released");
const WORKER = path.join(import.meta.dirname, "lib/catalog-compare-released-worker.mts");

const { values } = parseArgs({
  options: {
    candidate: { type: "string" },
    baseline: { type: "string" },
    releases: { type: "string" },
    filter: { type: "string" },
    json: { type: "boolean", default: false },
    dump: { type: "string" },
    check: { type: "boolean", default: false },
    "allow-row-loss": { type: "string" },
  },
});
const allowRowLoss = Number(values["allow-row-loss"] ?? 0);
if (
  !values.candidate ||
  !Number.isInteger(allowRowLoss) ||
  allowRowLoss < 0 ||
  (!values.check && values["allow-row-loss"] !== undefined)
) {
  console.error(
    [
      "usage: pnpm catalog:compare-released --candidate <bundle.json> [--baseline <bundle.json>] [--releases <v,v>] [--filter <provider[/model]>] [--json] [--dump <dir>]",
      "       pnpm catalog:compare-released --check --candidate <bundle.json> [--baseline <last published bundle.json>] [--releases <v,v>] [--allow-row-loss <n>] [--dump <dir>]",
    ].join("\n"),
  );
  process.exit(2);
}
const candidateBundle: unknown = JSON.parse(fs.readFileSync(values.candidate, "utf8"));
const schemaVersion = catalogSchemaVersion(candidateBundle);
const feed = `v${schemaVersion}`;
const SERVED_CATALOG_URL = `https://catalog.openclaw.ai/models/${feed}/catalog.json`;

async function npm(args: string[], cwd?: string): Promise<string> {
  return (await run("npm", args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout;
}

async function releaseVersions(): Promise<Array<{ version: string; label: string }>> {
  if (values.releases) {
    return values.releases
      .split(",")
      .map((version) => ({ version: version.trim(), label: "requested" }));
  }
  // Under pnpm, npm runs in workspace mode and wraps the answer in a one-entry array.
  const parsed = JSON.parse(await npm(["view", "openclaw", "dist-tags", "--json"])) as
    | Record<string, string>
    | Array<Record<string, string>>;
  const tags = Array.isArray(parsed) ? (parsed[0] ?? {}) : parsed;
  if (!DIST_TAGS.some((tag) => tags[tag])) {
    throw new Error("npm returned no openclaw dist-tags; pass --releases");
  }
  const byVersion = new Map<string, string[]>();
  for (const tag of DIST_TAGS) {
    if (tags[tag]) {
      byVersion.set(tags[tag], [...(byVersion.get(tags[tag]) ?? []), tag]);
    }
  }
  return [...byVersion].map(([version, labels]) => ({ version, label: labels.join(", ") }));
}

type Install = { dir: string; omitted: string[] };
type Marker = { plugins: string[]; omitted: string[] };

function officialProviders(dir: string, version: string): string[] {
  const dist = path.join(dir, "node_modules/openclaw/dist");
  const listing = fs
    .readdirSync(dist)
    .map((file) => path.join(dist, file))
    .find(
      (file) =>
        file.endsWith(".mjs") &&
        fs.readFileSync(file, "utf8").includes("official-external-provider-catalog.json"),
    );
  if (!listing) {
    throw new Error(`openclaw@${version}: official external provider catalog not found in ${dist}`);
  }
  return [
    ...new Set(
      [
        ...fs.readFileSync(listing, "utf8").matchAll(/"npmSpec": "(@openclaw\/[\w.-]+-provider)"/g),
      ].map((match) => match[1] ?? ""),
    ),
  ].toSorted((a, b) => a.localeCompare(b));
}

// A cached install is trusted only when its marker accounts for every provider the
// release lists and every installed plugin is at the release version.
function cachedInstall(dir: string, version: string): Install | undefined {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, ".installed"), "utf8")) as Marker;
    const accounted = [...marker.plugins, ...marker.omitted].toSorted((a, b) => a.localeCompare(b));
    const complete =
      JSON.stringify(accounted) === JSON.stringify(officialProviders(dir, version)) &&
      marker.plugins.every((name) => {
        const manifest = path.join(dir, "node_modules", name, "package.json");
        return (
          (JSON.parse(fs.readFileSync(manifest, "utf8")) as { version?: string }).version ===
          version
        );
      });
    return complete ? { dir, omitted: marker.omitted } : undefined;
  } catch {
    return undefined;
  }
}

// Only npm's E404 means "not published at this version"; any other lookup failure
// (timeout, auth, registry 5xx) fails setup instead of silently dropping the provider.
async function isPublished(name: string, version: string): Promise<boolean> {
  try {
    return (await npm(["view", `${name}@${version}`, "version"])).trim() !== "";
  } catch (error) {
    if (/\bE404\b/.test(String((error as { stderr?: unknown }).stderr))) {
      return false;
    }
    throw new Error(`npm view ${name}@${version} failed`, { cause: error });
  }
}

// openclaw@<v> plus every official external provider plugin at the same version,
// as the release itself lists them. Cached across runs; scripts never run.
async function installRelease(version: string): Promise<Install> {
  const dir = path.join(CACHE_ROOT, version);
  const cached = cachedInstall(dir, version);
  if (cached) {
    return cached;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), '{ "private": true }\n');
  const install = ["install", "--ignore-scripts", "--no-audit", "--no-fund"];
  await npm([...install, `openclaw@${version}`], dir);
  const names = officialProviders(dir, version);
  const published = await Promise.all(names.map((name) => isPublished(name, version)));
  const plugins = names.filter((_, index) => published[index]);
  const omitted = names.filter((_, index) => !published[index]);
  await npm([...install, ...plugins.map((name) => `${name}@${version}`)], dir);
  const marker: Marker = { plugins, omitted };
  fs.writeFileSync(path.join(dir, ".installed"), JSON.stringify(marker, null, 2));
  return { dir, omitted };
}

async function selfSignedCert(dir: string): Promise<{ cert: string; key: string }> {
  const cert = path.join(dir, "upstream-cert.pem");
  const key = path.join(dir, "upstream-key.pem");
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=catalog-compare-upstream",
    "-keyout",
    key,
    "-out",
    cert,
  ]);
  return { cert, key };
}

// Each reader process gets its own HOME, state and working directory: released code
// must never open the user's ~/.openclaw state, reach a running Gateway, or load
// workspace plugins from this checkout.
async function readRelease(
  label: "baseline" | "candidate",
  releaseDir: string,
  bundle: string,
  comparedBundles: string[],
  runDir: string,
  cert: { cert: string; key: string },
  refreshOnly = false,
): Promise<ReleaseRun> {
  const sandbox = fs.mkdtempSync(path.join(runDir, "sandbox-"));
  for (const sub of ["home", "state", "tmp", "workspace"]) {
    fs.mkdirSync(path.join(sandbox, sub));
  }
  const out = path.join(sandbox, "run.json");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: path.join(sandbox, "home"),
    OPENCLAW_HOME: path.join(sandbox, "home"),
    OPENCLAW_STATE_DIR: path.join(sandbox, "state"),
    OPENCLAW_CONFIG_PATH: path.join(sandbox, "state/openclaw.json"),
    TMPDIR: path.join(sandbox, "tmp"),
  };
  const worker = path.join(runDir, path.basename(WORKER));
  const workerArgs = JSON.stringify({
    releaseDir,
    bundle,
    comparedBundles,
    sandbox,
    out,
    filter: values.filter,
    refreshOnly,
    ...cert,
  });
  const log: Buffer[] = [];
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, [worker, workerArgs], {
      cwd: path.join(sandbox, "workspace"),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => log.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => log.push(chunk));
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0 || !fs.existsSync(out)) {
    const tail = Buffer.concat(log).toString("utf8").split("\n").slice(-40).join("\n");
    throw new Error(`released reader failed for ${releaseDir} (exit ${code}):\n${tail}`);
  }
  const observed = JSON.parse(fs.readFileSync(out, "utf8")) as ReleaseRun;
  if (values.dump) {
    fs.mkdirSync(values.dump, { recursive: true });
    fs.copyFileSync(out, path.join(values.dump, `${observed.version}-${label}.json`));
  }
  return observed;
}

// Every release that ships a reader for the candidate's wire version reads the candidate
// and, when given, the last published file of the same feed. Releases without that reader
// are skipped by name, so a feed nobody reads yet passes and is gated from its first reader.
async function checkReleases(candidate: string, runDir: string): Promise<number> {
  const baselinePath = values.baseline ? path.resolve(values.baseline) : undefined;
  // A missing or identical baseline (first publish of a feed) explains no loss.
  const baseline =
    baselinePath &&
    fs.existsSync(baselinePath) &&
    fs.realpathSync(baselinePath) !== fs.realpathSync(candidate)
      ? baselinePath
      : undefined;
  const baselineEmitted = baseline
    ? catalogRowCount(JSON.parse(fs.readFileSync(baseline, "utf8")))
    : 0;
  const emitted = catalogRowCount(candidateBundle);
  const releases = await releaseVersions();
  const cert = await selfSignedCert(runDir);
  const verdicts = await Promise.all(
    releases.map(async ({ version }): Promise<ReleaseVerdict> => {
      const { dir } = await installRelease(version);
      const dist = path.join(dir, "node_modules/openclaw/dist");
      const chunks = (function* () {
        for (const file of fs.readdirSync(dist).filter((name) => name.endsWith(".mjs"))) {
          yield fs.readFileSync(path.join(dist, file), "utf8");
        }
      })();
      if (!releasedSchemaVersions(chunks).has(schemaVersion)) {
        return {
          line: `${feed} on openclaw@${version}: no ${feed} reader, skipped`,
          skipped: true,
        };
      }
      const [after, before] = await Promise.all([
        readRelease("candidate", dir, candidate, [candidate], runDir, cert, true),
        baseline
          ? readRelease("baseline", dir, baseline, [baseline], runDir, cert, true)
          : undefined,
      ]);
      return releasedReaderVerdict({
        feed,
        release: after.version,
        candidate: { emitted, refresh: after.refresh },
        ...(before ? { baseline: { emitted: baselineEmitted, refresh: before.refresh } } : {}),
        allowRowLoss,
      });
    }),
  );
  for (const { line } of verdicts) {
    console.log(line);
  }
  const failures = verdicts.flatMap(({ failure }) => (failure ? [failure] : []));
  for (const failure of failures) {
    console.log(`::error::${failure}`);
  }
  if (verdicts.every(({ skipped }) => skipped)) {
    console.log(`${feed}: no checked release reads ${feed} yet`);
  }
  return failures.length > 0 ? 1 : 0;
}

async function reportReleases(candidate: string, runDir: string): Promise<void> {
  const started = performance.now();
  const baseline = values.baseline
    ? path.resolve(values.baseline)
    : path.join(runDir, "served.json");
  if (!values.baseline) {
    const response = await fetch(SERVED_CATALOG_URL);
    if (!response.ok) {
      throw new Error(`GET ${SERVED_CATALOG_URL}: HTTP ${response.status}`);
    }
    fs.writeFileSync(baseline, Buffer.from(await response.arrayBuffer()));
  }
  const releases = await releaseVersions();
  const cert = await selfSignedCert(runDir);
  const installs = await Promise.all(
    releases.map(async ({ version, label }) =>
      Object.assign(await installRelease(version), { version, label }),
    ),
  );
  const installedAt = performance.now();
  const compared = [baseline, candidate];
  const results = await Promise.all(
    installs.map(async ({ version, label, dir, omitted }) => {
      const [before, after] = await Promise.all([
        readRelease("baseline", dir, baseline, compared, runDir, cert),
        readRelease("candidate", dir, candidate, compared, runDir, cert),
      ]);
      const changes: Change[] = diffRuns(before, after);
      return {
        release: version,
        label,
        changes,
        omittedProviders: omitted,
        rows: Math.max(before.rows.length, after.rows.length),
      };
    }),
  );
  const timing = {
    totalMs: Math.round(performance.now() - started),
    installMs: Math.round(installedAt - started),
    readMs: Math.round(performance.now() - installedAt),
  };
  if (values.json) {
    console.log(
      JSON.stringify(
        { baseline: values.baseline ?? SERVED_CATALOG_URL, candidate, timing, releases: results },
        null,
        2,
      ),
    );
  } else {
    console.log(formatReport(results));
    console.error(
      `[catalog-compare-released] rows ${results.map((r) => `${r.release}=${r.rows}`).join(" ")}; ` +
        `install ${timing.installMs} ms, read ${timing.readMs} ms, total ${timing.totalMs} ms`,
    );
  }
}

const runDir = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-catalog-compare-run-")),
);
try {
  // Released code finds bundled plugins relative to its entry script; a worker
  // inside this checkout would make it load the checkout's extensions/. Copy once:
  // readers spawn together, and a copy per spawn truncates the file a sibling is
  // loading, which then runs an empty module and exits 0 without a result.
  fs.copyFileSync(WORKER, path.join(runDir, path.basename(WORKER)));
  const candidate = path.resolve(values.candidate);
  if (values.check) {
    process.exitCode = await checkReleases(candidate, runDir);
  } else {
    await reportReleases(candidate, runDir);
  }
} finally {
  fs.rmSync(runDir, { recursive: true, force: true });
}

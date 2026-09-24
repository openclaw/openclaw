import { execFileSync, spawn } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createPublicationSourceFact,
  normalizePublicationIntent,
  publicationSourceJson,
} from "./full-release-publication-contract.mjs";
import {
  assertPluginReleaseVersionFloors,
  parsePluginReleaseSelection,
  parsePluginReleaseSelectionMode,
  resolveSelectedPublishablePluginPackages,
} from "./lib/plugin-npm-release.ts";
import { collectExtensionPackageJsonCandidates } from "./lib/plugin-publication-candidates.ts";
import { collectPublishablePluginPackagesFromCandidates } from "./lib/plugin-publication-collector.ts";
import {
  classifyReleaseTrain,
  parsePinnedReleaseVersion,
  parseReleaseVersion,
} from "./lib/release-version.mjs";
import { produceVerifiedReleaseInventory } from "./release-plan-producer.mts";

const executionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath =
  /^(?:package\.json|apps\/android\/version\.json|extensions\/[^/]+\/(?:package\.json|README\.md)|packages\/[^/]+\/package\.json)$/u;
const platformHelperPath = "scripts/lib/release-publish-children.sh";
// Acquisition includes the producer's committed runtime and policy inputs. The producer
// remains responsible for verifying its executing bootstrap, fixed imports and YAML bytes.
const toolingPaths = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "packages/normalization-core/src/record-coerce.ts",
  "packages/normalization-core/src/string-coerce.ts",
  "packages/plugin-package-contract/src/categories.ts",
  "packages/plugin-package-contract/src/index.ts",
  "scripts/lib/bounded-response.mjs",
  "scripts/lib/canonical-json.mjs",
  "scripts/lib/npm-publish-plan.mjs",
  "scripts/lib/npm-core-release-packages.json",
  "scripts/lib/plugin-publication-candidates.ts",
  "scripts/lib/plugin-publication-collector.ts",
  "scripts/lib/plugin-publication-target.mjs",
  "scripts/lib/pnpm-lockfile-documents.mjs",
  "scripts/lib/record-shared.mjs",
  "scripts/lib/release-version.mjs",
  "scripts/release-plan-producer.mts",
  "scripts/release-plan-producer-core.mts",
  "scripts/release-plan-contract.mjs",
  "scripts/release-tooling-identity.mjs",
  "scripts/release-validation-intent.mjs",
  "scripts/full-release-publication-admission.mts",
  "scripts/full-release-publication-contract.mjs",
  "scripts/full-release-flake-policy.mjs",
  "scripts/lib/plugin-npm-release.ts",
  "scripts/lib/npm-json-output.mts",
  "packages/normalization-core/src/expect.ts",
  "src/utils/run-with-concurrency.ts",
  "scripts/full-release-publication-observations.mts",
  "scripts/lib/plugin-clawhub-release.ts",
  "scripts/clawhub-prepared-artifact.mjs",
  "scripts/clawhub-parent-authorization.mjs",
  "scripts/plugin-publication-artifact.mjs",
  "scripts/lib/actions-artifact-archive.mjs",
  "scripts/lib/arg-utils.runtime.mjs",
  "scripts/tsx.mjs",
  "scripts/lib/tsx-cli-shim.mjs",
  "scripts/lib/local-check-runtime.mts",
  "packages/normalization-core/src/number-coercion.ts",
  "packages/normalization-core/src/utf16-slice.ts",
  "packages/ai/src/internal/retry-after.ts",
  "packages/retry/src/index.ts",
  "src/infra/clawhub-retry.ts",
  "src/infra/map-size.ts",
  "src/infra/retry-after.ts",
  "src/infra/retry-attempt-errors.ts",
  "src/infra/retry.ts",
  "src/infra/secure-random.ts",
  "src/logging/secret-redaction-registry.ts",
  "src/shared/global-singleton.ts",
  "src/shared/regexp.ts",
]);
type Request = ReturnType<
  typeof import("./full-release-publication-contract.mjs").publicationSourceRequest
>;
type SourceEntry = { oid: string; mode: string; path: string; type: string };

function localGit(root: string, args: string[], input?: Buffer | string) {
  return execFileSync("git", ["--no-lazy-fetch", "--no-replace-objects", "-C", root, ...args], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
    },
    input,
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function sourceEntries(root: string, sha: string): SourceEntry[] {
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error("publication source requires an exact commit");
  }
  const resolved = localGit(root, ["rev-parse", "--verify", `${sha}^{commit}`])
    .toString()
    .trim();
  if (resolved !== sha) {
    throw new Error("publication source commit identity mismatch");
  }
  return localGit(root, ["ls-tree", "-r", "-t", "-z", "--full-tree", sha])
    .toString("latin1")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const tab = entry.indexOf("\t");
      const [mode, type, oid] = entry.slice(0, tab).split(" ");
      if (tab < 0 || !/^[a-f0-9]{40}$/u.test(oid ?? "") || !mode || !type) {
        throw new Error("invalid publication source object inventory");
      }
      return { mode, type, oid: oid!, path: entry.slice(tab + 1) };
    });
}

function retainSource(root: string, sha: string, store: string, tooling: boolean) {
  const entries = sourceEntries(root, sha);
  const selected = entries.filter(
    (entry) =>
      entry.type === "tree" ||
      (tooling
        ? toolingPaths.has(entry.path) ||
          (entry.path === platformHelperPath && entry.type === "blob") ||
          /^\.github\/workflows\/[^/]+\.yml$/u.test(entry.path)
        : metadataPath.test(entry.path)),
  );
  const objects = new Set([
    sha,
    localGit(root, ["rev-parse", `${sha}^{tree}`])
      .toString()
      .trim(),
  ]);
  let total = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const entry of selected) {
    if (entry.type !== "tree") {
      decoder.decode(Buffer.from(entry.path, "latin1"));
      // The optional helper stays raw Git data. Core alone requires and validates
      // its regular mode when a parsed publication step actually links it.
      if (
        !(tooling && entry.path === platformHelperPath) &&
        !["100644", "100755"].includes(entry.mode)
      ) {
        throw new Error("publication source metadata must contain only regular Git blobs");
      }
    }
    objects.add(entry.oid);
  }
  if (objects.size > 8192) {
    throw new Error("publication source object count exceeds limit");
  }
  const objectIds = [...objects];
  const objectInput = objectIds.join("\n") + "\n";
  const sizes = localGit(
    root,
    ["cat-file", "--batch-check=%(objectname) %(objectsize)"],
    objectInput,
  )
    .toString()
    .split("\n");
  // A batch can exit successfully with missing objects. Bind every response before packing.
  for (const [index, oid] of objectIds.entries()) {
    const match = /^([a-f0-9]{40}) (0|[1-9][0-9]*)$/u.exec(sizes[index] ?? "");
    if (!match || match[1] !== oid) {
      throw new Error("invalid publication source object-size response");
    }
    const size = Number(match[2]);
    if (
      !Number.isSafeInteger(size) ||
      size > 16 * 1024 * 1024 ||
      (total += size) > 64 * 1024 * 1024
    ) {
      throw new Error("publication source metadata exceeds byte limit");
    }
  }
  if (sizes.length !== objectIds.length + 1 || sizes.at(-1) !== "") {
    throw new Error("invalid publication source object-size response");
  }
  const pack = localGit(
    root,
    ["pack-objects", "--stdout", "--no-reuse-delta", "--no-reuse-object"],
    objectInput,
  );
  localGit(store, ["index-pack", "--stdin"], pack);
  return selected.filter((entry) => entry.type === "blob");
}

function projectSource(
  request: Request,
  snapshot: string,
  plan: ReturnType<typeof produceVerifiedReleaseInventory>,
) {
  const { publicationSelection: selection } = normalizePublicationIntent(
    request.validationPurpose,
    publicationSourceJson(request.publicationSelection),
  );
  if (!selection) {
    throw new Error("publication source selection required");
  }
  const parsed = parseReleaseVersion(plan.version);
  if (!parsed) {
    throw new Error("invalid publication source version");
  }
  const train = classifyReleaseTrain(parsed);
  if (train === "unsupported-extended-stable-correction") {
    throw new Error("unsupported extended-stable correction");
  }
  const extended = selection.route === "extended-stable";
  const allowedTags =
    train === "stable"
      ? ["beta", "latest"]
      : train === "extended-stable"
        ? ["extended-stable"]
        : [parsed.channel];
  if (
    !allowedTags.includes(selection.npmDistTag) ||
    (train === "extended-stable") !== extended ||
    (parsed.channel === "alpha") !== (selection.route === "alpha")
  ) {
    throw new Error("publication selection does not match the committed release version");
  }
  if (selection.route === "prepared" && !["beta", "stable"].includes(train)) {
    throw new Error("prepared publication requires a regular beta/stable candidate");
  }
  if (selection.windowsNodeTag && train !== "stable") {
    throw new Error("Windows assets require a stable publication");
  }
  const mode = parsePluginReleaseSelectionMode(selection.pluginPublishScope);
  const names = parsePluginReleaseSelection(selection.plugins.join(","));
  if ((mode === "selected") !== names.length > 0) {
    throw new Error("inconsistent plugin selection");
  }
  const candidates = collectExtensionPackageJsonCandidates(snapshot);
  const npm = collectPublishablePluginPackagesFromCandidates(
    candidates,
    "npm",
    extended ? { npmDistTag: "extended-stable", rootVersion: plan.version } : {},
  );
  const clawhub = extended
    ? []
    : collectPublishablePluginPackagesFromCandidates(candidates, "clawhub");
  const all = [
    ...new Map([...npm, ...clawhub].map((plugin) => [plugin.packageName, plugin])).values(),
  ];
  const selected = resolveSelectedPublishablePluginPackages({ plugins: all, selection: names });
  assertPluginReleaseVersionFloors(selected, "FRV source admission");
  const selectedNames = new Set(selected.map((plugin) => plugin.packageName));
  const allPluginNames = new Set(all.map((plugin) => plugin.packageName));
  const packages = plan.inventory.packages.flatMap((entry) => {
    const targets = entry.targets.filter((target) => !extended || target === "npm");
    if (!targets.length) {
      return [];
    }
    const include = allPluginNames.has(entry.name)
      ? selectedNames.has(entry.name)
      : selection.publishOpenclawNpm;
    return include ? [{ ...entry, targets }] : [];
  });
  const platforms = plan.inventory.platforms.filter((platform) => {
    if (platform.id === "linux") {
      return selection.publishOpenclawNpm && train === "stable" && !extended;
    }
    if (platform.id === "windows") {
      return Boolean(selection.windowsNodeTag);
    }
    if (platform.id === "android") {
      if (!selection.publishOpenclawNpm || train !== "stable") {
        return false;
      }
      const pin = JSON.parse(
        readFileSync(join(snapshot, "apps/android/version.json"), "utf8"),
      )?.version;
      // Match the publisher's exact pin syntax before comparing the parsed base.
      if (typeof pin !== "string" || !/^[0-9]{4}\.([1-9]|1[0-2])\.[0-9]{1,3}$/u.test(pin)) {
        throw new Error("apps/android/version.json must pin an exact YYYY.M.PATCH Android version");
      }
      return parsePinnedReleaseVersion(pin) === parsed.baseVersion;
    }
    if (extended) {
      return platform.id === "docker";
    }
    return selection.publishOpenclawNpm && selection.route !== "alpha";
  });
  return { version: plan.version, packages, platforms };
}

async function collectVerifiedObservations(
  scratch: string,
  snapshot: string,
  source: ReturnType<typeof createPublicationSourceFact>,
) {
  const home = join(scratch, "worker-home");
  const temporary = join(scratch, "worker-tmp");
  const cache = join(scratch, "worker-cache");
  for (const directory of [home, temporary, cache]) {
    mkdirSync(directory);
  }
  const request = join(scratch, "registry-request.json");
  writeFileSync(
    request,
    publicationSourceJson({
      snapshot,
      source,
      prerequisitesCompletedAt: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  return await new Promise<string>((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(executionRoot, "scripts/tsx.mjs")).href,
        join(executionRoot, "scripts/full-release-publication-observations.mts"),
        request,
      ],
      {
        cwd: executionRoot,
        env: {
          PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
          HOME: home,
          TMPDIR: temporary,
          TMP: temporary,
          TEMP: temporary,
          XDG_CACHE_HOME: cache,
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    let stderr = Buffer.alloc(0);
    let outputBytes = 0;
    let failure: Error | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    const stop = (error: Error, signal: NodeJS.Signals = "SIGTERM") => {
      failure ??= error;
      child.kill(signal);
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const interrupt = () =>
      stop(new Error("Publication observation worker interrupted by SIGINT."), "SIGINT");
    const terminate = () =>
      stop(new Error("Publication observation worker interrupted by SIGTERM."));
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const deadline = setTimeout(
      () => stop(new Error("Publication observation worker exceeded its collection deadline.")),
      300_000,
    );
    child.stdout.on("data", (bytes: Buffer) => {
      outputBytes += bytes.length;
      if (outputBytes > 1024 * 1024) {
        stop(new Error("Publication observation worker output exceeded byte limit."));
      } else {
        stdout.push(bytes);
      }
    });
    child.stderr.on("data", (bytes: Buffer) => {
      // Planners also log their retained advisory warnings. Drain them without
      // converting warning volume into an admission failure; keep a bounded tail.
      stderr = Buffer.concat([stderr, bytes]).subarray(-16 * 1024);
    });
    child.once("error", (error) => {
      failure ??= new Error("Could not start publication observation worker.", { cause: error });
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      clearTimeout(forceKill);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      if (failure || code !== 0) {
        let message = "Publication observation worker failed before a bounded diagnostic.";
        try {
          const diagnostic = JSON.parse(stderr.toString("utf8").trim().split("\n").at(-1) ?? "");
          if (
            diagnostic?.stage === "publication-observations" &&
            typeof diagnostic.error === "string" &&
            diagnostic.error.length <= 1024
          ) {
            message = diagnostic.error;
          }
        } catch {
          // Import/startup failures are not safe public registry diagnostics.
        }
        reject(failure ?? new Error(message));
      } else {
        resolveResult(Buffer.concat(stdout).toString("utf8"));
      }
    });
  });
}

async function admitPublicationSource(
  request: Request,
  roots: { selected: string; tooling: string },
  observationsOut?: string,
) {
  const intent = normalizePublicationIntent(
    request.validationPurpose,
    request.publicationSelection === null
      ? ""
      : publicationSourceJson(request.publicationSelection),
  );
  if (intent.validationPurpose !== "publish") {
    return createPublicationSourceFact(request, null, null);
  }
  if (resolve(roots.tooling) !== executionRoot) {
    throw new Error("source admission requires its executing tooling checkout");
  }
  // Bind the trusted checkout's adapter/helper bytes as well as the producer's
  // independently retained imports. This does not attest a malicious bootstrap.
  for (const path of toolingPaths) {
    const file = join(executionRoot, path);
    if (
      !lstatSync(file).isFile() ||
      !readFileSync(file).equals(
        localGit(executionRoot, ["show", `${request.tooling.sha}:${path}`]),
      )
    ) {
      throw new Error(`source admission tooling bytes differ from the declared SHA: ${path}`);
    }
  }
  const scratch = mkdtempSync(join(tmpdir(), "openclaw-publication-source-"));
  const store = join(scratch, "objects");
  const snapshot = join(scratch, "metadata");
  mkdirSync(store);
  mkdirSync(snapshot);
  try {
    localGit(store, ["-c", "init.templateDir=", "init", "--bare", "-q"]);
    // A real empty-tree object is needed by the unchanged producer's pathspec diff.
    localGit(store, ["hash-object", "-w", "-t", "tree", "--stdin"], "");
    const entries = retainSource(roots.selected, request.candidateSha, store, false);
    retainSource(roots.tooling, request.tooling.sha, store, true);
    const plan = produceVerifiedReleaseInventory({
      repoRoot: store,
      candidateSha: request.candidateSha,
      toolingSha: request.tooling.sha,
      toolingFullRef: request.tooling.ref,
    });
    // Only regular committed metadata is materialized, after complete inventory verification.
    for (const entry of entries) {
      const path = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.from(entry.path, "latin1"),
      );
      const destination = join(snapshot, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, localGit(store, ["cat-file", "blob", entry.oid]));
    }
    mkdirSync(join(snapshot, "extensions"), { recursive: true });
    const source = createPublicationSourceFact(
      request,
      plan.inventory,
      projectSource(request, snapshot, plan),
    );
    if (observationsOut) {
      const observations = await collectVerifiedObservations(scratch, snapshot, source);
      writeFileSync(observationsOut, observations, { mode: 0o600 });
    }
    return source;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

let invokedAsMain = false;
if (process.argv[1]) {
  try {
    invokedAsMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // Inline and stdin importers need not have a filesystem entrypoint.
  }
}
if (invokedAsMain) {
  try {
    const path = process.argv[2];
    const observationsOut = process.argv[3] === "--observations-out" ? process.argv[4] : undefined;
    if (
      !path ||
      !process.env.PUBLICATION_TARGET_ROOT ||
      (process.argv.length !== 3 && (process.argv.length !== 5 || !observationsOut))
    ) {
      throw new Error("publication source request and selected root required");
    }
    const bytes = readFileSync(path);
    if (bytes.length > 128 * 1024) {
      throw new Error("publication source request exceeds byte limit");
    }
    process.stdout.write(
      publicationSourceJson(
        await admitPublicationSource(
          JSON.parse(bytes.toString("utf8")),
          {
            selected: process.env.PUBLICATION_TARGET_ROOT,
            tooling: executionRoot,
          },
          observationsOut,
        ),
      ) + "\n",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

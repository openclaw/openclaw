import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, sanitizeChildEnvironment } from "./run-mock-sut-user-e2e.mjs";
import { withTelegramRun } from "./telegram-run-scope.mjs";

const prepared = dirname(fileURLToPath(import.meta.url));
const source = resolve(prepared, "../../../..");
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

export function assertCandidateInstalled(upgrade) {
  for (const [file, digest] of Object.entries(upgrade.candidate.runtimeHashes)) {
    if (sha(join(upgrade.packageRoot, file)) !== digest) {
      throw new Error("CANDIDATE_INSTALLED_ARTIFACT_CHANGED");
    }
  }
  if (sha(upgrade.tarball) !== upgrade.candidate.sha256) {
    throw new Error("CANDIDATE_ARCHIVE_CHANGED");
  }
}

export async function inspectCandidateArchive(tarball, signal) {
  const script = String.raw`import hashlib, json, posixpath, re, tarfile, sys
with tarfile.open(sys.argv[1]) as archive:
 def data(name): return archive.extractfile('package/' + name).read()
 def owner(name, symbol):
  match = re.search(r"import\s*\{[^}]*\b" + symbol + r"\b[^}]*\}\s*from\s*['\"]([^'\"]+)", data(name).decode())
  if not match: raise RuntimeError('PACKAGED_OWNER_IMPORT_MISSING')
  result = posixpath.normpath(posixpath.join(posixpath.dirname(name), match[1]))
  if not result.startswith('dist/'): raise RuntimeError('PACKAGED_OWNER_PATH_INVALID')
  return result
 files = ['dist/build-info.json', 'dist/extensions/telegram/package.json', 'dist/extensions/telegram/index.js', 'dist/extensions/telegram/channel-plugin-api.js', 'dist/entry.js', 'dist/plugin-sdk/logging-core.js']
 channel = owner(files[3], 'telegramPlugin')
 files += [channel, owner(channel, 'createTelegramThreadBindingManager'), owner(channel, 'resolveTelegramTransport')]
 manifest = json.loads(data('package.json'))
 build = json.loads(data('dist/build-info.json'))
 print(json.dumps({'buildInfo': build, 'packageName': manifest['name'], 'packageVersion': manifest['version'], 'runtimeHashes': {name: hashlib.sha256(data(name)).hexdigest() for name in files}}))`;
  return await withTelegramRun(
    async () => {
      const result = await runCommand("python3", ["-c", script, tarball], {
        cwd: source,
        env: sanitizeChildEnvironment(),
        timeoutMs: 60000,
      });
      if (result.status !== 0 || result.timedOut) {
        throw new Error("CANDIDATE_ARCHIVE_INSPECTION_FAILED");
      }
      return { ...JSON.parse(result.stdout), sha256: sha(tarball) };
    },
    { signal },
  );
}

export async function preparePublishedUpgradeInputs(options, signal) {
  const prefix = dirname(dirname(options.baseline));
  const packageRoot = join(prefix, "lib/node_modules/openclaw");
  if (realpathSync(options.baseline) !== join(packageRoot, "openclaw.mjs")) {
    throw new Error("INSTALLED_BASELINE_REQUIRED");
  }
  const manifest = json(join(packageRoot, "package.json"));
  const buildInfo = json(join(packageRoot, "dist/build-info.json"));
  if (
    manifest.name !== "openclaw" ||
    manifest.version !== options.version ||
    buildInfo.version !== options.version ||
    !/^[0-9a-f]{40}$/.test(buildInfo.commit ?? "") ||
    !buildInfo.buildId ||
    existsSync(join(packageRoot, ".openclaw-lifecycle-pending")) ||
    existsSync(join(packageRoot, "dist/openclaw-install-guard"))
  ) {
    throw new Error("PUBLISHED_BASELINE_IDENTITY_OR_LIFECYCLE_INVALID");
  }
  const baseline = {
    buildInfo,
    runtimeHashes: Object.fromEntries(
      ["dist/build-info.json", "dist/entry.js", "dist/plugin-sdk/logging-core.js"].map((file) => [
        file,
        sha(join(packageRoot, file)),
      ]),
    ),
  };
  const candidate = await inspectCandidateArchive(options.candidate, signal);
  if (
    candidate.packageName !== "openclaw" ||
    candidate.packageVersion !== candidate.buildInfo.version ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(candidate.packageVersion ?? "") ||
    !/^[0-9a-f]{40}$/.test(candidate.buildInfo.commit ?? "") ||
    !candidate.buildInfo.buildId ||
    candidate.buildInfo.buildId === baseline.buildInfo.buildId ||
    Object.keys(candidate.runtimeHashes).length !== 9
  ) {
    throw new Error("DISTINCT_VALID_CANDIDATE_REQUIRED");
  }
  return await withTelegramRun(
    async () => {
      const environment = sanitizeChildEnvironment();
      const loader = `import importlib.util, json, sys, ctypes
spec = importlib.util.spec_from_file_location('telegram_driver', sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
library = module.ensure_prebuilt_tdjson()
if library is None: raise RuntimeError('TDLIB_PLATFORM_UNSUPPORTED')
ctypes.CDLL(str(library))
print(json.dumps({'path': str(library)}))`;
      const loaded = await runCommand("python3", ["-c", loader, join(prepared, "user-driver.py")], {
        cwd: source,
        env: environment,
        timeoutMs: 180000,
      });
      if (loaded.status !== 0 || loaded.timedOut) {
        throw new Error("PINNED_TDLIB_PREPARATION_FAILED");
      }
      process.env.TELEGRAM_USER_DRIVER_TDLIB_PATH = JSON.parse(loaded.stdout).path;
      return {
        prefix,
        packageRoot,
        tarball: options.candidate,
        baseline,
        candidate,
        profile: `telegram-upgrade-${randomBytes(6).toString("hex")}`,
      };
    },
    { signal },
  );
}

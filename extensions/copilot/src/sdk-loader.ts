import { createHash } from "node:crypto";
import { existsSync, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Sdk from "@github/copilot-sdk";
import { sha256File } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import copilotPluginPackage from "../package.json" with { type: "json" };

function resolveCopilotSdkFallbackDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "npm-runtime", "copilot");
}

const COPILOT_SDK_SPEC = `@github/copilot-sdk@${copilotPluginPackage.dependencies["@github/copilot-sdk"]}`;

export type CopilotSdkIdentity = Readonly<{
  entryPath: string;
  packageRoot: string;
  fingerprint: string;
}>;

type LoadedCopilotSdk = {
  sdk: typeof Sdk;
  identity?: CopilotSdkIdentity;
};

let cached: Promise<LoadedCopilotSdk> | undefined;
const installedImports = new Map<string, Promise<LoadedCopilotSdk>>();

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.mode === after.mode &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

/** Installed package bytes, excluding separately resolved dependency installations. */
export async function fingerprintCopilotPackage(packageRoot: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "node_modules") {
        continue;
      }
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        // Plugin generations link native artifacts into immutable capture trees.
        const target = await fs.realpath(filePath);
        const before = await fs.stat(target, { bigint: true });
        const contents = await sha256File(target, { maxBytes: Number(before.size) });
        if (
          (await fs.realpath(filePath)) !== target ||
          !unchanged(before, await fs.stat(target, { bigint: true })) ||
          BigInt(contents.bytes) !== before.size
        ) {
          throw new Error("Copilot runtime package changed while fingerprinting.");
        }
        const relativePath = path.relative(packageRoot, filePath).split(path.sep).join("/");
        hash.update(`${relativePath}\0${before.mode}\0${contents.digest}\0`);
      } else {
        throw new Error(`Copilot runtime package contains an unsupported file: ${filePath}`);
      }
    }
  }
  await visit(packageRoot);
  return hash.digest("hex");
}

async function importInstalledSdk(selectedEntry: string): Promise<LoadedCopilotSdk> {
  const entryPath = await fs.realpath(selectedEntry);
  const previous = installedImports.get(entryPath);
  if (previous) {
    return previous;
  }
  let packageRoot = path.dirname(entryPath);
  while (true) {
    const manifestPath = path.join(packageRoot, "package.json");
    if (
      existsSync(manifestPath) &&
      JSON.parse(await fs.readFile(manifestPath, "utf8")).name === "@github/copilot-sdk"
    ) {
      break;
    }
    const parent = path.dirname(packageRoot);
    if (parent === packageRoot) {
      throw new Error("Could not locate the installed Copilot SDK package.");
    }
    packageRoot = parent;
  }
  const fingerprint = await fingerprintCopilotPackage(packageRoot);
  const loaded = (async (): Promise<LoadedCopilotSdk> => {
    const sdk = (await import(pathToFileURL(entryPath).href)) as typeof Sdk;
    if ((await fingerprintCopilotPackage(packageRoot)) !== fingerprint) {
      throw new Error(
        "Copilot SDK changed while loading. Restart OpenClaw before verifying inference.",
      );
    }
    return { sdk, identity: { entryPath, packageRoot, fingerprint } };
  })();
  // Node retains imported modules even if the subsequent identity check fails.
  installedImports.set(entryPath, loaded);
  return loaded;
}

interface LoadCopilotSdkOptions {
  readonly fallbackDir?: string;
  readonly primaryImport?: () => Promise<typeof Sdk>;
  readonly fallbackImport?: (absolutePath: string) => Promise<typeof Sdk>;
  readonly cache?: boolean;
}

export async function loadCopilotSdk(options: LoadCopilotSdkOptions = {}): Promise<typeof Sdk> {
  return (await loadSdk(options)).sdk;
}

export async function loadCopilotSdkWithIdentity(): Promise<{
  sdk: typeof Sdk;
  identity: CopilotSdkIdentity;
}> {
  const loaded = await loadSdk({});
  if (!loaded.identity) {
    throw new Error("The loaded Copilot SDK has no installed implementation identity.");
  }
  return { sdk: loaded.sdk, identity: loaded.identity };
}

async function loadSdk(options: LoadCopilotSdkOptions): Promise<LoadedCopilotSdk> {
  const useCache = options.cache !== false;
  if (useCache && cached) {
    return cached;
  }

  const promise = doLoad(options);
  if (useCache) {
    cached = promise.catch((err: unknown) => {
      cached = undefined;
      throw err;
    });
    return cached;
  }
  return promise;
}

async function doLoad(options: LoadCopilotSdkOptions): Promise<LoadedCopilotSdk> {
  const fallbackDir = options.fallbackDir ?? resolveCopilotSdkFallbackDir();

  let primaryErr: unknown;
  try {
    return options.primaryImport
      ? { sdk: await options.primaryImport() }
      : await importInstalledSdk(fileURLToPath(import.meta.resolve("@github/copilot-sdk")));
  } catch (err) {
    primaryErr = err;
  }

  const fallbackPath = path.join(fallbackDir, "node_modules", "@github", "copilot-sdk");
  if (!existsSync(fallbackPath)) {
    throw createMissingSdkError(primaryErr, undefined, fallbackPath);
  }

  try {
    if (options.fallbackImport) {
      return { sdk: await options.fallbackImport(fallbackPath) };
    }
    // Node ESM rejects directory imports; resolve the concrete installed entry.
    const requireFromFallback = createRequire(path.join(fallbackDir, "package.json"));
    const entry = requireFromFallback.resolve("@github/copilot-sdk");
    return await importInstalledSdk(entry);
  } catch (fallbackErr) {
    throw createMissingSdkError(primaryErr, fallbackErr, fallbackPath);
  }
}

function createMissingSdkError(
  primaryErr: unknown,
  fallbackErr: unknown,
  fallbackPath: string,
): Error {
  const lines = [
    "[copilot] @github/copilot-sdk is not installed.",
    "",
    "The external @openclaw/copilot plugin depends on @github/copilot-sdk",
    "including its platform-specific Copilot runtime package.",
    "Reinstall the plugin once with:",
    "",
    "  openclaw plugins install @openclaw/copilot",
    "",
    "For source checkouts or offline repair, install the SDK directly:",
    "",
    `  npm install ${COPILOT_SDK_SPEC}`,
    "",
    `The legacy fallback location is still probed at\n  ${fallbackPath}`,
    "",
    "Primary resolution error:",
    `  ${summarizeError(primaryErr)}`,
  ];
  if (fallbackErr !== undefined) {
    lines.push("", "Fallback resolution error:", `  ${summarizeError(fallbackErr)}`);
  }
  const err = new Error(lines.join("\n"));
  (err as Error & { code?: string }).code = "COPILOT_SDK_MISSING";
  return err;
}

function summarizeError(value: unknown): string {
  if (value === undefined || value === null) {
    return "(none)";
  }
  if (value instanceof Error) {
    return value.message || String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

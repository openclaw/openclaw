import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { resolveNpmRunner, type NpmRunnerParams } from "../npm-runner.mts";
import { hasUnjoinedWork, runManagedCommand } from "./managed-child-process.mts";
import { resolveNpmJsonEntries } from "./npm-json-output.mts";

const ISOLATED_ENV_KEYS =
  "HOME INIT_CWD OLDPWD PWD USERPROFILE XDG_CACHE_HOME XDG_CONFIG_HOME".split(" ");
type NpmSandbox = Record<"cacheDir" | "configDir" | "cwd" | "homeDir", string>;
type NpmPackInventoryOptions = {
  runnerParams?: Omit<NpmRunnerParams, "env" | "npmArgs">;
  sourceEnv?: NodeJS.ProcessEnv;
  timeoutMs: number;
};
export function compareNpmPackInventory(
  tarFiles: Iterable<string>,
  npmFiles: Iterable<string>,
  ignoredPaths: Iterable<string> = [],
): { extra: string[]; missing: string[] } {
  const ignored = new Set(ignoredPaths);
  const tarSet = new Set([...tarFiles].filter((entry) => !ignored.has(entry)));
  const npmSet = new Set([...npmFiles].filter((entry) => !ignored.has(entry)));
  return {
    extra: [...tarSet].filter((entry) => !npmSet.has(entry)).toSorted(),
    missing: [...npmSet].filter((entry) => !tarSet.has(entry)).toSorted(),
  };
}

function normalizePackagePath(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("npm pack returned a file entry without a string path");
  }
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/u, "");
  if (
    !normalized ||
    normalized.endsWith("/") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    normalized.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`npm pack returned an invalid package path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function parseNpmPackFiles(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("npm pack returned invalid JSON");
  }
  const entries = resolveNpmJsonEntries(parsed);
  if (entries.length !== 1 || !isRecord(entries[0])) {
    throw new Error("npm pack JSON must contain exactly one package result");
  }
  const files = entries[0].files;
  if (!Array.isArray(files)) {
    throw new Error("npm pack JSON result is missing its files array");
  }
  const normalizedFiles: string[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    if (!isRecord(entry)) {
      throw new Error("npm pack returned an invalid file entry");
    }
    const file = normalizePackagePath(entry.path);
    if (seen.has(file)) {
      throw new Error(`npm pack returned duplicate package path ${file}`);
    }
    seen.add(file);
    normalizedFiles.push(file);
  }
  return normalizedFiles.toSorted();
}

function controlledNpmEnvironment(
  sourceEnv: NodeJS.ProcessEnv,
  sandbox: NpmSandbox,
): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(
      ([key]) => !/^npm_/iu.test(key) && !ISOLATED_ENV_KEYS.includes(key.toUpperCase()),
    ),
  );
  return {
    ...env,
    HOME: sandbox.homeDir,
    INIT_CWD: sandbox.cwd,
    NPM_CONFIG_CACHE: sandbox.cacheDir,
    NPM_CONFIG_GLOBALCONFIG: path.join(sandbox.configDir, "global.npmrc"),
    NPM_CONFIG_USERCONFIG: path.join(sandbox.configDir, "user.npmrc"),
    PWD: sandbox.cwd,
    USERPROFILE: sandbox.homeDir,
    XDG_CACHE_HOME: sandbox.cacheDir,
    XDG_CONFIG_HOME: sandbox.configDir,
  };
}

function describeSpawnFailure(
  label: string,
  result: { error?: unknown; status?: number; stderr: string },
  timeoutMs: number,
): string {
  const code = isRecord(result.error) ? result.error.code : undefined;
  const knownFailure =
    typeof code === "string"
      ? (
          {
            ENOBUFS: "exceeded its output limit",
            ENOENT: "executable was not found",
            ETIMEDOUT: `timed out after ${timeoutMs}ms`,
          } as Record<string, string>
        )[code]
      : undefined;
  if (knownFailure) {
    return `${label} ${knownFailure}`;
  }
  const detail =
    result.stderr.trim().slice(0, 2_000) ||
    (result.error instanceof Error ? result.error.message : "");
  return `${label} failed${detail ? `: ${detail}` : ` with status ${String(result.status)}`}`;
}

async function withoutPackageScripts<T>(packageRoot: string, run: () => Promise<T>): Promise<T> {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const originalBytes = fs.readFileSync(packageJsonPath);
  const originalMode = fs.statSync(packageJsonPath).mode;
  const packageJson = JSON.parse(originalBytes.toString("utf8")) as unknown;
  if (!isRecord(packageJson)) {
    throw new Error("package.json must contain an object");
  }
  delete packageJson.scripts;

  // Callers provide unique extracted trees. Restore only after their reader/writer has joined.
  let failure: unknown;
  try {
    if ((originalMode & 0o200) === 0) {
      fs.chmodSync(packageJsonPath, originalMode | 0o200);
    }
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson));
    return await run();
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (!hasUnjoinedWork(failure)) {
      try {
        fs.writeFileSync(packageJsonPath, originalBytes);
      } finally {
        fs.chmodSync(packageJsonPath, originalMode);
      }
    }
  }
}

export async function collectNpmPackInventory(
  packageRoot: string,
  options: NpmPackInventoryOptions,
) {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-npm-pack-inventory-"));
  const sandbox = {
    cacheDir: path.join(sandboxRoot, "cache"),
    configDir: path.join(sandboxRoot, "config"),
    cwd: path.join(sandboxRoot, "cwd"),
    homeDir: path.join(sandboxRoot, "home"),
  };
  for (const directory of Object.values(sandbox)) {
    fs.mkdirSync(directory);
  }
  fs.writeFileSync(path.join(sandbox.configDir, "global.npmrc"), "", { mode: 0o600 });
  fs.writeFileSync(path.join(sandbox.configDir, "user.npmrc"), "", { mode: 0o600 });

  const npmEnv = controlledNpmEnvironment(options.sourceEnv ?? process.env, sandbox);
  const runNpm = async (
    label: string,
    args: string[],
    timeout: number,
    maxBuffer: number,
  ): Promise<string> => {
    const npm = resolveNpmRunner({
      env: npmEnv,
      npmArgs: [`--prefix=${sandbox.cwd}`, ...args],
      ...options.runnerParams,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const abort = new AbortController();
    let capturedBytes = 0;
    let overflow: Error | undefined;
    let status: number;
    try {
      status = await runManagedCommand({
        bin: npm.command,
        args: npm.args,
        cwd: sandbox.cwd,
        env: npm.env ?? npmEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: npm.shell,
        timeoutMs: timeout,
        windowsHide: true,
        windowsVerbatimArguments: npm.windowsVerbatimArguments,
        signal: abort.signal,
        onReady(child) {
          for (const capture of [
            { stream: child.stdout, chunks: stdout },
            { stream: child.stderr, chunks: stderr },
          ]) {
            capture.stream?.on("data", (chunk: Buffer) => {
              if (overflow) {
                return;
              }
              // spawnSync applies one byte cap across all captured output pipes.
              capturedBytes += chunk.byteLength;
              if (capturedBytes > maxBuffer) {
                overflow = Object.assign(new Error("npm output limit exceeded"), {
                  code: "ENOBUFS",
                });
                // Stop retaining bytes immediately, but let the owner drain and join the tree.
                abort.abort();
                return;
              }
              capture.chunks.push(chunk);
            });
          }
        },
      });
    } catch (error) {
      throw new Error(
        describeSpawnFailure(
          label,
          {
            error: hasUnjoinedWork(error) ? error : (overflow ?? error),
            stderr: Buffer.concat(stderr).toString("utf8"),
          },
          timeout,
        ),
        { cause: error },
      );
    }
    if (status !== 0 || overflow) {
      throw new Error(
        describeSpawnFailure(
          label,
          { error: overflow, status, stderr: Buffer.concat(stderr).toString("utf8") },
          timeout,
        ),
      );
    }
    return Buffer.concat(stdout).toString("utf8");
  };
  const startedAt = Date.now();
  let failure: unknown;
  try {
    // The pack result proves npm availability without a separate diagnostic probe.
    const packOutput = await withoutPackageScripts(packageRoot, () =>
      runNpm(
        "npm pack inventory",
        [
          "pack",
          packageRoot,
          "--dry-run",
          "--json",
          "--ignore-scripts",
          "--offline",
          "--workspaces=false",
          "--include-workspace-root=false",
          "--audit=false",
          "--fund=false",
          "--update-notifier=false",
          "--color=false",
          "--loglevel=error",
        ],
        options.timeoutMs,
        64 * 1024 * 1024,
      ),
    );
    if (fs.readdirSync(sandbox.cwd).length !== 0) {
      throw new Error("npm pack inventory wrote files outside the extracted package root");
    }
    return {
      durationMs: Date.now() - startedAt,
      files: parseNpmPackFiles(packOutput),
    };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (hasUnjoinedWork(failure)) {
      console.error(
        `npm pack inventory: child cleanup unverified; retained ${sandboxRoot} and ${packageRoot}`,
      );
    } else {
      fs.rmSync(sandboxRoot, { force: true, recursive: true });
    }
  }
}

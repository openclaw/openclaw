import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { hasUnjoinedWork, runManagedCommand } from "./managed-child-process.mjs";
import { parseReleaseVersion } from "./release-version.mjs";

const REGISTRY = "https://registry.npmjs.org";
const GITHUB = "https://api.github.com/repos/openclaw/openclaw/git";
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const selectionSchema = z
  .object({
    schema: z.literal(1),
    targetSha: z.string().regex(SHA),
    version: z.string(),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/u),
    tarball: z.string().url(),
    sourceSha: z.string().regex(SHA),
    packageSha256: z.string().regex(DIGEST),
    lockSha256: z.string().regex(DIGEST),
    nodeVersion: z.string(),
    npmVersion: z.string(),
    platform: z.string(),
    arch: z.string(),
  })
  .strict();
type Selection = z.infer<typeof selectionSchema>;
type SelectionOptions = { selectionDir: string; targetSha: string; signal: AbortSignal };

function digest(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function requireStable(version: string): void {
  const parsed = parseReleaseVersion(version);
  if (!parsed || parsed.channel !== "stable" || parsed.patch >= 33) {
    throw new Error("The stable Gateway must be a regular stable OpenClaw release.");
  }
}

async function metadata(url: string, signal: AbortSignal): Promise<unknown> {
  const github = url.startsWith(`${GITHUB}/`);
  const token = github
    ? process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim()
    : undefined;
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    headers: {
      Accept: "application/json",
      "User-Agent": "openclaw-ios-qualification",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(
      `Stable Gateway ${github ? "GitHub tag" : "npm registry"} metadata request failed (HTTP ${response.status}).`,
    );
  }
  return response.json();
}

async function sourceSha(version: string, signal: AbortSignal): Promise<string> {
  const objectSchema = z.object({
    object: z.object({ type: z.string(), sha: z.string().regex(SHA) }),
  });
  let { object } = objectSchema.parse(await metadata(`${GITHUB}/ref/tags/v${version}`, signal));
  if (object.type === "tag") {
    ({ object } = objectSchema.parse(await metadata(`${GITHUB}/tags/${object.sha}`, signal)));
  }
  if (object.type !== "commit") {
    throw new Error("Stable Gateway release tag must resolve to a commit.");
  }
  return object.sha;
}

async function npm(args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  // Package lifecycle scripts get task-owned state and public-registry access, never operator credentials.
  const home = await mkdtemp(path.join(path.dirname(cwd), ".ios-gateway-npm-"));
  let unjoined = false;
  try {
    await Promise.all([
      writeFile(path.join(home, "user.npmrc"), ""),
      writeFile(path.join(home, "global.npmrc"), ""),
      mkdir(path.join(home, "tmp")),
    ]);
    let stdout = "";
    const overflow = new AbortController();
    let bytes = 0;
    const code = await runManagedCommand({
      bin: "npm",
      args,
      cwd,
      env: {
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        TMPDIR: path.join(home, "tmp"),
        LANG: "en_US.UTF-8",
        CI: "true",
        npm_config_userconfig: path.join(home, "user.npmrc"),
        npm_config_globalconfig: path.join(home, "global.npmrc"),
        npm_config_registry: REGISTRY,
        npm_config_cache: path.join(home, "cache"),
        npm_config_update_notifier: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: 900_000,
      signal: AbortSignal.any([signal, overflow.signal]),
      requireProcessTreeExit: true,
      onReady(child) {
        for (const stream of [child.stdout, child.stderr]) {
          stream?.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 16 * 1024 * 1024) {
              overflow.abort();
            } else if (stream === child.stdout) {
              stdout += chunk.toString("utf8");
            } else {
              process.stderr.write(chunk);
            }
          });
        }
      },
    });
    if (code !== 0 || overflow.signal.aborted) {
      throw new Error(`Stable Gateway npm ${args[0]} failed (exit ${code}).`);
    }
    return stdout.trim();
  } catch (error) {
    unjoined = hasUnjoinedWork(error);
    throw error;
  } finally {
    if (!unjoined) {
      await rm(home, { recursive: true, force: true });
    }
  }
}

function validateLock(selection: Selection, packageBytes: string, lockBytes: string): void {
  if (
    digest(packageBytes) !== selection.packageSha256 ||
    digest(lockBytes) !== selection.lockSha256
  ) {
    throw new Error("Stable Gateway selection manifests changed.");
  }
  const wrapper = z
    .object({ private: z.literal(true), dependencies: z.object({ openclaw: z.string() }).strict() })
    .parse(JSON.parse(packageBytes));
  const lock = z
    .object({
      lockfileVersion: z.literal(3),
      packages: z.record(z.string(), z.unknown()),
    })
    .parse(JSON.parse(lockBytes));
  const root = z
    .object({ dependencies: z.object({ openclaw: z.string() }) })
    .parse(lock.packages[""]);
  const installed = z
    .object({ version: z.string(), resolved: z.string(), integrity: z.string() })
    .parse(lock.packages["node_modules/openclaw"]);
  if (
    wrapper.dependencies.openclaw !== selection.version ||
    root.dependencies.openclaw !== selection.version ||
    installed.version !== selection.version ||
    installed.resolved !== selection.tarball ||
    installed.integrity !== selection.integrity
  ) {
    throw new Error("Stable Gateway package lock does not match the selected release.");
  }
}

async function readSelection(options: SelectionOptions): Promise<Selection> {
  const selection = selectionSchema.parse(
    JSON.parse(await readFile(path.join(options.selectionDir, "selection.json"), "utf8")),
  );
  requireStable(selection.version);
  if (
    selection.targetSha !== options.targetSha ||
    selection.tarball !== `${REGISTRY}/openclaw/-/openclaw-${selection.version}.tgz`
  ) {
    throw new Error("Stable Gateway selection does not match this qualification target.");
  }
  if (
    selection.nodeVersion !== process.version ||
    selection.platform !== process.platform ||
    selection.arch !== process.arch
  ) {
    throw new Error(
      "Replay requires the Node version and platform recorded in the Gateway selection.",
    );
  }
  const [packageBytes, lockBytes] = await Promise.all([
    readFile(path.join(options.selectionDir, "package.json"), "utf8"),
    readFile(path.join(options.selectionDir, "package-lock.json"), "utf8"),
  ]);
  validateLock(selection, packageBytes, lockBytes);
  if ((await npm(["--version"], options.selectionDir, options.signal)) !== selection.npmVersion) {
    throw new Error("Replay requires the npm version recorded in the Gateway selection.");
  }
  return selection;
}

/** The directory is the replayable input artifact; an incomplete existing selection never floats to latest. */
export async function selectIOSReleaseGateway(options: SelectionOptions): Promise<Selection> {
  options.signal.throwIfAborted();
  if (!SHA.test(options.targetSha)) {
    throw new Error("Stable Gateway selection requires a full candidate source SHA.");
  }
  const selectionDir = path.resolve(options.selectionDir);
  const { lstat } = await import("node:fs/promises");
  const exists = await lstat(selectionDir).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return false;
      }
      throw error;
    },
  );
  if (exists) {
    return readSelection({ ...options, selectionDir });
  }
  await mkdir(path.dirname(selectionDir), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(selectionDir), ".ios-gateway-selection-"));
  let unjoined = false;
  try {
    const info = z
      .object({
        name: z.literal("openclaw"),
        version: z.string(),
        dist: z.object({ tarball: z.string(), integrity: z.string() }),
      })
      .parse(await metadata(`${REGISTRY}/openclaw/latest`, options.signal));
    requireStable(info.version);
    if (info.dist.tarball !== `${REGISTRY}/openclaw/-/openclaw-${info.version}.tgz`) {
      throw new Error("Stable Gateway metadata has an unexpected tarball URL.");
    }
    const sha = await sourceSha(info.version, options.signal);
    const npmVersion = await npm(["--version"], staging, options.signal);
    const packageBytes = `${JSON.stringify({ name: "openclaw-ios-qualification", version: "0.0.0", private: true, dependencies: { openclaw: info.version } }, null, 2)}\n`;
    await writeFile(path.join(staging, "package.json"), packageBytes);
    await npm(
      ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
      staging,
      options.signal,
    );
    const lockBytes = await readFile(path.join(staging, "package-lock.json"), "utf8");
    const selection = selectionSchema.parse({
      schema: 1,
      targetSha: options.targetSha,
      version: info.version,
      integrity: info.dist.integrity,
      tarball: info.dist.tarball,
      sourceSha: sha,
      packageSha256: digest(packageBytes),
      lockSha256: digest(lockBytes),
      nodeVersion: process.version,
      npmVersion,
      platform: process.platform,
      arch: process.arch,
    });
    validateLock(selection, packageBytes, lockBytes);
    await writeFile(
      path.join(staging, "selection.json"),
      `${JSON.stringify(selection, null, 2)}\n`,
    );
    options.signal.throwIfAborted();
    await rename(staging, selectionDir);
    return selection;
  } catch (error) {
    unjoined = hasUnjoinedWork(error);
    throw error;
  } finally {
    if (!unjoined) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export async function prepareIOSReleaseGateway(options: SelectionOptions & { installDir: string }) {
  const selection = await selectIOSReleaseGateway(options);
  await mkdir(options.installDir);
  await Promise.all(
    ["package.json", "package-lock.json"].map((file) =>
      copyFile(path.join(options.selectionDir, file), path.join(options.installDir, file)),
    ),
  );
  await npm(["ci", "--no-audit", "--no-fund"], options.installDir, options.signal);
  const cwd = path.join(options.installDir, "node_modules", "openclaw");
  const [packageBytes, buildBytes, installedLock] = await Promise.all([
    readFile(path.join(cwd, "package.json"), "utf8"),
    readFile(path.join(cwd, "dist", "build-info.json"), "utf8"),
    readFile(path.join(options.installDir, "package-lock.json"), "utf8"),
  ]);
  const pkg = z
    .object({
      name: z.literal("openclaw"),
      version: z.string(),
      bin: z.object({ openclaw: z.literal("openclaw.mjs") }),
    })
    .parse(JSON.parse(packageBytes));
  const build = z.object({ commit: z.string().regex(SHA) }).parse(JSON.parse(buildBytes));
  if (
    pkg.version !== selection.version ||
    build.commit !== selection.sourceSha ||
    digest(installedLock) !== selection.lockSha256
  ) {
    throw new Error("Installed Gateway identity differs from the selected stable release.");
  }
  options.signal.throwIfAborted();
  return { cwd, entrypoint: [path.join(cwd, "openclaw.mjs")], identity: selection };
}

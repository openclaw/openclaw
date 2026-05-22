import { constants as fsConstants, type Stats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import {
  FsSafeError,
  isPathInside,
  resolveOpenedFileRealPathForHandle,
  sameFileIdentity,
  type DenyMutationPolicy,
} from "../infra/fs-safe.js";
import { expandHomePrefix, resolveEffectiveHomeDir, resolveOsHomeDir } from "../infra/home-dir.js";

const HOME_DENIED_PATHS = [
  [".ssh", "authorized_keys"],
  [".ssh", "id_rsa"],
  [".ssh", "id_ed25519"],
  [".ssh", "config"],
  [".bashrc"],
  [".zshrc"],
  [".profile"],
  [".bash_profile"],
  [".zprofile"],
  [".netrc"],
  [".pgpass"],
  [".npmrc"],
  [".pypirc"],
] as const;

const HOME_DENIED_PREFIXES = [
  [".ssh"],
  [".aws"],
  [".gnupg"],
  [".kube"],
  [".docker"],
  [".azure"],
  [".config", "gh"],
] as const;

const POSIX_DENIED_PATHS = ["/etc/sudoers", "/etc/passwd", "/etc/shadow"] as const;
const POSIX_DENIED_PREFIXES = ["/etc/sudoers.d", "/etc/systemd"] as const;

export type SensitiveHostDenyMutationOptions = {
  agentDirs?: readonly string[];
};

function normalizeEnvPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

function addAbsolutePath(paths: Set<string>, candidate: string | undefined): void {
  if (!candidate) {
    return;
  }
  const resolved = path.resolve(candidate);
  if (path.isAbsolute(resolved)) {
    paths.add(resolved);
  }
}

function isNotFoundPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function assertNoNulPathInput(filePath: string, message = "path contains a NUL byte") {
  if (filePath.includes("\0")) {
    throw new FsSafeError("invalid-path", message);
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.lstat(filePath);
    return true;
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      throw error;
    }
    return false;
  }
}

async function resolvePathViaExistingAncestor(targetPath: string): Promise<string> {
  const normalized = path.resolve(targetPath);
  let cursor = normalized;
  const missingSuffix: string[] = [];

  while (path.dirname(cursor) !== cursor && !(await pathExists(cursor))) {
    missingSuffix.unshift(path.basename(cursor));
    cursor = path.dirname(cursor);
  }

  if (!(await pathExists(cursor))) {
    return normalized;
  }

  try {
    const resolvedAncestor = path.resolve(await fs.realpath(cursor));
    return missingSuffix.length === 0
      ? resolvedAncestor
      : path.resolve(resolvedAncestor, ...missingSuffix);
  } catch {
    return normalized;
  }
}

async function comparablePaths(rawPath: string): Promise<Set<string>> {
  assertNoNulPathInput(rawPath, "path contains a NUL byte");
  const resolved = path.resolve(rawPath);
  return new Set([resolved, await resolvePathViaExistingAncestor(resolved)]);
}

function isSamePath(left: string, right: string): boolean {
  return isPathInside(left, right) && isPathInside(right, left);
}

function policyPathEntries(entries: readonly string[] | undefined): string[] {
  const paths: string[] = [];
  for (const entry of entries ?? []) {
    if (entry.length === 0) {
      throw new FsSafeError("invalid-path", "deny mutation paths must be non-empty");
    }
    assertNoNulPathInput(entry, "deny mutation path contains a NUL byte");
    if (!path.isAbsolute(entry)) {
      throw new FsSafeError("invalid-path", "deny mutation paths must be absolute");
    }
    paths.push(entry);
  }
  return paths;
}

function throwDeniedMutation(): never {
  throw new FsSafeError("denied-path", "path is denied by denyMutations policy");
}

async function assertMutationNotDenied(
  filePath: string,
  policy: DenyMutationPolicy,
): Promise<void> {
  const targetPaths = await comparablePaths(filePath);
  for (const deniedPath of policyPathEntries(policy.paths)) {
    const deniedPaths = await comparablePaths(deniedPath);
    for (const target of targetPaths) {
      for (const denied of deniedPaths) {
        if (isSamePath(denied, target)) {
          throwDeniedMutation();
        }
      }
    }
  }

  for (const deniedPrefix of policyPathEntries(policy.prefixes)) {
    const deniedPaths = await comparablePaths(deniedPrefix);
    for (const target of targetPaths) {
      for (const denied of deniedPaths) {
        if (isPathInside(denied, target)) {
          throwDeniedMutation();
        }
      }
    }
  }
}

async function statExistingPath(filePath: string): Promise<Stats | undefined> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      throw error;
    }
    return undefined;
  }
}

function isHardlinkedRegularFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink > 1;
}

async function assertOpenedFileNotDeniedByIdentity(
  openedStat: Stats,
  policy: DenyMutationPolicy,
): Promise<void> {
  for (const deniedPath of policyPathEntries(policy.paths)) {
    const deniedStat = await statExistingPath(deniedPath);
    if (deniedStat && sameFileIdentity(openedStat, deniedStat)) {
      throwDeniedMutation();
    }
  }

  // Hardlinks have no unique path. Without scanning every sensitive prefix on
  // each write, a harmless-looking alias can still mutate a denied inode.
  if (isHardlinkedRegularFile(openedStat)) {
    throwDeniedMutation();
  }
}

async function assertOpenedHostFileMutationAllowed(
  handle: FileHandle,
  ioPath: string,
  policy: DenyMutationPolicy,
): Promise<void> {
  const openedRealPath = await resolveOpenedFileRealPathForHandle(handle, ioPath);
  await assertMutationNotDenied(openedRealPath, policy);
  await assertOpenedFileNotDeniedByIdentity(await handle.stat(), policy);
}

async function openExistingHostFileForWrite(filePath: string): Promise<FileHandle | undefined> {
  try {
    return await fs.open(filePath, fsConstants.O_WRONLY);
  } catch (error) {
    if (!isNotFoundPathError(error)) {
      throw error;
    }
    return undefined;
  }
}

async function writeOpenedHostFileWithDenyMutations(
  handle: FileHandle,
  ioPath: string,
  content: string,
  policy: DenyMutationPolicy,
): Promise<void> {
  try {
    await assertOpenedHostFileMutationAllowed(handle, ioPath, policy);
    await handle.truncate(0);
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
}

function addHomeSensitivePaths(home: string, paths: Set<string>, prefixes: Set<string>): void {
  const resolvedHome = path.resolve(home);
  if (resolvedHome === path.parse(resolvedHome).root) {
    return;
  }
  for (const suffix of HOME_DENIED_PATHS) {
    addAbsolutePath(paths, path.join(resolvedHome, ...suffix));
  }
  for (const suffix of HOME_DENIED_PREFIXES) {
    addAbsolutePath(prefixes, path.join(resolvedHome, ...suffix));
  }
}

function addHomeRoot(roots: Set<string>, candidate: string | undefined, env: NodeJS.ProcessEnv) {
  const normalized = normalizeEnvPath(candidate);
  if (!normalized) {
    return;
  }
  roots.add(path.resolve(expandHomePrefix(normalized, { env })));
}

function collectHomeRoots(env: NodeJS.ProcessEnv): string[] {
  const roots = new Set<string>();
  for (const candidate of [resolveOsHomeDir(env), resolveEffectiveHomeDir(env)]) {
    if (candidate) {
      roots.add(candidate);
    }
  }
  addHomeRoot(roots, env.HOME, env);
  addHomeRoot(roots, env.USERPROFILE, env);
  return [...roots];
}

function collectStatePaths(env: NodeJS.ProcessEnv, paths: Set<string>, prefixes: Set<string>) {
  const stateDir = resolveStateDir(env);
  const oauthDir = resolveOAuthDir(env, stateDir);
  addAbsolutePath(paths, path.join(stateDir, ".env"));
  addAbsolutePath(prefixes, path.join(stateDir, "credentials"));
  addAbsolutePath(prefixes, path.join(stateDir, "agents"));
  addAbsolutePath(prefixes, oauthDir);
}

function collectAgentAuthProfilePaths(
  env: NodeJS.ProcessEnv,
  paths: Set<string>,
  options?: SensitiveHostDenyMutationOptions,
) {
  for (const agentDir of [
    env.OPENCLAW_AGENT_DIR,
    env.PI_CODING_AGENT_DIR,
    ...(options?.agentDirs ?? []),
  ]) {
    if (!agentDir?.trim()) {
      continue;
    }
    const resolved = path.resolve(expandHomePrefix(agentDir, { env }));
    addAbsolutePath(paths, path.join(resolved, "auth-profiles.json"));
    addAbsolutePath(paths, path.join(resolved, "agent", "auth-profiles.json"));
  }
}

export function buildSensitiveHostDenyMutations(
  env: NodeJS.ProcessEnv = process.env,
  options?: SensitiveHostDenyMutationOptions,
): DenyMutationPolicy {
  const paths = new Set<string>();
  const prefixes = new Set<string>();

  for (const home of collectHomeRoots(env)) {
    addHomeSensitivePaths(home, paths, prefixes);
  }
  collectStatePaths(env, paths, prefixes);
  collectAgentAuthProfilePaths(env, paths, options);

  if (process.platform !== "win32") {
    for (const blockedPath of POSIX_DENIED_PATHS) {
      addAbsolutePath(paths, blockedPath);
    }
    for (const blockedPrefix of POSIX_DENIED_PREFIXES) {
      addAbsolutePath(prefixes, blockedPrefix);
    }
  }

  return {
    paths: [...paths].toSorted(),
    prefixes: [...prefixes].toSorted(),
  };
}

export function resolveHostToolPath(filePath: string): string {
  const home = resolveOsHomeDir();
  const expanded = home ? expandHomePrefix(filePath, { home }) : filePath;
  return path.resolve(expanded);
}

export async function assertHostMutationAllowed(
  absolutePath: string,
  options?: SensitiveHostDenyMutationOptions,
): Promise<void> {
  await assertMutationNotDenied(
    path.resolve(absolutePath),
    buildSensitiveHostDenyMutations(process.env, options),
  );
}

export async function writeHostFileWithDenyMutations(
  absolutePath: string,
  content: string,
  options?: SensitiveHostDenyMutationOptions,
): Promise<void> {
  const resolved = path.resolve(absolutePath);
  const policy = buildSensitiveHostDenyMutations(process.env, options);
  await assertMutationNotDenied(resolved, policy);
  const existingHandle = await openExistingHostFileForWrite(resolved);
  if (existingHandle) {
    await writeOpenedHostFileWithDenyMutations(existingHandle, resolved, content, policy);
    return;
  }

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await assertMutationNotDenied(resolved, policy);
  try {
    await fs.writeFile(resolved, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
      throw error;
    }
    const racedHandle = await openExistingHostFileForWrite(resolved);
    if (!racedHandle) {
      throw error;
    }
    await writeOpenedHostFileWithDenyMutations(racedHandle, resolved, content, policy);
  }
}

export async function mkdirHostPathWithDenyMutations(
  dir: string,
  options?: SensitiveHostDenyMutationOptions,
): Promise<void> {
  const resolved = path.resolve(dir);
  await assertHostMutationAllowed(resolved, options);
  await fs.mkdir(resolved, { recursive: true });
}

export async function removeHostPathWithDenyMutations(
  filePath: string,
  options?: SensitiveHostDenyMutationOptions,
): Promise<void> {
  const resolved = path.resolve(filePath);
  await assertHostMutationAllowed(resolved, options);
  await fs.rm(resolved);
}

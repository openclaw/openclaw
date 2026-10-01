/** Filesystem ownership guards for isolated Computer Use service provisioning. */
import fs from "node:fs/promises";
import path from "node:path";
import {
  assertDirectoryIdentitySync,
  readDirectoryIdentity,
  type DirectoryIdentity,
} from "@openclaw/fs-safe/advanced";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { assertNoSymlinkParents, pathScope } from "openclaw/plugin-sdk/security-runtime";

type OwnedServiceParent = DirectoryIdentity & {
  logicalPath: string;
};

export async function assertOwnedServicePath(params: {
  ownershipRoot: string;
  codexHome: string;
  targetParent: string;
  targetPath: string;
}): Promise<void> {
  await assertOwnedCodexHomePath({
    ownershipRoot: params.ownershipRoot,
    codexHome: params.codexHome,
    allowMissing: true,
  });
  assertPathAtOrInside(params.ownershipRoot, params.targetParent, "Computer Use service parent");
  await assertNoSymlinkParents({
    rootDir: params.ownershipRoot,
    targetPath: params.targetParent,
    allowMissing: true,
    requireDirectories: true,
    messagePrefix: "Computer Use service path",
  });
  await assertNotSymlink(params.targetPath, "Computer Use service target");
}

export async function ensureOwnedCodexHome(
  codexHomeInput: string,
  ownershipRootInput = path.dirname(path.resolve(codexHomeInput)),
): Promise<void> {
  const codexHome = path.resolve(codexHomeInput);
  const ownershipRoot = path.resolve(ownershipRootInput);
  await fs.mkdir(ownershipRoot, { recursive: true, mode: 0o700 });
  await assertOwnedCodexHomePath({ ownershipRoot, codexHome, allowMissing: true });
  await ensureRealDirectoryTree(ownershipRoot, codexHome, "isolated Codex home");
  await assertOwnedCodexHomePath({ ownershipRoot, codexHome, allowMissing: false });
}

export async function prepareOwnedServiceParent(params: {
  ownershipRoot: string;
  codexHome: string;
  targetParent: string;
}): Promise<OwnedServiceParent> {
  await ensureOwnedCodexHome(params.codexHome, params.ownershipRoot);
  await ensureRealDirectoryTree(
    params.ownershipRoot,
    params.targetParent,
    "Computer Use service parent",
  );
  await assertNoSymlinkParents({
    rootDir: params.ownershipRoot,
    targetPath: params.targetParent,
    allowMissing: false,
    requireDirectories: true,
    messagePrefix: "Computer Use service path",
  });
  const [rootIdentity, parentIdentity] = await Promise.all([
    readRealDirectoryIdentity(params.ownershipRoot, "Computer Use ownership root"),
    readRealDirectoryIdentity(params.targetParent, "Computer Use service parent"),
  ]);
  assertPathAtOrInside(
    rootIdentity.realPath,
    parentIdentity.realPath,
    "canonical Computer Use service parent",
  );
  return parentIdentity;
}

async function assertOwnedCodexHomePath(params: {
  ownershipRoot: string;
  codexHome: string;
  allowMissing: boolean;
}): Promise<void> {
  await readRealDirectoryIdentity(params.ownershipRoot, "Computer Use ownership root");
  assertPathAtOrInside(params.ownershipRoot, params.codexHome, "isolated Codex home");
  await assertNoSymlinkParents({
    rootDir: params.ownershipRoot,
    targetPath: params.codexHome,
    allowMissing: params.allowMissing,
    requireDirectories: true,
    messagePrefix: "Computer Use service path",
  });
}

export async function readRealDirectoryIdentity(
  directoryPath: string,
  label: string,
): Promise<OwnedServiceParent> {
  const logicalPath = path.resolve(directoryPath);
  try {
    const identity = await readDirectoryIdentity(logicalPath);
    assertDirectoryIdentitySync(logicalPath, identity);
    return { logicalPath, ...identity };
  } catch (cause) {
    throw new Error(`${label} must remain a real directory: ${logicalPath}`, { cause });
  }
}

export async function assertOwnedServiceParentStable(parent: OwnedServiceParent): Promise<void> {
  await assertDirectoryIdentityStable(parent, "Computer Use service parent");
}

export async function assertDirectoryIdentityStable(
  expected: OwnedServiceParent,
  label: string,
): Promise<void> {
  if (!(await directoryIdentityIsStable(expected))) {
    throw new Error(`${label} changed during refresh; refusing to mutate the replacement path.`);
  }
}

export async function directoryIdentityIsStable(expected: OwnedServiceParent): Promise<boolean> {
  try {
    assertDirectoryIdentitySync(expected.logicalPath, expected);
    return true;
  } catch {
    return false;
  }
}

export async function assertNotSymlink(filePath: string, label: string): Promise<void> {
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${filePath}`);
    }
  } catch (error) {
    if (extractErrorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function ensureRealDirectoryTree(
  ownershipRoot: string,
  directoryPath: string,
  label: string,
): Promise<void> {
  const root = path.resolve(ownershipRoot);
  const target = path.resolve(directoryPath);
  assertPathAtOrInside(root, target, label);
  if (root !== target) {
    // The separator preserves literal trailing whitespace through pathScope's input trimming.
    const prepared = await pathScope(root, { label }).ensureDir(`${target}${path.sep}`, {
      mode: 0o700,
    });
    if (!prepared.ok) {
      throw new Error(`${label} must traverse real directories: ${prepared.error}`, {
        cause: prepared.diagnostic,
      });
    }
  }
  await readRealDirectoryIdentity(target, label);
}

function assertPathAtOrInside(rootPath: string, candidatePath: string, label: string): void {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must remain inside ${path.resolve(rootPath)}.`);
  }
}

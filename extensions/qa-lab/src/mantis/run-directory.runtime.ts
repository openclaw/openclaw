import fs from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkParents } from "openclaw/plugin-sdk/security-runtime";

export type MantisDirectoryOwnership = {
  parentDevice: bigint;
  parentInode: bigint;
  targetDevice: bigint;
  targetInode: bigint;
};

export async function captureMantisDirectoryOwnership(params: {
  directoryPath: string;
  repoRoot: string;
}): Promise<MantisDirectoryOwnership> {
  const repoRoot = path.resolve(params.repoRoot);
  const directoryPath = path.resolve(params.directoryPath);

  await assertNoSymlinkParents({ rootDir: repoRoot, targetPath: directoryPath });
  const [parentStat, targetStat] = await Promise.all([
    fs.lstat(path.dirname(directoryPath), { bigint: true }),
    fs.lstat(directoryPath, { bigint: true }),
  ]);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`Mantis owned path is not a real directory: ${directoryPath}`);
  }
  return {
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
    targetDevice: targetStat.dev,
    targetInode: targetStat.ino,
  };
}

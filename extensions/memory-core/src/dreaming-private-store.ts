import path from "node:path";
import { privateFileStore } from "openclaw/plugin-sdk/security-runtime";

const DREAMING_ARTIFACTS_RELATIVE_DIR = path.join("memory", ".dreams");

function resolveDreamingArtifactsDir(workspaceDir: string): string {
  return path.join(workspaceDir, DREAMING_ARTIFACTS_RELATIVE_DIR);
}

function resolveDreamingArtifactPath(workspaceRelativePath: string): string {
  const relativePath = path.relative(DREAMING_ARTIFACTS_RELATIVE_DIR, workspaceRelativePath);
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(
      `Dreaming private artifact path must be under memory/.dreams: ${workspaceRelativePath}`,
    );
  }
  return relativePath;
}

export async function readDreamingPrivateJsonIfExists<T = unknown>(
  workspaceDir: string,
  workspaceRelativePath: string,
): Promise<T | null> {
  return await privateFileStore(resolveDreamingArtifactsDir(workspaceDir)).readJsonIfExists<T>(
    resolveDreamingArtifactPath(workspaceRelativePath),
  );
}

export async function writeDreamingPrivateJson(
  workspaceDir: string,
  workspaceRelativePath: string,
  value: unknown,
): Promise<void> {
  await privateFileStore(resolveDreamingArtifactsDir(workspaceDir)).writeJson(
    resolveDreamingArtifactPath(workspaceRelativePath),
    value,
    { trailingNewline: true },
  );
}

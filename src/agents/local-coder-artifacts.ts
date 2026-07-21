import { cp, lstat, mkdir, readFile, rename, symlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const LOCAL_CODER_AGENT_ID = "local-coder";
export const LOCAL_CODER_SCRATCH_DIRNAME = "scratch";
export const LOCAL_CODER_COMPLETION_CONTRACT =
  "A local-coder completion with no verified output is a blocked terminal result. " +
  "The local coder owns writes inside the shared scratch directory. " +
  "The parent must not persist or copy the child's artifact onto its own path. " +
  "Only host-visible artifacts under the allowed scratch directory may be reported.";

export function isPathInsideRoot(path: string, root: string): boolean {
  const remainder = relative(resolve(root), resolve(path));
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

export function validateLocalCoderArtifactPath(
  artifactPath: string,
  params: { hostScratchRoot: string },
): string {
  const canonical = resolve(artifactPath);
  if (
    !isPathInsideRoot(canonical, params.hostScratchRoot) ||
    canonical === resolve(params.hostScratchRoot)
  ) {
    throw new Error(`local-coder artifact path escapes shared scratch: ${artifactPath}`);
  }
  return canonical;
}

type LocalCoderScratchRoots = { hostScratchRoot: string; coderScratchRoot: string };

export function resolveLocalCoderScratchRoots(params: {
  hostScratchRoot: string;
  coderWorkspaceRoot: string;
}): LocalCoderScratchRoots {
  return {
    hostScratchRoot: resolve(params.hostScratchRoot),
    coderScratchRoot: resolve(params.coderWorkspaceRoot, LOCAL_CODER_SCRATCH_DIRNAME),
  };
}

export async function ensureSharedLocalCoderScratch(
  params: LocalCoderScratchRoots,
): Promise<LocalCoderScratchRoots> {
  const roots = {
    hostScratchRoot: resolve(params.hostScratchRoot),
    coderScratchRoot: resolve(params.coderScratchRoot),
  };
  await mkdir(roots.hostScratchRoot, { recursive: true });
  await mkdir(dirname(roots.coderScratchRoot), { recursive: true });
  try {
    const current = await lstat(roots.coderScratchRoot);
    if (!current.isSymbolicLink()) {
      throw new Error(`local-coder scratch exists but is not a symlink: ${roots.coderScratchRoot}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await symlink(roots.hostScratchRoot, roots.coderScratchRoot, "dir");
  }
  return roots;
}

export async function commitLocalCoderArtifact(params: {
  sourcePath: string;
  hostArtifactPath: string;
  hostScratchRoot: string;
}): Promise<string> {
  const destination = validateLocalCoderArtifactPath(params.hostArtifactPath, {
    hostScratchRoot: params.hostScratchRoot,
  });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    await cp(resolve(params.sourcePath), temporary, { force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rename(temporary, `${temporary}.discarded`).catch(() => undefined);
    throw error;
  }
  return destination;
}

export async function verifyHostVisibleLocalCoderArtifact(params: {
  hostArtifactPath: string;
  hostScratchRoot: string;
  expectedSourcePath?: string;
}): Promise<boolean> {
  const destination = validateLocalCoderArtifactPath(params.hostArtifactPath, {
    hostScratchRoot: params.hostScratchRoot,
  });
  try {
    if (params.expectedSourcePath) {
      const [actual, expected] = await Promise.all([
        readFile(destination),
        readFile(resolve(params.expectedSourcePath)),
      ]);
      return actual.equals(expected);
    }
    await lstat(destination);
    return true;
  } catch {
    return false;
  }
}

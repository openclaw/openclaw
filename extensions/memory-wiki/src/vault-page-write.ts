import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { parseWikiMarkdown } from "./markdown.js";

type VaultRoot = Awaited<ReturnType<typeof fsRoot>>;

// Atomic replacement can invalidate fs-safe's opened-file identity check.
// Retry only that race; symlink and path-alias failures remain fatal.
const isConcurrentRewriteRace = (error: unknown): boolean =>
  error instanceof FsSafeError && error.code === "path-mismatch";

export async function readWikiPageStat(vault: VaultRoot, pagePath: string) {
  return vault.stat(pagePath).catch((error: unknown) => {
    if (
      error instanceof FsSafeError &&
      (error.code === "not-found" || error.code === "path-alias")
    ) {
      return null;
    }
    throw error;
  });
}

export function isMissingWikiPageError(error: unknown): boolean {
  return error instanceof FsSafeError && error.code === "not-found";
}

export async function readExistingWikiPage(
  read: () => Promise<string>,
  emptyOn: (error: unknown) => boolean,
  fallback: () => string = () => "",
): Promise<string> {
  try {
    return await read();
  } catch {
    // Retry before classifying absence so a transient read cannot erase Notes.
    try {
      return await read();
    } catch (error) {
      if (emptyOn(error)) {
        return fallback();
      }
      throw error;
    }
  }
}

export async function writeManagedMarkdownFile(params: {
  rootDir: string;
  relativePath: string;
  title: string;
  startMarker: string;
  endMarker: string;
  body: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  params.signal?.throwIfAborted();
  const root = await fsRoot(params.rootDir);
  const original = await readExistingWikiPage(
    () => root.readText(params.relativePath),
    isMissingWikiPageError,
    () => `# ${params.title}\n`,
  );
  params.signal?.throwIfAborted();
  // Generated indexes bypass page discovery. Parse existing content here so
  // managed-block updates cannot rewrite malformed frontmatter.
  parseWikiMarkdown(original);
  const updated = replaceManagedMarkdownBlock({
    original,
    heading: "## Generated",
    startMarker: params.startMarker,
    endMarker: params.endMarker,
    body: params.body,
  });
  const rendered = withTrailingNewline(updated);
  if (rendered === original) {
    return false;
  }
  await root.write(params.relativePath, rendered);
  params.signal?.throwIfAborted();
  return true;
}

export async function writeGuardedVaultPage(params: {
  vault: VaultRoot;
  pagePath: string;
  content: string;
  pageStat: Awaited<ReturnType<VaultRoot["stat"]>> | null;
  pageLabel: string;
}): Promise<void> {
  try {
    await retryAsync(
      async () => {
        if (params.pageStat?.isFile && params.pageStat.nlink > 1) {
          await params.vault.remove(params.pagePath);
        }
        await params.vault.write(params.pagePath, params.content);
      },
      {
        attempts: 3,
        minDelayMs: 25,
        maxDelayMs: 50,
        label: `memory-wiki write ${params.pageLabel} ${params.pagePath}`,
        shouldRetry: isConcurrentRewriteRace,
      },
    );
  } catch (error) {
    if (error instanceof FsSafeError) {
      if (error.code !== "symlink" && error.code !== "path-alias") {
        throw new Error(
          `Refusing to write ${params.pageLabel} (${error.code}): ${params.pagePath}: ${error.message}`,
          { cause: error },
        );
      }
      throw new Error(`Refusing to write ${params.pageLabel} through symlink: ${params.pagePath}`, {
        cause: error,
      });
    }
    throw error;
  }
}

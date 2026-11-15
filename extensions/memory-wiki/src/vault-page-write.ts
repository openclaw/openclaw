import {
  replaceManagedMarkdownBlock,
  withTrailingNewline,
} from "openclaw/plugin-sdk/memory-host-markdown";
import { retryAsync } from "openclaw/plugin-sdk/retry-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import {
  decodeWikiPageUtf8,
  parseWikiMarkdown,
  slugifyWikiPageStem,
  slugifyWikiSegment,
} from "./markdown.js";

type WikiPageProducer = { pageType?: string; sourceType?: string };

/**
 * Derive the identity for a page write. New pages get a canonical (NFC) stem so
 * NFC/NFD spellings of one visual title cannot create two files. A released
 * vault may already hold the same visual title under any normalization form
 * (NFC, fully decomposed NFD, or a mixed spelling such as `café-naïve` where
 * some characters are composed and others decomposed). Reuse that exact stem so
 * upgrades keep the path, frontmatter ID, and hand-written Notes instead of
 * creating a duplicate page.
 *
 * `producer` names the frontmatter signature this writer owns. Only the title
 * fallback consults it: a page already sitting at the target stem is this
 * writer's page, but a hash-suffixed neighbour may belong to an importer
 * (`memory-unsafe-local`, `chatgpt-export`) whose page keeps its own identity.
 */
export async function resolveWikiPageIdentity(params: {
  rootDir: string;
  relativeDir: string;
  title: string;
  producer: WikiPageProducer;
}): Promise<{ slug: string; stem: string }> {
  const canonicalTitle = params.title.normalize("NFC");
  // The page id keeps the unreduced slug: `slugifyWikiPageStem` appends a hash to
  // reserved stems (`index`), and an id must not carry that file-level suffix.
  const slug = slugifyWikiSegment(canonicalTitle);
  // Derive both the NFC and NFD stems. A released page whose title is long enough
  // to be hash-truncated stores a stem with a content hash; normalization cannot
  // restore the removed suffix or the original hash input, so NFC equivalence
  // alone fails to recognize it. Matching the exact NFD-derived stem recovers
  // those released identities.
  const nfcStem = slugifyWikiPageStem(canonicalTitle);
  const nfdStem = slugifyWikiPageStem(canonicalTitle.normalize("NFD"));
  const targetNfc = nfcStem.normalize("NFC");
  const root = await fsRoot(params.rootDir);
  const entries = await root.list(params.relativeDir).catch((): string[] => []);
  const pageNames = entries.filter((name) => name.endsWith(".md") && name !== "index.md");
  for (const name of pageNames) {
    const stem = name.slice(0, -3);
    // Exact match on either normalization covers hash-truncated released pages;
    // NFC equivalence covers untruncated mixed-form spellings.
    if (stem === nfcStem || stem === nfdStem || stem.normalize("NFC") === targetNfc) {
      return { slug, stem };
    }
  }
  // Filename matching cannot recover a released page whose title was long enough
  // for the filename cap to replace its tail with a content hash: the stored stem
  // keeps neither the removed suffix nor the pre-cap text behind that hash, so it
  // equals neither the NFC nor the NFD candidate. Fall back to the frontmatter
  // `title` the writer stored, and compare canonical slugs instead of raw titles
  // so case and separator variants of one visual title still match.
  for (const name of pageNames) {
    const stem = name.slice(0, -3);
    if (!/-[0-9a-f]{12}$/.test(stem)) {
      continue;
    }
    try {
      const relativePath = `${params.relativeDir}/${name}`;
      const raw = await root.readBytes(relativePath);
      const { frontmatter } = parseWikiMarkdown(decodeWikiPageUtf8(raw, relativePath));
      const producerMatches =
        (params.producer.pageType === undefined ||
          frontmatter.pageType === params.producer.pageType) &&
        (params.producer.sourceType === undefined ||
          frontmatter.sourceType === params.producer.sourceType);
      const releasedTitle = frontmatter.title;
      if (
        producerMatches &&
        typeof releasedTitle === "string" &&
        slugifyWikiSegment(releasedTitle.normalize("NFC")) === slug
      ) {
        return { slug, stem };
      }
    } catch {
      // Ignore unreadable or non-frontmatter pages.
    }
  }
  return { slug, stem: nfcStem };
}

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

export function readExistingWikiPageUtf8(
  vault: VaultRoot,
  relativePath: string,
  fallback: () => string,
): Promise<string> {
  return readExistingWikiPage(
    async () => decodeWikiPageUtf8(await vault.readBytes(relativePath), relativePath),
    isMissingWikiPageError,
    fallback,
  );
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
  const original = await readExistingWikiPageUtf8(
    root,
    params.relativePath,
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

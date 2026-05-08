import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPluginBlobStore,
  createPluginBlobSyncStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export const MEMORY_WIKI_AGENT_DIGEST_LEGACY_PATH = ".openclaw-wiki/cache/agent-digest.json";
export const MEMORY_WIKI_CLAIMS_DIGEST_LEGACY_PATH = ".openclaw-wiki/cache/claims.jsonl";

type MemoryWikiDigestKind = "agent-digest" | "claims-digest";

type MemoryWikiDigestMetadata = {
  vaultHash: string;
  kind: MemoryWikiDigestKind;
  contentType: "application/json" | "application/x-ndjson";
};

const digestStore = createPluginBlobStore<MemoryWikiDigestMetadata>("memory-wiki", {
  namespace: "compiled-digest",
  maxEntries: 2000,
});

const syncDigestStore = createPluginBlobSyncStore<MemoryWikiDigestMetadata>("memory-wiki", {
  namespace: "compiled-digest",
  maxEntries: 2000,
});

function hashSegment(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function resolveVaultHash(vaultRoot: string): string {
  return hashSegment(path.resolve(vaultRoot));
}

function resolveDigestKey(vaultRoot: string, kind: MemoryWikiDigestKind): string {
  return `${resolveVaultHash(vaultRoot)}:${kind}`;
}

function contentTypeForDigestKind(
  kind: MemoryWikiDigestKind,
): MemoryWikiDigestMetadata["contentType"] {
  return kind === "agent-digest" ? "application/json" : "application/x-ndjson";
}

async function writeDigest(params: {
  vaultRoot: string;
  kind: MemoryWikiDigestKind;
  content: string;
}): Promise<boolean> {
  const key = resolveDigestKey(params.vaultRoot, params.kind);
  const existing = await digestStore.lookup(key);
  if (existing?.blob.toString("utf8") === params.content) {
    return false;
  }
  await digestStore.register(
    key,
    {
      vaultHash: resolveVaultHash(params.vaultRoot),
      kind: params.kind,
      contentType: contentTypeForDigestKind(params.kind),
    },
    Buffer.from(params.content, "utf8"),
  );
  return true;
}

export async function writeMemoryWikiCompiledDigests(params: {
  vaultRoot: string;
  agentDigest: string;
  claimsDigest: string;
}): Promise<{ agentDigestChanged: boolean; claimsDigestChanged: boolean }> {
  const [agentDigestChanged, claimsDigestChanged] = await Promise.all([
    writeDigest({
      vaultRoot: params.vaultRoot,
      kind: "agent-digest",
      content: params.agentDigest,
    }),
    writeDigest({
      vaultRoot: params.vaultRoot,
      kind: "claims-digest",
      content: params.claimsDigest,
    }),
  ]);
  return { agentDigestChanged, claimsDigestChanged };
}

export function readMemoryWikiAgentDigestSync(vaultRoot: string): string | null {
  return (
    syncDigestStore.lookup(resolveDigestKey(vaultRoot, "agent-digest"))?.blob.toString("utf8") ??
    null
  );
}

export async function readMemoryWikiCompiledDigestBundle(vaultRoot: string): Promise<{
  agentDigest: string | null;
  claimsDigest: string | null;
}> {
  const [agentDigest, claimsDigest] = await Promise.all([
    digestStore.lookup(resolveDigestKey(vaultRoot, "agent-digest")),
    digestStore.lookup(resolveDigestKey(vaultRoot, "claims-digest")),
  ]);
  return {
    agentDigest: agentDigest?.blob.toString("utf8") ?? null,
    claimsDigest: claimsDigest?.blob.toString("utf8") ?? null,
  };
}

export function resolveMemoryWikiLegacyDigestPath(
  vaultRoot: string,
  kind: MemoryWikiDigestKind,
): string {
  return path.join(
    vaultRoot,
    kind === "agent-digest"
      ? MEMORY_WIKI_AGENT_DIGEST_LEGACY_PATH
      : MEMORY_WIKI_CLAIMS_DIGEST_LEGACY_PATH,
  );
}

async function importLegacyDigest(params: {
  vaultRoot: string;
  kind: MemoryWikiDigestKind;
}): Promise<{ imported: boolean; sourcePath: string }> {
  const sourcePath = resolveMemoryWikiLegacyDigestPath(params.vaultRoot, params.kind);
  const content = await fs.readFile(sourcePath, "utf8");
  await writeDigest({
    vaultRoot: params.vaultRoot,
    kind: params.kind,
    content,
  });
  await fs.rm(sourcePath, { force: true });
  return { imported: true, sourcePath };
}

export async function legacyMemoryWikiDigestFilesExist(vaultRoot: string): Promise<boolean> {
  const results = await Promise.all(
    (["agent-digest", "claims-digest"] as const).map((kind) =>
      fs
        .stat(resolveMemoryWikiLegacyDigestPath(vaultRoot, kind))
        .then((stat) => stat.isFile())
        .catch(() => false),
    ),
  );
  return results.some(Boolean);
}

export async function importMemoryWikiLegacyDigestFiles(params: {
  vaultRoot: string;
}): Promise<{ imported: number; warnings: string[]; sourcePaths: string[] }> {
  const warnings: string[] = [];
  const sourcePaths: string[] = [];
  let imported = 0;
  for (const kind of ["agent-digest", "claims-digest"] as const) {
    try {
      const result = await importLegacyDigest({ vaultRoot: params.vaultRoot, kind });
      imported += result.imported ? 1 : 0;
      sourcePaths.push(result.sourcePath);
    } catch (error) {
      const sourcePath = resolveMemoryWikiLegacyDigestPath(params.vaultRoot, kind);
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      warnings.push(`Failed importing Memory Wiki ${kind}: ${String(error)}`);
      sourcePaths.push(sourcePath);
    }
  }
  const cacheDir = path.join(params.vaultRoot, ".openclaw-wiki", "cache");
  await fs.rmdir(cacheDir).catch(() => undefined);
  return { imported, warnings, sourcePaths };
}

import { createHash } from "node:crypto";
import path from "node:path";
import {
  createPluginBlobStore,
  createPluginBlobSyncStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

export type MemoryWikiDigestKind = "agent-digest" | "claims-digest";

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

export async function writeMemoryWikiDigestForMigration(params: {
  vaultRoot: string;
  kind: MemoryWikiDigestKind;
  content: string;
}): Promise<boolean> {
  return await writeDigest(params);
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

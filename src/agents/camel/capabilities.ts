import type { Capabilities, Readers, Source } from "./types.js";
import { SourceKind } from "./types.js";

const PUBLIC_READERS: Readers = { kind: "public" };

function toSourceKey(source: Source): string {
  if (typeof source === "string") {
    return source;
  }
  const inner = source.innerSources
    ? Array.from(source.innerSources).map(String).toSorted().join("|")
    : "";
  return `tool:${source.toolName}:${inner}`;
}

function cloneSource(source: Source): Source {
  if (typeof source === "string") {
    return source;
  }
  return {
    kind: "tool",
    toolName: source.toolName,
    ...(source.innerSources ? { innerSources: new Set(source.innerSources) } : {}),
  };
}

export function createCapabilities(params?: {
  sources?: Source[];
  readers?: Readers;
  metadata?: Record<string, unknown>;
}): Capabilities {
  const sources = params?.sources && params.sources.length > 0 ? params.sources : [SourceKind.User];
  return {
    sources: new Set(sources.map(cloneSource)),
    readers: params?.readers
      ? params.readers.kind === "restricted"
        ? { kind: "restricted", allowedReaders: new Set(params.readers.allowedReaders) }
        : PUBLIC_READERS
      : PUBLIC_READERS,
    ...(params?.metadata ? { metadata: { ...params.metadata } } : {}),
  };
}

function intersectReaders(a: Readers, b: Readers): Readers {
  if (a.kind === "public") {
    return b.kind === "public"
      ? PUBLIC_READERS
      : { kind: "restricted", allowedReaders: new Set(b.allowedReaders) };
  }
  if (b.kind === "public") {
    return { kind: "restricted", allowedReaders: new Set(a.allowedReaders) };
  }
  const allowedReaders = new Set<string>();
  for (const reader of a.allowedReaders) {
    if (b.allowedReaders.has(reader)) {
      allowedReaders.add(reader);
    }
  }
  return { kind: "restricted", allowedReaders };
}

export function mergeCapabilities(...caps: Capabilities[]): Capabilities {
  if (caps.length === 0) {
    return createCapabilities();
  }

  const sourceByKey = new Map<string, Source>();
  let readers: Readers = PUBLIC_READERS;
  let metadata: Record<string, unknown> | undefined;

  for (const cap of caps) {
    for (const source of cap.sources) {
      sourceByKey.set(toSourceKey(source), cloneSource(source));
    }
    readers = intersectReaders(readers, cap.readers);
    if (cap.metadata) {
      metadata = { ...metadata, ...cap.metadata };
    }
  }

  return {
    sources: new Set(sourceByKey.values()),
    readers,
    ...(metadata ? { metadata } : {}),
  };
}

export function isPublicReaders(readers: Readers): boolean {
  return readers.kind === "public";
}

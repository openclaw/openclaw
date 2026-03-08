import { createCapabilities, isPublicReaders, mergeCapabilities } from "./capabilities.js";
import type { CaMeLValue, Capabilities, Readers, Source } from "./types.js";
import { SourceKind } from "./types.js";

export const CAMEL_VALUE_BRAND = Symbol("camel_value_brand");

const TRUSTED_SOURCES = new Set<SourceKind>([
  SourceKind.User,
  SourceKind.CaMeL,
  SourceKind.Assistant,
  SourceKind.TrustedTool,
]);

function collectDependencies(value: CaMeLValue, visited = new Set<CaMeLValue>()): CaMeLValue[] {
  if (visited.has(value)) {
    return [];
  }
  visited.add(value);
  const deps: CaMeLValue[] = [];
  for (const dep of value.dependencies) {
    deps.push(dep, ...collectDependencies(dep, visited));
  }
  return deps;
}

function cloneCapabilities(capabilities: Capabilities): Capabilities {
  return {
    sources: new Set(Array.from(capabilities.sources)),
    readers:
      capabilities.readers.kind === "public"
        ? { kind: "public" }
        : { kind: "restricted", allowedReaders: new Set(capabilities.readers.allowedReaders) },
    ...(capabilities.metadata ? { metadata: { ...capabilities.metadata } } : {}),
  };
}

function mergeReaders(readers: Readers[]): Readers {
  return mergeCapabilities(
    ...readers.map((reader) => ({
      sources: new Set<Source>(),
      readers: reader,
    })),
  ).readers;
}

function sourceIsTrusted(source: Source): boolean {
  if (typeof source === "string") {
    return TRUSTED_SOURCES.has(source);
  }
  if (!source.innerSources || source.innerSources.size === 0) {
    return false;
  }
  for (const inner of source.innerSources) {
    if (typeof inner === "string" && !TRUSTED_SOURCES.has(inner as SourceKind)) {
      return false;
    }
  }
  return true;
}

export function createValue<T>(
  raw: T,
  capabilities: Capabilities = createCapabilities(),
  dependencies: CaMeLValue[] = [],
): CaMeLValue<T> {
  return {
    raw,
    capabilities: cloneCapabilities(capabilities),
    dependencies: [...dependencies],
    [CAMEL_VALUE_BRAND]: true,
  };
}

export function isCaMeLValue(value: unknown): value is CaMeLValue {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<PropertyKey, unknown>;
  return record[CAMEL_VALUE_BRAND] === true;
}

export function deriveValue<T>(raw: T, ...parents: CaMeLValue[]): CaMeLValue<T> {
  if (parents.length === 0) {
    return createValue(raw, createCapabilities({ sources: [SourceKind.CaMeL] }));
  }

  const merged = mergeCapabilities(
    ...parents.map((parent) => parent.capabilities),
    createCapabilities({ sources: [SourceKind.CaMeL] }),
  );
  return createValue(raw, merged, parents);
}

export function getAllSources(value: CaMeLValue): Set<Source> {
  const allSources = new Set<Source>();
  const values = [value, ...collectDependencies(value)];
  for (const item of values) {
    for (const source of item.capabilities.sources) {
      allSources.add(source);
    }
  }
  return allSources;
}

export function getAllReaders(value: CaMeLValue): Readers {
  const readers: Readers[] = [value.capabilities.readers];
  for (const dep of collectDependencies(value)) {
    readers.push(dep.capabilities.readers);
  }
  return mergeReaders(readers);
}

export function isPublic(value: CaMeLValue): boolean {
  return isPublicReaders(getAllReaders(value));
}

export function isTainted(value: CaMeLValue): boolean {
  for (const source of getAllSources(value)) {
    if (!sourceIsTrusted(source)) {
      return true;
    }
  }
  return false;
}

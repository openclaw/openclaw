import path from "node:path";

export type MemoryWikiLayoutConfig = {
  rootIndex?: string;
  overview?: string;
  inbox?: string;
  entitiesDir?: string;
  conceptsDir?: string;
  sourcesDir?: string;
  synthesesDir?: string;
  reportsDir?: string;
  attachmentsDir?: string;
  viewsDir?: string;
  systemDir?: string;
};

export type ResolvedMemoryWikiLayout = {
  rootIndex: string;
  overview: string;
  inbox: string;
  entitiesDir: string;
  conceptsDir: string;
  sourcesDir: string;
  synthesesDir: string;
  reportsDir: string;
  attachmentsDir: string;
  viewsDir: string;
  systemDir: string;
  systemLocksDir: string;
  systemCacheDir: string;
};

function normalizeRelative(input: string | undefined, fallback: string): string {
  const value = (input ?? fallback)
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  return value.replace(/^\/+/, "").replace(/\/+$/, "") || fallback;
}

export function resolveWikiPaths(config: {
  layout: MemoryWikiLayoutConfig;
}): ResolvedMemoryWikiLayout {
  const layout = config.layout;
  const systemDir = normalizeRelative(layout.systemDir, ".openclaw-wiki");
  return {
    rootIndex: normalizeRelative(layout.rootIndex, "index.md"),
    overview: normalizeRelative(layout.overview, "WIKI.md"),
    inbox: normalizeRelative(layout.inbox, "inbox.md"),
    entitiesDir: normalizeRelative(layout.entitiesDir, "entities"),
    conceptsDir: normalizeRelative(layout.conceptsDir, "concepts"),
    sourcesDir: normalizeRelative(layout.sourcesDir, "sources"),
    synthesesDir: normalizeRelative(layout.synthesesDir, "syntheses"),
    reportsDir: normalizeRelative(layout.reportsDir, "reports"),
    attachmentsDir: normalizeRelative(layout.attachmentsDir, "_attachments"),
    viewsDir: normalizeRelative(layout.viewsDir, "_views"),
    systemDir,
    systemLocksDir: path.posix.join(systemDir, "locks"),
    systemCacheDir: path.posix.join(systemDir, "cache"),
  };
}

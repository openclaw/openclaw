import fs from "node:fs/promises";
import path from "node:path";
import {
  assertLocalAgentWorkspaceScanAccess,
  WorkspaceAccessUnavailableError,
} from "openclaw/plugin-sdk/agent-workspace-runtime";
import { resolvePathPrefixSync } from "openclaw/plugin-sdk/file-access-runtime";
import {
  isPathInside,
  resolveAgentWorkspaceDir,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { chunkMarkdown, hashText } from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import {
  isFileMissingError,
  listMemoryFiles,
  normalizeExtraMemoryPathEntries,
  readMemoryFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { defaultRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
import { resolveMemorySearchIndexConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveForeignMemorySlotOwner } from "./cli-memory-slot.js";
import { resolveMemoryAgent } from "./cli-runtime-common.js";
import type { MemoryDuplicatesCommandOptions } from "./cli.types.js";

const MAX_LOCATIONS_PER_GROUP = 20;

type DuplicateLocation = { path: string; startLine: number; endLine: number };
type DuplicateGroup = { occurrences: number; locations: DuplicateLocation[] };

async function resolveScanPath(filePath: string): Promise<{ lexical: string; canonical: string }> {
  const lexical = path.resolve(filePath);
  try {
    return { lexical, canonical: await fs.realpath(lexical) };
  } catch (error) {
    if (!isFileMissingError(error)) {
      throw error;
    }
    const { existingPath, unresolvedSegments } = resolvePathPrefixSync(lexical);
    return { lexical, canonical: path.join(existingPath, ...unresolvedSegments) };
  }
}

export async function runMemoryDuplicates(opts: MemoryDuplicatesCommandOptions): Promise<void> {
  // This file-only diagnostic needs neither resolved embedding credentials nor an index manager.
  const cfg = await captureRuntimeConfigAsyncReader({
    skipPluginValidation: true,
    observe: false,
  })();
  const agentId = resolveMemoryAgent(cfg, opts.agent);
  const owner = resolveForeignMemorySlotOwner(cfg);
  if (owner) {
    throw new Error(
      `memory duplicates inspects Memory Core files, but the memory slot selects "${owner}". Use the ${owner} plugin's own commands or the agent's memory tools.`,
    );
  }
  const settings = resolveMemorySearchIndexConfig(cfg, agentId);
  if (!settings) {
    if (opts.json) {
      defaultRuntime.writeJson({ agentId, status: "disabled" });
    } else {
      defaultRuntime.log("Memory search disabled.");
    }
    return;
  }
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  // Check every discovery root before listing files. Offline loading may not register providers,
  // but configured remote ownership still applies to extra paths and nested workspaces.
  const scanRoots = [
    { path: path.join(workspaceDir, "MEMORY.md"), recursive: false },
    { path: path.join(workspaceDir, "USER.md"), recursive: false },
    { path: path.join(workspaceDir, "memory"), recursive: true },
    ...normalizeExtraMemoryPathEntries(workspaceDir, settings.extraPaths).map((entry) => ({
      path: entry.path,
      recursive: true,
    })),
  ];
  const remoteMappings = asOptionalRecord(
    asOptionalRecord(cfg.plugins?.entries?.["file-transfer"]?.config)?.workspaces,
  );
  const remoteRoots = await Promise.all(
    Object.keys(remoteMappings ?? {}).map((id) =>
      resolveScanPath(resolveAgentWorkspaceDir(cfg, id)),
    ),
  );
  const roots = await Promise.all(
    scanRoots.map(async (root) => {
      const resolved = await resolveScanPath(root.path);
      return {
        recursive: root.recursive,
        lexical: resolved.lexical,
        canonical: resolved.canonical,
      };
    }),
  );
  const workspace = await resolveScanPath(workspaceDir);
  // The workspace itself is not recursively scanned, so unscanned remote descendants stay allowed.
  const configuredRemote = [{ ...workspace, recursive: false }, ...roots].some((root) =>
    remoteRoots.some((remote) =>
      (["lexical", "canonical"] as const).some(
        (kind) =>
          isPathInside(remote[kind], root[kind]) ||
          (root.recursive && isPathInside(root[kind], remote[kind])),
      ),
    ),
  );
  if (configuredRemote) {
    throw new WorkspaceAccessUnavailableError(
      "memory duplicates requires a local workspace and local scan roots; run it on the workspace host with a local-workspace configuration. Remote workspace mappings cannot be scanned offline.",
    );
  }
  assertLocalAgentWorkspaceScanAccess([{ path: workspaceDir }, ...scanRoots], "memoryFiles");
  const files = await listMemoryFiles(workspaceDir, settings.extraPaths);
  const groupsByHash = new Map<string, DuplicateGroup>();
  let filesScanned = 0;
  let skippedFiles = 0;
  const minChars = opts.minChars ?? 80;
  for (const file of files.toSorted()) {
    // Providers can declare owners below recursive roots; admit each file before reading it.
    assertLocalAgentWorkspaceScanAccess([{ path: file }], "memoryFiles");
    const result = await readMemoryFile({
      workspaceDir,
      extraPaths: settings.extraPaths,
      relPath: path.relative(workspaceDir, file),
      lines: Number.MAX_SAFE_INTEGER,
      maxChars: Number.MAX_SAFE_INTEGER,
    });
    if (result.status !== "ok") {
      skippedFiles += 1;
      continue;
    }
    filesScanned += 1;
    const seenSpans = new Set<string>();
    // Non-overlapping chunks avoid diagnosing the indexer's intentional overlap as repetition.
    for (const chunk of chunkMarkdown(result.text.replace(/\r(?=\n|$)/gu, ""), {
      tokens: 400,
      overlap: 0,
      perEntry: true,
    })) {
      const text = chunk.text.replace(/^\n+|\n+$/gu, "");
      if (!text.trim() || Array.from(text).length < minChars) {
        continue;
      }
      const hash = hashText(text);
      const span = `${hash}:${chunk.startLine}:${chunk.endLine}`;
      // Long single lines can yield identical fragments with the same source coordinates.
      if (seenSpans.has(span)) {
        continue;
      }
      seenSpans.add(span);
      const group = groupsByHash.get(hash) ?? { occurrences: 0, locations: [] };
      group.occurrences += 1;
      if (group.locations.length < MAX_LOCATIONS_PER_GROUP) {
        group.locations.push({
          path: result.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        });
      }
      groupsByHash.set(hash, group);
    }
  }
  const duplicates = [...groupsByHash.values()]
    .filter((group) => group.occurrences > 1)
    .toSorted((left, right) => right.occurrences - left.occurrences);
  const groups = duplicates.slice(0, opts.maxGroups ?? 20).map((group) => ({
    occurrences: group.occurrences,
    locations: group.locations,
    omittedLocations: group.occurrences - group.locations.length,
  }));
  const report = {
    agentId,
    filesScanned,
    skippedFiles,
    minChars,
    duplicateGroupCount: duplicates.length,
    duplicateOccurrenceCount: duplicates.reduce((sum, group) => sum + group.occurrences, 0),
    omittedGroups: duplicates.length - groups.length,
    groups,
  };
  if (opts.json) {
    defaultRuntime.writeJson(report);
    return;
  }
  defaultRuntime.log(
    `Memory duplicates (${agentId}): ${duplicates.length} groups in ${filesScanned} files.`,
  );
  for (const group of groups) {
    defaultRuntime.log(`\n${group.occurrences} matching blocks:`);
    for (const location of group.locations) {
      defaultRuntime.log(`  ${location.path}:${location.startLine}-${location.endLine}`);
    }
    if (group.omittedLocations) {
      defaultRuntime.log(`  ${group.omittedLocations} more locations omitted.`);
    }
  }
  if (report.omittedGroups) {
    defaultRuntime.log(`${report.omittedGroups} more groups omitted; increase --max-groups.`);
  }
  if (skippedFiles) {
    defaultRuntime.log(`${skippedFiles} files disappeared during the scan; rerun to refresh.`);
  }
}

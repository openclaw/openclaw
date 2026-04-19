import fs from "node:fs/promises";
import path from "node:path";
import { resolveMemoryHostEventLogPath } from "openclaw/plugin-sdk/memory-core-host-events";
import { resolveMemoryDreamingWorkspaces } from "openclaw/plugin-sdk/memory-core-host-status";
import {
  listActiveMemoryPublicArtifacts,
  type MemoryPluginPublicArtifact,
} from "openclaw/plugin-sdk/memory-host-core";
import type { OpenClawConfig } from "../api.js";

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

async function listMarkdownFilesRecursive(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listMarkdownFilesRecursive(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

// Config-derived fallback: scan workspace directories for public memory
// artifacts using the same SDK building blocks that memory-core uses.
// This avoids a cross-extension import from memory-core/src/**.
async function listConfigDerivedPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const workspaces = resolveMemoryDreamingWorkspaces(params.cfg);
  const artifacts: MemoryPluginPublicArtifact[] = [];
  for (const workspace of workspaces) {
    const workspaceDir = workspace.workspaceDir;
    const agentIds = workspace.agentIds;

    const workspaceEntries = new Set(
      (await fs.readdir(workspaceDir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    );
    for (const relativePath of ["MEMORY.md", "memory.md"]) {
      if (!workspaceEntries.has(relativePath)) {
        continue;
      }
      artifacts.push({
        kind: "memory-root",
        workspaceDir,
        relativePath,
        absolutePath: path.join(workspaceDir, relativePath),
        agentIds: [...agentIds],
        contentType: "markdown",
      });
    }

    const memoryDir = path.join(workspaceDir, "memory");
    for (const absolutePath of await listMarkdownFilesRecursive(memoryDir)) {
      const relativePath = path.relative(workspaceDir, absolutePath).replace(/\\/g, "/");
      artifacts.push({
        kind: relativePath.startsWith("memory/dreaming/") ? "dream-report" : "daily-note",
        workspaceDir,
        relativePath,
        absolutePath,
        agentIds: [...agentIds],
        contentType: "markdown",
      });
    }

    const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir);
    if (await pathExists(eventLogPath)) {
      artifacts.push({
        kind: "event-log",
        workspaceDir,
        relativePath: path.relative(workspaceDir, eventLogPath).replace(/\\/g, "/"),
        absolutePath: eventLogPath,
        agentIds: [...agentIds],
        contentType: "json",
      });
    }
  }
  return artifacts;
}

// Enumerate public memory artifacts: prefer runtime-registered artifacts from
// memory-core's capability, fall back to config-derived filesystem scan when
// the runtime capability is absent or stale.
export async function listBridgeMemoryPublicArtifacts(params: {
  cfg: OpenClawConfig;
}): Promise<MemoryPluginPublicArtifact[]> {
  const runtimeArtifacts = await listActiveMemoryPublicArtifacts(params);
  if (runtimeArtifacts.length > 0) {
    return runtimeArtifacts;
  }
  return listConfigDerivedPublicArtifacts(params);
}

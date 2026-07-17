/**
 * Sandbox workspace bootstrapper.
 *
 * Creates sandbox workspaces and seeds agent bootstrap files through root-boundary reads.
 */
import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OptionalBootstrapFileName } from "../../config/types.agent-defaults.js";
import { openRootFile } from "../../infra/boundary-file-read.js";
import { readFileDescriptorBoundedSync } from "../../infra/file-descriptor-read.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserPath } from "../../utils.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
} from "../workspace.js";

const log = createSubsystemLogger("sandbox-workspace");

// Sandbox seed files (AGENTS.md / SOUL.md / TOOLS.md / ...) are bootstrap metadata.
// Bound the pinned seed read so an oversized or misconfigured seed path cannot trigger
// an unbounded read at sandbox-creation time. Aligns with the 2 MiB workspace bootstrap
// file limit used by other workspace reads.
const SANDBOX_SEED_FILE_MAX_BYTES = 2 * 1024 * 1024;

export async function ensureSandboxWorkspace(
  workspaceDir: string,
  seedFrom?: string,
  skipBootstrap?: boolean,
  skipOptionalBootstrapFiles?: OptionalBootstrapFileName[],
) {
  await fs.mkdir(workspaceDir, { recursive: true });
  if (seedFrom) {
    const seed = resolveUserPath(seedFrom);
    const files = [
      DEFAULT_AGENTS_FILENAME,
      DEFAULT_SOUL_FILENAME,
      DEFAULT_TOOLS_FILENAME,
      DEFAULT_IDENTITY_FILENAME,
      DEFAULT_USER_FILENAME,
      DEFAULT_BOOTSTRAP_FILENAME,
      DEFAULT_HEARTBEAT_FILENAME,
    ];
    for (const name of files) {
      const src = path.join(seed, name);
      const dest = path.join(workspaceDir, name);
      try {
        await fs.access(dest);
      } catch {
        try {
          const opened = await openRootFile({
            absolutePath: src,
            rootPath: seed,
            boundaryLabel: "sandbox seed workspace",
          });
          if (!opened.ok) {
            continue;
          }
          try {
            const content = readFileDescriptorBoundedSync(
              opened.fd,
              SANDBOX_SEED_FILE_MAX_BYTES,
            ).toString("utf-8");
            await fs.writeFile(dest, content, { encoding: "utf-8", flag: "wx" });
          } catch (err) {
            if (err instanceof RangeError) {
              log.warn(
                `Ignoring oversized sandbox seed file ${src}: file exceeds the ${SANDBOX_SEED_FILE_MAX_BYTES}-byte limit`,
              );
            }
            // ignore missing or oversized seed file
          } finally {
            syncFs.closeSync(opened.fd);
          }
        } catch {
          // ignore missing seed file
        }
      }
    }
  }
  await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: !skipBootstrap,
    skipOptionalBootstrapFiles,
  });
}

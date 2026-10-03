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
import { retainMutationAuthority } from "../../infra/mutation-authority.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveUserPath } from "../../utils.js";
import { publishBootstrapFile } from "../workspace-bootstrap-publish.js";
import {
  MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  readWorkspaceBootstrapFile,
} from "../workspace-bootstrap-read.js";
import { createWorkspaceFileMutationGuard } from "../workspace-file-mutation-guard.js";
import type { WorkspaceStateGuard } from "../workspace-state-store.worker-contract.js";
import {
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_USER_FILENAME,
  ensureAgentWorkspace,
} from "../workspace.js";

const log = createSubsystemLogger("sandbox-workspace");

export async function ensureSandboxWorkspace(
  workspaceDir: string,
  seedFrom?: string,
  skipBootstrap?: boolean,
  skipOptionalBootstrapFiles?: OptionalBootstrapFileName[],
  guard?: WorkspaceStateGuard,
) {
  const beforeMutation = createWorkspaceFileMutationGuard(guard);
  const assertCurrent = beforeMutation ? retainMutationAuthority(beforeMutation) : undefined;
  assertCurrent?.();
  await fs.mkdir(workspaceDir, { recursive: true });
  assertCurrent?.();
  if (seedFrom) {
    const seed = resolveUserPath(seedFrom);
    const files = [
      DEFAULT_AGENTS_FILENAME,
      DEFAULT_SOUL_FILENAME,
      DEFAULT_IDENTITY_FILENAME,
      DEFAULT_USER_FILENAME,
      DEFAULT_BOOTSTRAP_FILENAME,
    ];
    for (const name of files) {
      const src = path.join(seed, name);
      const dest = path.join(workspaceDir, name);
      const destinationExists = await fs.access(dest).then(
        () => true,
        () => false,
      );
      assertCurrent?.();
      if (destinationExists) {
        continue;
      }
      const opened = await openRootFile({
        absolutePath: src,
        rootPath: seed,
        boundaryLabel: "sandbox seed workspace",
      });
      if (!opened.ok) {
        assertCurrent?.();
        continue;
      }
      let content: string;
      try {
        assertCurrent?.();
        content = await readWorkspaceBootstrapFile(opened.fd);
      } catch (err) {
        assertCurrent?.();
        if (err instanceof RangeError) {
          log.warn(
            `Ignoring oversized sandbox seed file ${src}: file exceeds the ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES}-byte limit`,
          );
          continue;
        }
        throw err;
      } finally {
        syncFs.closeSync(opened.fd);
      }
      assertCurrent?.();
      await publishBootstrapFile(dest, content, assertCurrent);
      assertCurrent?.();
    }
  }
  await ensureAgentWorkspace({
    dir: workspaceDir,
    ensureBootstrapFiles: !skipBootstrap,
    skipOptionalBootstrapFiles,
    guard,
  });
  assertCurrent?.();
}

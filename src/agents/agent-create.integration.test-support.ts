import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { vi } from "vitest";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.kernel.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";

export async function prepareRecoveryHolds(
  state: OpenClawTestState,
  agentId: string,
  held = [
    { agentId, path: path.join(state.agentDir(agentId), "openclaw-agent.sqlite") },
    { agentId, path: state.path("parked", "openclaw-agent.sqlite") },
    { agentId: "kept", path: path.join(state.agentDir("kept"), "openclaw-agent.sqlite") },
  ],
) {
  for (const target of held) {
    runOpenClawAgentWriteTransaction(
      (database) =>
        writeSessionEntry(
          database,
          `agent:${target.agentId}:main`,
          {
            sessionId: `preserved-${target.agentId}`,
            updatedAt: 1,
          },
          { previousEntry: null },
        ),
      { ...target, env: state.env },
    );
  }
  closeOpenClawAgentDatabasesForTest();
  runOpenClawStateWriteTransaction(
    (database) => {
      database.db.exec("DROP TABLE agent_deletion_journal");
      reconstructAgentDeletionJournal(database, held);
    },
    { env: state.env },
  );
  return {
    held,
    bytes: await Promise.all(held.map((target) => fs.readFile(target.path))),
    readHolds: () => readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env: state.env })),
  };
}

export function installWorkspacePreparationPause(
  workspace: string,
  phase: "workspace" | "workspace-write" | "config",
  pause: (phase: "workspace" | "workspace-write" | "config") => Promise<void>,
): () => void {
  const nativeModeEnv = captureEnv(["FS_SAFE_NATIVE_MODE"]);
  if (phase === "workspace-write") {
    setTestEnvValue("FS_SAFE_NATIVE_MODE", "off");
  }
  const realAccess = fs.access.bind(fs);
  const access = vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
    if (phase === "workspace" && file === path.join(workspace, "AGENTS.md")) {
      await pause("workspace");
    }
    return await realAccess(file, mode);
  });
  const realOpen = fs.open.bind(fs);
  const restoreWrites: Array<() => void> = [];
  let writePaused = false;
  const open = vi.spyOn(fs, "open").mockImplementation(async (file, flags, mode) => {
    const handle = await realOpen(file, flags, mode);
    const filePath = nodeFilePath(file);
    if (
      phase === "workspace-write" &&
      filePath &&
      path.dirname(filePath) === workspace &&
      typeof flags === "number" &&
      (flags & fsConstants.O_EXCL) !== 0
    ) {
      const realWrite = handle.write.bind(handle);
      const write = vi.spyOn(handle, "write").mockImplementation(async (...args) => {
        const result = await realWrite(...args);
        if (!writePaused) {
          writePaused = true;
          await pause("workspace-write");
        }
        return result;
      });
      restoreWrites.push(() => write.mockRestore());
    }
    return handle;
  });
  return () => {
    open.mockRestore();
    for (const restore of restoreWrites) {
      restore();
    }
    access.mockRestore();
    nativeModeEnv.restore();
  };
}

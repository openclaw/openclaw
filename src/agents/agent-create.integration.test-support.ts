import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, vi } from "vitest";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  FsSafeStoreCommand,
  FsSafeStoreReply,
} from "../infra/fs-safe-copy-worker-contract.js";
import * as filesystemWorker from "../infra/fs-safe-filesystem-worker.js";
import { withWorkerFsSafeNativeMode } from "../infra/worker-fs-safe.js";
import { workerMutationAssertion } from "../infra/worker-mutation-authority.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { readAgentDeletionRecoveryHolds } from "../state/agent-deletion-journal-recovery.kernel.js";
import {
  closeOpenClawAgentDatabasesForTest,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { nodeFilePath } from "../test-utils/node-file-path.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import type {
  WorkspaceFilesystemCommand,
  WorkspaceFilesystemReadCommand,
  WorkspaceFilesystemReadReply,
  WorkspaceFilesystemReply,
} from "./workspace-filesystem.types.js";
import { executeWorkspaceFilesystemOperation } from "./workspace-filesystem.worker.js";

export async function createAgentTestState(
  label: string,
  options: Parameters<typeof createOpenClawTestState>[0] = {},
  beforeCleanup = () => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  },
) {
  const state = await createOpenClawTestState({ scenario: "minimal", label, ...options });
  onTestFinished(async () => {
    beforeCleanup();
    await state.cleanup();
  });
  const readConfig = () => fs.readFile(state.configPath, "utf8");
  return Object.assign(state, {
    readConfig,
    readJsonConfig: async (): Promise<OpenClawConfig> => JSON.parse(await readConfig()),
  });
}

export async function expectMissing(...paths: string[]) {
  for (const file of paths) {
    await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

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
    const key = `agent:${target.agentId}:main`;
    const entry = { sessionId: `preserved-${target.agentId}`, updatedAt: 1 };
    runOpenClawAgentWriteTransaction(
      (database) => writeSessionEntry(database, key, entry, { previousEntry: null }),
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
    readBytes: () => Promise.all(held.map((target) => fs.readFile(target.path))),
    readHolds: () => readAgentDeletionRecoveryHolds(openOpenClawStateDatabase({ env: state.env })),
  };
}

type PreparationPhase = "workspace" | "workspace-write" | "config";
export function installWorkspacePreparationPause(
  workspace: string,
  phase: PreparationPhase,
  pause: (phase: PreparationPhase) => Promise<void>,
  signal: AbortSignal,
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
  const run = filesystemWorker.runFsSafeFilesystemTask;
  type Options = Parameters<typeof run>[1];
  function intercept(
    command: WorkspaceFilesystemReadCommand,
    options?: Options,
  ): Promise<WorkspaceFilesystemReadReply>;
  function intercept(
    command: WorkspaceFilesystemCommand,
    options?: Options,
  ): Promise<WorkspaceFilesystemReply>;
  function intercept(command: FsSafeStoreCommand, options?: Options): Promise<FsSafeStoreReply>;
  function intercept(
    command: WorkspaceFilesystemReadCommand | WorkspaceFilesystemCommand | FsSafeStoreCommand,
    options?: Options,
  ) {
    if (command.type === "workspace") {
      if (command.operation.kind === "publish" && command.operation.dir === workspace) {
        const notify = options?.onNotification;
        if (!notify) {
          throw new Error("Bootstrap publication must retain its live authority callback");
        }
        // Keep the real write/cleanup owner beside this fixture's mid-write pause.
        return withWorkerFsSafeNativeMode(command.nativeMode, () =>
          executeWorkspaceFilesystemOperation(
            command,
            workerMutationAssertion(
              command.decision,
              () => notify("authority"),
              () => signal.throwIfAborted(),
            ),
          ),
        );
      }
      return run(command, options);
    }
    return command.type === "workspace-read" ? run(command, options) : run(command, options);
  }
  const dispatch =
    phase === "workspace-write"
      ? vi.spyOn(filesystemWorker, "runFsSafeFilesystemTask").mockImplementation(intercept)
      : undefined;
  return () => {
    dispatch?.mockRestore();
    open.mockRestore();
    for (const restore of restoreWrites) {
      restore();
    }
    access.mockRestore();
    nativeModeEnv.restore();
  };
}

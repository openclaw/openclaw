import { writeFile } from "node:fs/promises";
import path from "node:path";
import { captureOpenAIResponsesCompaction } from "@openclaw/ai/transports";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { CliHistoryWriter } from "../config/sessions/cli-history-boundary.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { clearInternalHooks, registerInternalHook } from "../hooks/internal-hooks.js";
import type { AssistantMessage, Model } from "../llm/types.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import { resolveBootstrapContextForRun } from "./bootstrap-files.js";
import { prepareBootstrapSnapshot } from "./bootstrap-snapshot.js";
import { buildBootstrapContextForFiles } from "./embedded-agent-helpers/bootstrap.js";
import { SessionManager } from "./sessions/session-manager.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const stateDir of dirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
    clearRuntimeConfigSnapshot();
    clearInternalHooks();
  });
});

it("recovers saved bytes beyond the recent-event window and refreshes only at a boundary", async () => {
  const workspaceDir = dirs.make("openclaw-workspace-snapshot-");
  setRuntimeConfigSnapshot({});
  const target = {
    agentId: "main",
    sessionId: "snapshot",
    sessionKey: "agent:main:snapshot",
    storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1,
    activeWriterRunId: "snapshot-run",
  });
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("revoked");
    }
  };
  const writer: CliHistoryWriter = {
    target,
    runId: "snapshot-run",
    authFingerprint: "a".repeat(64),
    assertCurrent,
    assertReadable: assertCurrent,
  };
  await writeFile(path.join(workspaceDir, "AGENTS.md"), "FIRST");
  registerInternalHook("agent:bootstrap", (event) => {
    if (Array.isArray(event.context.bootstrapFiles)) {
      event.context.bootstrapFiles.push(
        {
          name: "EXTRA.md",
          path: path.join(workspaceDir, "EXTRA.md"),
          content: "HOOK_EXTRA",
          missing: false,
        },
        { path: path.join(workspaceDir, "PATH_ONLY.md"), content: "HOOK_PATH_ONLY" },
      );
    }
  });
  const load = vi.fn(() =>
    resolveBootstrapContextForRun({ workspaceDir, sessionKey: target.sessionKey }),
  );
  const owner = () =>
    prepareBootstrapSnapshot({
      writer,
      workspaceDir,
      load,
      assertCurrent,
      render: (files) => buildBootstrapContextForFiles(files, {}),
    });
  expect((await (await owner()).load(false)).contextFiles[0]?.content).toBe("FIRST");
  // No model messages: storage-only notes may grow beyond continuation marker bounds.
  for (let index = 0; index < 501; index++) {
    await appendTranscriptEvent(target, {
      type: "custom",
      id: `note-${index}`,
      customType: "note",
      data: {},
    });
  }
  await writeFile(path.join(workspaceDir, "AGENTS.md"), "SECOND");
  expect((await (await owner()).load(false)).contextFiles[0]?.content).toBe("FIRST");
  expect(load).toHaveBeenCalledTimes(1);
  const recovered = await (await owner()).load(false);
  expect(recovered.contextFiles).toEqual(
    expect.arrayContaining([
      { path: path.join(workspaceDir, "EXTRA.md"), content: "HOOK_EXTRA" },
      { path: path.join(workspaceDir, "PATH_ONLY.md"), content: "HOOK_PATH_ONLY" },
    ]),
  );
  expect(recovered.bootstrapFiles.find((file) => file.name === "PATH_ONLY.md")?.missing).toBe(
    false,
  );
  expect((await (await owner()).load(true)).contextFiles[0]?.content).toBe("SECOND");
  expect((await (await owner()).load(false)).contextFiles[0]?.content).toBe("SECOND");
  current = false;
  await expect((await owner()).load(true)).rejects.toThrow("revoked");
  expect(load).toHaveBeenCalledTimes(2);
});

it("persists only workspace metadata under the host fence while legacy history stays unknown", async () => {
  const workspaceDir = dirs.make("openclaw-legacy-workspace-");
  setRuntimeConfigSnapshot({});
  const target = {
    agentId: "main",
    sessionId: "legacy",
    sessionKey: "agent:main:legacy",
    storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt: 1,
    activeWriterRunId: "host-run",
  });
  await appendTranscriptMessage(target, {
    cwd: workspaceDir,
    eventId: "legacy-message",
    parentId: null,
    now: 1,
    message: { role: "user", content: "LEGACY_HISTORY", timestamp: 1 },
  });
  const model = {
    id: "fixture",
    name: "fixture",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    contextWindow: 4096,
    maxTokens: 128,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } satisfies Model;
  const assistant: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "KEPT_ANSWER" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    timestamp: 2,
    stopReason: "stop",
    usage: createZeroUsageFixture(),
  };
  await appendTranscriptMessage(target, {
    cwd: workspaceDir,
    eventId: "rewrite-source",
    parentId: "legacy-message",
    now: 2,
    message: assistant,
  });
  await writeFile(path.join(workspaceDir, "AGENTS.md"), "FIRST_HOST_WORKSPACE");
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("revoked");
    }
  };
  const load = () => resolveBootstrapContextForRun({ workspaceDir });
  await expect(
    prepareBootstrapSnapshot({
      target,
      expectedWriterRunId: "host-run",
      workspaceDir,
      assertCurrent,
      load,
      render: (files) => buildBootstrapContextForFiles(files, {}),
    }),
  ).rejects.toThrow("host transcript writer fence");
  await withOwnedSessionTranscriptWrites(
    {
      sessionTarget: { ...target, expectedWriterRunId: "host-run" },
      assertCommitAllowed: assertCurrent,
      withTranscriptWrite: async (run) => await run(),
    },
    async () => {
      const params = {
        target,
        expectedWriterRunId: "host-run",
        workspaceDir,
        assertCurrent,
        load,
        render: (files) => buildBootstrapContextForFiles(files, {}),
      };
      const initial = await prepareBootstrapSnapshot(params);
      expect((await initial.load(false, { deferCreate: true })).contextFiles[0]?.content).toBe(
        "FIRST_HOST_WORKSPACE",
      );
      expect(initial.hasSnapshot).toBe(false);
      await initial.commit();
      expect(loadSessionEntryReadOnly(target)?.cliHistoryBoundary).toBeUndefined();
      await writeFile(path.join(workspaceDir, "AGENTS.md"), "SECOND_HOST_WORKSPACE");
      const restarted = await prepareBootstrapSnapshot(params);
      expect((await restarted.load(false)).contextFiles[0]?.content).toBe("FIRST_HOST_WORKSPACE");
      expect((await restarted.load(true)).contextFiles[0]?.content).toBe("SECOND_HOST_WORKSPACE");
      expect(loadSessionEntryReadOnly(target)?.cliHistoryBoundary).toBeUndefined();
      const entries = (await SessionManager.openAsync(target, workspaceDir)).getEntries();
      expect(entries.find((entry) => entry.id === "legacy-message")).toMatchObject({
        message: { role: "user", content: "LEGACY_HISTORY", timestamp: 1 },
      });
      // A persisted alternate branch can retain prior snapshots outside its active path.
      const manager = await SessionManager.openAsync(target, workspaceDir);
      const replacement = structuredClone(assistant);
      captureOpenAIResponsesCompaction(
        replacement,
        { type: "compaction", id: "cmp_fixture", encrypted_content: "opaque" },
        "retained-users",
        model,
      );
      await manager.branchAsync("legacy-message");
      const replacementId = await manager.appendMessageAsync(replacement);
      expect(replacementId).toBeTypeOf("string");
      const coldManager = await SessionManager.openAsync(target, workspaceDir);
      expect(coldManager.getLeafId()).toBe(replacementId);
      const snapshotEntry = (entry: { type: string; customType?: string }) =>
        entry.type === "custom" && entry.customType === "openclaw:workspace-context:v1";
      expect(coldManager.getBranch().some(snapshotEntry)).toBe(false);
      expect(coldManager.getEntries().some(snapshotEntry)).toBe(true);
      await writeFile(path.join(workspaceDir, "AGENTS.md"), "POST_REWRITE_WORKSPACE");
      const afterRewrite = await prepareBootstrapSnapshot(params);
      expect((await afterRewrite.load(false, { deferCreate: true })).contextFiles[0]?.content).toBe(
        "POST_REWRITE_WORKSPACE",
      );
      // Prior private metadata must still close the first-enable native-history exception.
      expect(afterRewrite.hasSnapshot).toBe(true);
      current = false;
      await expect(restarted.load(true)).rejects.toThrow("revoked");
    },
  );
});

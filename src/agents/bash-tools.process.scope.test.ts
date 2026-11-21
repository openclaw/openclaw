import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createOpenClawCodingToolsInternalAsync } from "./agent-tools.async.js";
import { waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { completionConfig } from "./bash-tools.lifecycle.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import type { ParticipationCeiling } from "./participation-ceiling.js";
import { getTextContent } from "./test-helpers/agent-tools-fs-helpers.js";

// mock-isolation: Each test owns the supervisor; subprocesses and cleanup are real.
vi.mock("../process/supervisor/index.js", () => ({ getProcessSupervisor: () => supervisor }));
let supervisor: ReturnType<typeof createProcessSupervisor>;
let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "process-tree-access" });
  const config = completionConfig(state.workspaceDir);
  setRuntimeConfigSnapshot(config);
  await state.writeConfig(config);
  openOpenClawStateDatabase();
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(() => {
  supervisor = createProcessSupervisor();
});

afterEach(async () => {
  await supervisor.shutdown();
  resetProcessRegistryForTests();
});

test.skipIf(process.platform === "win32")(
  "lets a child observe and stop an ancestor's exec without crossing trees or agents",
  async () => {
    const parent = "agent:main:process-parent";
    const child = "agent:main:subagent:process-child";
    const grandchild = "agent:main:subagent:process-grandchild";
    try {
      for (const [sessionKey, parentSessionKey] of [
        [parent, undefined],
        [child, parent],
        [grandchild, child],
        ["agent:main:unrelated", undefined],
        ["agent:other:subagent:cross-agent", parent],
      ] as const) {
        await replaceSessionEntry(
          { agentId: sessionKey.split(":")[1], sessionKey },
          { sessionId: sessionKey, updatedAt: 1, parentSessionKey },
        );
      }
      const exec = createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: true,
        agentId: "main",
        scopeKey: parent,
        sessionKey: parent,
        notifyOnExit: false,
      });
      const started = await exec.execute("start", {
        command: "printf 'ANCESTOR_OUTPUT\\n'; sleep 60",
        background: true,
      });
      expect(started.details).toMatchObject({ status: "running" });
      const sessionId = (started.details as { sessionId: string }).sessionId;
      const tool = (sessionKey: string) =>
        createProcessTool({
          scopeKey: sessionKey,
          sessionKey,
          agentId: sessionKey.split(":")[1],
        });
      using reads = vi.spyOn(sessionReads, "withSessionEntryReadOnlyInWorker");
      await tool(parent).execute("ready", { action: "poll", sessionId, timeout: 5_000 });
      expect(reads).not.toHaveBeenCalled();
      expect(await tool(child).execute("poll", { action: "poll", sessionId })).toMatchObject({
        details: { status: "running", sessionId },
      });
      expect(
        getTextContent(await tool(grandchild).execute("log", { action: "log", sessionId })),
      ).toContain("ANCESTOR_OUTPUT");
      for (const stranger of ["agent:main:unrelated", "agent:other:subagent:cross-agent"]) {
        for (const action of ["poll", "log", "kill"] as const) {
          expect(
            (await tool(stranger).execute("denied", { action, sessionId })).details,
          ).toMatchObject({ status: "failed" });
        }
        expect((await tool(stranger).execute("list", { action: "list" })).details).toMatchObject({
          sessions: [],
        });
      }
      expect(
        (await tool(child).execute("kill", { action: "kill", sessionId })).details,
      ).toMatchObject({ cancellationRequested: true });
      await waitForExecScope(parent);
      expect(
        (await tool(child).execute("finished", { action: "poll", sessionId })).details,
      ).toMatchObject({ exitReason: "manual-cancel" });
    } finally {
      await supervisor.shutdown();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "assembles participating children with source-root caps and child-local observational process access",
  async () => {
    const parent = "agent:main:private-parent";
    const child = "agent:main:subagent:invited-child";
    const sibling = "agent:main:subagent:private-sibling";
    const root = path.join(state.workspaceDir, "invited-root");
    const outside = path.join(state.workspaceDir, "outside.txt");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "inside.txt"), "INSIDE_SOURCE_ROOT");
    await fs.writeFile(outside, "OUTSIDE_SOURCE_ROOT");
    const ceiling: ParticipationCeiling = {
      kind: "send",
      profileId: "participant",
      sessionKey: parent,
      permission: "workspace",
      source: {
        agentId: "main",
        sessionId: parent,
        lifecycleRevision: null,
        creatorProfileId: "creator",
        root,
      },
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: parent },
      {
        sessionId: parent,
        updatedAt: 1,
        sessionRoot: root,
        createdActor: { type: "human", source: "profile", id: "creator" },
      },
    );
    for (const sessionKey of [child, sibling]) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: sessionKey,
          updatedAt: 1,
          parentSessionKey: parent,
          ...(sessionKey === child
            ? { inheritedToolPolicySource: "participant", participationCeiling: ceiling }
            : {}),
        },
      );
    }
    const start = async (sessionKey: string, output: string) => {
      const result = await createExecTool({
        host: "gateway",
        security: "full",
        ask: "off",
        allowBackground: true,
        agentId: "main",
        scopeKey: sessionKey,
        sessionKey,
        notifyOnExit: false,
      }).execute("start", { command: `printf '${output}\\n'; sleep 60`, background: true });
      expect(result.details).toMatchObject({ status: "running" });
      const sessionId = (result.details as { sessionId: string }).sessionId;
      await createProcessTool({ scopeKey: sessionKey }).execute("ready", {
        action: "poll",
        sessionId,
        timeout: 5_000,
      });
      return sessionId;
    };
    const parentId = await start(parent, "SENSITIVE_PARENT_OUTPUT");
    const siblingId = await start(sibling, "SENSITIVE_SIBLING_OUTPUT");
    const childId = await start(child, "INVITED_CHILD_OUTPUT");
    const recorded = expectDefined(
      (await sessionReads.readSessionEntryReadOnlyInWorker({ agentId: "main", sessionKey: child }))
        ?.participationCeiling,
      "recorded child ceiling",
    );
    expect(recorded).toEqual(ceiling);
    const recordedRoot = expectDefined(recorded.source, "original source").root;
    for (const permission of ["read-only", "workspace"] as const) {
      const tools = await createOpenClawCodingToolsInternalAsync({
        config: completionConfig(state.workspaceDir),
        agentId: "main",
        sessionKey: child,
        runSessionKey: child,
        workspaceDir: recordedRoot,
        participationCeiling: { ...recorded, permission },
        sessionPermissionPolicy: { root: recordedRoot, mode: "full" },
        exec: { host: "gateway" },
        toolConstructionPlan: {
          includeBaseCodingTools: true,
          includeShellTools: true,
          includeChannelTools: false,
          includeOpenClawTools: false,
          includePluginTools: false,
        },
      });
      const tool = (name: string) =>
        expectDefined(
          tools.find((entry) => entry.name === name),
          name,
        );
      expect(getTextContent(await tool("read").execute("inside", { path: "inside.txt" }))).toBe(
        "INSIDE_SOURCE_ROOT",
      );
      await expect(tool("read").execute("outside", { path: outside })).rejects.toThrow(
        /escapes .*root/,
      );
      if (permission === "read-only") {
        for (const name of ["write", "edit", "apply_patch"]) {
          expect(tools.map((entry) => entry.name)).not.toContain(name);
        }
        await expect(tool("exec").execute("deny", { command: "true" })).rejects.toThrow(
          /security=deny/,
        );
      } else {
        await tool("write").execute("inside", { path: "created.txt", content: "created" });
        await expect(fs.readFile(path.join(root, "created.txt"), "utf8")).resolves.toBe("created");
        await expect(
          tool("write").execute("outside", { path: outside, content: "escape" }),
        ).rejects.toThrow(/escapes .*root/);
      }
      const participant = tool("process");
      using reads = vi.spyOn(sessionReads, "withSessionEntryReadOnlyInWorker");
      const listed = await participant.execute("list", { action: "list" });
      expect(listed.details).toMatchObject({ sessions: [{ sessionId: childId }] });
      expect(JSON.stringify(listed)).not.toContain("SENSITIVE_");
      for (const sessionId of [parentId, siblingId]) {
        for (const action of ["poll", "log"] as const) {
          const denied = await participant.execute(action, { action, sessionId });
          expect(denied.details).toMatchObject({ status: "failed" });
          expect(JSON.stringify(denied)).not.toContain("SENSITIVE_");
        }
      }
      for (const action of ["write", "send-keys", "submit", "paste", "kill", "clear", "remove"]) {
        const denied = await participant.execute(action, {
          action,
          sessionId: childId,
          data: "touch outside.txt\n",
          text: "touch outside.txt",
          keys: ["Enter"],
        });
        expect(denied.details).toMatchObject({ status: "failed" });
        expect(getTextContent(denied)).toContain("only list, poll, or log");
      }
      expect(
        (await participant.execute("poll", { action: "poll", sessionId: childId })).details,
      ).toMatchObject({ status: "running" });
      expect(
        getTextContent(await participant.execute("log", { action: "log", sessionId: childId })),
      ).toContain("INVITED_CHILD_OUTPUT");
      expect(reads).not.toHaveBeenCalled();
    }
    await expect(fs.readFile(outside, "utf8")).resolves.toBe("OUTSIDE_SOURCE_ROOT");
  },
);

test("explains a pre-restart handle after the process registry is recreated", async () => {
  const exec = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    notifyOnExit: false,
  });
  const started = await exec.execute("start", { command: "echo restart-proof", background: true });
  const sessionId = (started.details as { sessionId: string }).sessionId;
  expect(sessionId).toEqual(expect.any(String));
  await supervisor.shutdown();
  vi.resetModules();
  const restarted = await import("./bash-tools.process.js");
  const result = await restarted
    .createProcessTool()
    .execute("old-handle", { action: "poll", sessionId });
  expect(getTextContent(result)).toContain(
    "was started before the Gateway restarted and is no longer tracked",
  );
  expect(getTextContent(result)).toContain("rerun it if still needed");
  expect(result.details).toMatchObject({ status: "failed" });
});

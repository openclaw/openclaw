import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { completionConfig } from "./bash-tools.lifecycle.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
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
  "keeps a participating child's observations within the invited session",
  async () => {
    const parent = "agent:main:private-parent";
    const child = "agent:main:subagent:invited-child";
    await replaceSessionEntry(
      { agentId: "main", sessionKey: parent },
      { sessionId: parent, updatedAt: 1 },
    );
    await replaceSessionEntry(
      { agentId: "main", sessionKey: child },
      { sessionId: child, updatedAt: 1, parentSessionKey: parent },
    );
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
    const childId = await start(child, "INVITED_CHILD_OUTPUT");
    const participant = createProcessTool({
      scopeKey: child,
      sessionKey: child,
      agentId: "main",
      readOnly: true,
      includeAncestors: false,
    });
    using reads = vi.spyOn(sessionReads, "withSessionEntryReadOnlyInWorker");
    const listed = await participant.execute("list", { action: "list" });
    expect(listed.details).toMatchObject({ sessions: [{ sessionId: childId }] });
    expect(JSON.stringify(listed)).not.toContain("SENSITIVE_PARENT_OUTPUT");
    for (const action of ["poll", "log"] as const) {
      const denied = await participant.execute(action, { action, sessionId: parentId });
      expect(denied.details).toMatchObject({ status: "failed" });
      expect(JSON.stringify(denied)).not.toContain("SENSITIVE_PARENT_OUTPUT");
      expect(
        (await participant.execute(action, { action, sessionId: childId })).details,
      ).toMatchObject({ status: "running" });
    }
    expect(
      getTextContent(await participant.execute("log", { action: "log", sessionId: childId })),
    ).toContain("INVITED_CHILD_OUTPUT");
    expect(reads).not.toHaveBeenCalled();
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

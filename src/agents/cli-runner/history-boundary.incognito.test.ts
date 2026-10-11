import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import { runWithSessionActorStorage } from "../../config/sessions/session-actor-storage-binding.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { sessionTranscriptHasContent } from "../command/attempt-execution.helpers.js";
import { SessionManager } from "../sessions/session-manager.js";
import { persistCliRunBlock } from "./cli-run-transcript.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import { hasCliSessionTranscript, loadCliSessionHistoryMessages } from "./session-history.js";
import type { PreparedCliRunContext } from "./types.js";

vi.mock("node:sqlite", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:sqlite")>()),
  DatabaseSync: vi.fn(function () {
    throw new Error("Memory CLI history opened SQLite");
  }),
}));
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  Worker: vi.fn(function () {
    throw new Error("Memory CLI history allocated a worker");
  }),
}));
const authority = { assertCurrent() {}, authorize() {} };
const env = { OPENCLAW_STATE_DIR: "/synthetic/cli" };
afterEach(() => memorySessionActorOwners.reset());

async function create(name: string) {
  const path = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env });
  const owner = memorySessionActorOwners.get({ agentId: "main", path });
  const target = {
    agentId: "main",
    sessionKey: `agent:main:dashboard:incognito-${name}`,
    sessionId: name,
    storePath: path,
  };
  const actor = await owner.acquire(
    { database: owner.identity, sessionKey: target.sessionKey },
    {
      assertCurrent() {},
      assertReadable() {},
    },
  );
  const created = await actor.storage!.mutate(
    {
      type: "session.entry.create",
      input: {
        entry: {
          sessionId: name,
          lifecycleRevision: "initial",
          incognito: true,
          updatedAt: Date.now(),
          sessionStartedAt: Date.now(),
          permissionMode: "full",
          thinkingLevel: "high",
        },
      },
    },
    authority,
  );
  expect(created.kind).toBe("committed");
  return { target, binding: { actor, authority, agentId: "main", path } };
}

it("prepares private CLI history and refuses an unattributed append at execution", async () => {
  const { target } = await create("history");
  const admission = prepareSystemAgentRunAdmission({}, "actor-cli-run", "main", "history-test");
  try {
    const params: PreparedCliRunContext["params"] = {
      ...target,
      sessionTarget: target,
      sessionFile: target.sessionKey,
      admittedRunContext: await admission.admit("embedded"),
      runId: "actor-cli-run",
      provider: "test-cli",
      model: "test-model",
      prompt: "current ask",
      workspaceDir: env.OPENCLAW_STATE_DIR!,
      timeoutMs: 1000,
    };
    {
      const writer = await prepareCliHistoryBoundary(params, {
        credential: { type: "token", provider: "test-cli", token: "synthetic-account" },
      });
      assert(writer);
      writer.assertReadable();
      await runWithCliHistoryWriter(writer, async () => {
        const manager = await SessionManager.openAsync(target);
        await manager.appendMessageAsync(makeUserMessage("Private CLI context", 1));
        await manager.appendMessageAsync({
          role: "assistant",
          content: [{ type: "text", text: "Private CLI answer" }],
          api: "cli",
          provider: "test-cli",
          model: "test-model",
          stopReason: "stop",
          timestamp: 2,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        });
        writer.assertReadable();
        expect(await hasCliSessionTranscript({ sessionTarget: target })).toBe(true);
        expect(await loadCliSessionHistoryMessages({ sessionTarget: target })).toMatchObject([
          { role: "user", content: "Private CLI context" },
          { role: "assistant", content: [{ type: "text", text: "Private CLI answer" }] },
        ]);
        expect(await sessionTranscriptHasContent(target)).toBe(true);
      });
      const manager = await SessionManager.openAsync(target);
      await manager.appendMessageAsync(makeUserMessage("Different writer", 3));
      expect(() => writer.assertReadable()).toThrow("CLI history authority changed");
    }
  } finally {
    admission.close();
  }
});

it("records a redacted blocked CLI turn on the selected actor", async () => {
  const { target, binding } = await create("command");
  await runWithSessionActorStorage(binding, async () => {
    const cfg = { agents: { defaults: {} }, session: { store: target.storePath } };
    await persistCliRunBlock(
      {
        ...target,
        config: cfg,
        sessionEntry: binding.actor.snapshot(authority)?.entry,
        sessionTarget: target,
        sessionFile: target.sessionKey,
        runId: "blocked-cli-run",
        provider: "test-cli",
        prompt: "Private rejected content",
        workspaceDir: env.OPENCLAW_STATE_DIR!,
        timeoutMs: 1000,
      },
      { pluginId: "test-policy", message: "Policy blocked this request" },
    );
    const history = await loadCliSessionHistoryMessages({ sessionTarget: target });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(history)).toContain("Policy blocked this request");
    expect(JSON.stringify(history)).not.toContain("Private rejected content");
  });
});

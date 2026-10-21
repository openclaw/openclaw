import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import {
  runWithSessionActorStorage,
  type SessionActorStorageBinding,
} from "../config/sessions/session-actor-storage-binding.js";
import { sendMessage } from "../infra/outbound/message.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import { callGatewayTool } from "./tools/gateway.js";

// mock-isolation: Control the external Gateway response while retaining actor lifecycle checks.
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
// mock-isolation: Observe external delivery without sending a real channel message.
vi.mock("../infra/outbound/message.js", () => ({ sendMessage: vi.fn(async () => ({ ok: true })) }));

const temporary = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {}, authorize() {} };
let actor: ReturnType<typeof memorySessionActorOwners.get>;
const bindings: SessionActorStorageBinding[] = [];
let sql: ReturnType<typeof observeHostDataSql>;
beforeAll(() => {
  const env = { OPENCLAW_STATE_DIR: temporary.make("approval-followup-incognito-") };
  actor = memorySessionActorOwners.get({
    agentId: "main",
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env }),
  });
});
afterAll(async () => {
  for (const binding of bindings) {
    await binding.actor.release();
  }
  memorySessionActorOwners.closeDatabase(actor);
});
beforeEach(() => {
  sql = observeHostDataSql();
  vi.mocked(sendMessage).mockClear();
  vi.mocked(callGatewayTool).mockReset();
});
afterEach(() => {
  try {
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

async function session(name: string) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry = { sessionId: name, lifecycleRevision: "original", updatedAt: 1 };
  const handle = await actor.acquire(
    { database: actor.identity, sessionKey },
    { assertCurrent() {}, assertReadable() {} },
  );
  const binding = { actor: handle, authority, agentId: actor.agentId, path: actor.path };
  bindings.push(binding);
  expect(
    await handle.storage!.mutate({ type: "session.entry.create", input: { entry } }, authority),
  ).toMatchObject({ kind: "committed" });
  return {
    entry,
    binding,
    target: { agentId: "main", sessionKey, storePath: actor.path },
    send: (overrides: Partial<Parameters<typeof sendExecApprovalFollowup>[0]> = {}) =>
      runWithSessionActorStorage(binding, () =>
        sendExecApprovalFollowup({
          approvalId: name,
          agentId: "main",
          sessionKey,
          expectedSessionId: name,
          resultText: `Exec finished (gateway id=${name}, code 0)\nprivate result`,
          turnSourceChannel: "telegram",
          turnSourceTo: "123",
          internalRuntimeHandoffId: `handoff-${name}`,
          ...overrides,
        }),
      ),
  };
}

it("delivers matching actor completion and denial without consulting native sessions", async () => {
  const fixture = await session("current");
  await expect(fixture.send({ direct: true })).resolves.toBe(true);
  await expect(
    fixture.send({
      direct: true,
      resultText: "Exec denied (gateway id=current, approval-timeout): uname -a",
    }),
  ).resolves.toBe(true);
  expect(vi.mocked(sendMessage).mock.calls.map(([request]) => request.content)).toEqual([
    "private result",
    "Command did not run: approval timed out.",
  ]);
  expect(callGatewayTool).not.toHaveBeenCalled();
});

it.each(["reset", "rebound", "close"] as const)(
  "suppresses fallback after actor %s during the session-resume wait",
  async (change) => {
    const fixture = await session(change);
    const requested = createDeferredCore();
    const resume = createDeferredCore<Record<string, unknown>>();
    vi.mocked(callGatewayTool).mockImplementationOnce(() => {
      requested.resolve();
      return resume.promise;
    });
    const result = fixture.send();
    try {
      await awaitGateBeforeSettlement(requested.promise, result, "Followup settled before resume");
      if (change === "close") {
        actor.closeSession(fixture.target.sessionKey);
      } else {
        await runWithSessionActorStorage(fixture.binding, () =>
          replaceSessionEntry(fixture.target, {
            ...fixture.entry,
            ...(change === "rebound" ? { sessionId: "replacement" } : {}),
            lifecycleRevision: "next",
          }),
        );
      }
    } finally {
      resume.reject(new Error("session resume unavailable"));
    }
    await expect(result).resolves.toBe(false);
    expect(callGatewayTool).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  },
);

it("keeps a closed session absent without creating a replacement", async () => {
  const fixture = await session("absent");
  actor.closeSession(fixture.target.sessionKey);
  await expect(fixture.send({ direct: true })).resolves.toBe(false);
  expect(actor.readSession(fixture.target.sessionKey, authority)).toBeUndefined();
  expect(callGatewayTool).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

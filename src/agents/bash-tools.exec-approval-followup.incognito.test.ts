import "../test-utils/prepare-compiled-subprocesses.js";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  withIncognitoSessionActor,
  withIncognitoSessionBinding,
} from "../config/sessions/session-incognito-binding.js";
import { sendMessage } from "../infra/outbound/message.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  openIncognitoTestActor,
  useIncognitoNoHostSql,
} from "../state/openclaw-agent-execution-incognito.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import { callGatewayTool } from "./tools/gateway.js";

// mock-isolation: Control the external Gateway response while retaining actor lifecycle checks.
vi.mock("./tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));
// mock-isolation: Observe external delivery without sending a real channel message.
vi.mock("../infra/outbound/message.js", () => ({ sendMessage: vi.fn(async () => ({ ok: true })) }));

const temporary = useAutoCleanupTempDirTracker(afterAll);
const authority = { assertCurrent() {} };
let actor: Awaited<ReturnType<typeof openIncognitoTestActor>>;
let closingActor: typeof actor;
beforeAll(async () => {
  actor = await openIncognitoTestActor(
    { OPENCLAW_STATE_DIR: temporary.make("approval-followup-incognito-") },
    authority,
  );
  closingActor = await openIncognitoTestActor(
    { OPENCLAW_STATE_DIR: temporary.make("approval-followup-closing-") },
    authority,
  );
});
afterAll(async () => {
  await Promise.all([actor.close(), closingActor.close()]);
});
beforeEach(() => {
  vi.mocked(sendMessage).mockClear();
  vi.mocked(callGatewayTool).mockReset();
});
useIncognitoNoHostSql();

async function session(name: string, owner = actor) {
  const sessionKey = `agent:main:dashboard:incognito-${name}`;
  const entry = { sessionId: name, lifecycleRevision: "original", updatedAt: 1 };
  await owner.sessions.create(authority, { sessionKey, entry });
  return {
    entry,
    target: { agentId: "main", sessionKey, storePath: owner.path },
    followup: {
      approvalId: name,
      agentId: "main",
      sessionKey,
      expectedSessionId: name,
      resultText: `Exec finished (gateway id=${name}, code 0)\nprivate result`,
      turnSourceChannel: "telegram",
      turnSourceTo: "123",
      internalRuntimeHandoffId: `handoff-${name}`,
    },
  };
}

it("delivers matching actor completion and denial without consulting native sessions", async () => {
  const fixture = await session("current");
  await withIncognitoSessionActor(actor, async () => {
    await expect(sendExecApprovalFollowup({ ...fixture.followup, direct: true })).resolves.toBe(
      true,
    );
    await expect(
      sendExecApprovalFollowup({
        ...fixture.followup,
        direct: true,
        resultText: "Exec denied (gateway id=current, approval-timeout): uname -a",
      }),
    ).resolves.toBe(true);
  });
  expect(vi.mocked(sendMessage).mock.calls.map(([request]) => request.content)).toEqual([
    "private result",
    "Command did not run: approval timed out.",
  ]);
  expect(callGatewayTool).not.toHaveBeenCalled();
});

it.each(["reset", "rebound", "close"] as const)(
  "suppresses fallback after actor %s during the session-resume wait",
  async (change) => {
    const owner = change === "close" ? closingActor : actor;
    const fixture = await session(change, owner);
    const requested = createDeferredCore();
    const resume = createDeferredCore<Record<string, unknown>>();
    vi.mocked(callGatewayTool).mockImplementationOnce(() => {
      requested.resolve();
      return resume.promise;
    });
    let closing: Promise<void> | undefined;
    const result = withIncognitoSessionActor(owner, () =>
      sendExecApprovalFollowup(fixture.followup),
    );
    try {
      await awaitGateBeforeSettlement(requested.promise, result, "Followup settled before resume");
      if (change === "close") {
        closing = owner.close();
      } else {
        await withIncognitoSessionActor(owner, () =>
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
    if (change === "close") {
      await expect(result).rejects.toMatchObject({ code: "INCOGNITO_SESSION_ENDED" });
    } else {
      await expect(result).resolves.toBe(false);
    }
    await closing;
    if (change === "close") {
      await expect(
        withIncognitoSessionBinding({ actor: owner }, () =>
          sendExecApprovalFollowup({ ...fixture.followup, direct: true }),
        ),
      ).rejects.toThrow("Incognito session ended");
    }
    expect(callGatewayTool).toHaveBeenCalledOnce();
    expect(sendMessage).not.toHaveBeenCalled();
  },
);

it("keeps selected absence noncreating", async () => {
  const env = { OPENCLAW_STATE_DIR: temporary.make("approval-followup-absent-") };
  const followup = {
    approvalId: "absent",
    agentId: "main",
    sessionKey: "agent:main:dashboard:incognito-absent",
    expectedSessionId: "absent",
    resultText: "Exec finished (gateway id=absent, code 0)\nprivate result",
    turnSourceChannel: "telegram",
    turnSourceTo: "123",
    direct: true,
  };
  await expect(
    withIncognitoSessionBinding({ kind: "absent", agentId: "main", env, authority }, () =>
      sendExecApprovalFollowup(followup),
    ),
  ).resolves.toBe(false);
  expect(captureOpenClawAgentDatabaseExecution.listIncognito(env)).toEqual([]);
  expect(callGatewayTool).not.toHaveBeenCalled();
  expect(sendMessage).not.toHaveBeenCalled();
});

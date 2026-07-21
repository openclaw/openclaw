import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  armSessionsSendDeferredCompletion,
  disarmSessionsSendDeferredCompletion,
  maybeCompleteSessionsSendDeferred,
  testing,
} from "./sessions-send-deferred.js";

const targetRunId = "target-run-1";
const targetSessionKey = "agent:research:main";
const requesterSessionKey = "agent:main:telegram:dm:123";
const requesterSessionId = "requester-session-1";

describe("sessions_send deferred completion", () => {
  let stateDir: string;
  let options: { env: NodeJS.ProcessEnv };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "openclaw-sessions-send-deferred-"));
    options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    testing.resetPendingRunIds();
  });

  afterEach(() => {
    testing.resetPendingRunIds();
    closeOpenClawStateDatabase();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function arm(overrides: Partial<Parameters<typeof armSessionsSendDeferredCompletion>[0]> = {}) {
    return armSessionsSendDeferredCompletion(
      {
        targetRunId,
        targetSessionKey,
        requesterSessionKey,
        requesterSessionId,
        requesterOrigin: {
          channel: "telegram",
          to: "7504982318",
          accountId: "primary",
          threadId: "42",
        },
        requestMessage: "Find the deployment failure",
        ...overrides,
      },
      options,
    );
  }

  it("survives a database reopen and dispatches one exact-origin continuation", async () => {
    arm();
    closeOpenClawStateDatabase();
    testing.resetPendingRunIds();
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));

    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          result: { payloads: [{ text: "The deployment failed during migration." }] },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: requesterSessionKey,
        expectedExistingSessionId: requesterSessionId,
        channel: "telegram",
        to: "7504982318",
        accountId: "primary",
        threadId: "42",
        deliver: true,
        bestEffortDeliver: false,
        sourceReplyDeliveryMode: "automatic",
      }),
    );
    expect(dispatch.mock.calls[0]?.[0]?.message).toContain(
      "The deployment failed during migration.",
    );

    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          result: { payloads: [{ text: "duplicate" }] },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched target session without consuming the registration", async () => {
    arm();
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));

    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey: "agent:forged:main",
          terminalOutcome: { status: "ok", reason: "completed" },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(false);
    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("wakes the requester with terminal failure context", async () => {
    arm();
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));

    await maybeCompleteSessionsSendDeferred(
      {
        targetRunId,
        targetSessionKey,
        terminalOutcome: {
          status: "error",
          reason: "failed",
          error: "provider authentication failed",
        },
        dispatch,
      },
      options,
    );

    expect(dispatch.mock.calls[0]?.[0]?.message).toContain("provider authentication failed");
  });

  it("keeps concurrent target completions bound to their respective origins", async () => {
    arm({ targetRunId: "telegram-run" });
    arm({
      targetRunId: "slack-run",
      targetSessionKey: "agent:operations:main",
      requesterSessionKey: "agent:main:slack:channel:ops",
      requesterSessionId: "requester-session-2",
      requesterOrigin: {
        channel: "slack",
        to: "C01234567",
        accountId: "workspace",
        threadId: "1721592000.000100",
      },
    });
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));

    await Promise.all([
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId: "slack-run",
          targetSessionKey: "agent:operations:main",
          terminalOutcome: { status: "ok", reason: "completed" },
          result: { payloads: [{ text: "Slack result" }] },
          dispatch,
        },
        options,
      ),
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId: "telegram-run",
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          result: { payloads: [{ text: "Telegram result" }] },
          dispatch,
        },
        options,
      ),
    ]);

    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:slack:channel:ops",
        expectedExistingSessionId: "requester-session-2",
        channel: "slack",
        to: "C01234567",
        accountId: "workspace",
        threadId: "1721592000.000100",
      }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: requesterSessionKey,
        expectedExistingSessionId: requesterSessionId,
        channel: "telegram",
        to: "7504982318",
        accountId: "primary",
        threadId: "42",
      }),
    );
  });

  it("does not dispatch explicitly cancelled or expired registrations", async () => {
    const dispatch = vi.fn(async (_params: Record<string, unknown>) => ({ status: "accepted" }));
    arm();
    disarmSessionsSendDeferredCompletion({ targetRunId }, options);
    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId,
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(false);

    arm({ targetRunId: "expired-run", ttlMs: -1 });
    testing.resetPendingRunIds();
    await expect(
      maybeCompleteSessionsSendDeferred(
        {
          targetRunId: "expired-run",
          targetSessionKey,
          terminalOutcome: { status: "ok", reason: "completed" },
          dispatch,
        },
        options,
      ),
    ).resolves.toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("fails closed when the requester origin is missing or internal", () => {
    expect(() => arm({ requesterOrigin: { channel: "telegram" } })).toThrow(
      "explicit external requester delivery context",
    );
    expect(() =>
      arm({ requesterOrigin: { channel: "sessions_send", to: requesterSessionKey } }),
    ).toThrow("explicit external requester delivery context");
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  claimRestartRecoveryDeliveryContext,
  clearRestartRecoveryDeliveryContext,
  clearRestartRecoveryDeliveryContextsForTest,
  readRestartRecoveryDeliveryContext,
} from "./restart-recovery-delivery-state.js";

afterEach(() => {
  clearRestartRecoveryDeliveryContextsForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("restart recovery delivery state", () => {
  it("claims, reads, updates, and clears delivery contexts by run ownership", () => {
    const base = {
      runId: "run-1",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: "relative-sessions.json",
      updatedAtMs: 100,
    };

    expect(
      claimRestartRecoveryDeliveryContext({
        ...base,
        context: {
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          threadId: 123,
        },
      }),
    ).toBe(true);
    expect(
      readRestartRecoveryDeliveryContext({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: "relative-sessions.json",
      }),
    ).toMatchObject({
      context: {
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        threadId: 123,
      },
      runId: "run-1",
      sessionId: "session-1",
      updatedAtMs: 100,
    });

    expect(
      claimRestartRecoveryDeliveryContext({
        ...base,
        runId: "run-2",
        context: {
          channel: "discord",
          to: "discord:dm:456",
        },
      }),
    ).toBe(false);
    expect(
      readRestartRecoveryDeliveryContext({
        sessionKey: "agent:main:main",
        storePath: "relative-sessions.json",
      }),
    ).toMatchObject({ runId: "run-1", context: { to: "discord:dm:123" } });

    expect(
      claimRestartRecoveryDeliveryContext({
        ...base,
        runId: "run-2",
        replaceExisting: true,
        context: {
          channel: "discord",
          to: "discord:dm:456",
        },
      }),
    ).toBe(true);
    expect(
      readRestartRecoveryDeliveryContext({
        sessionKey: "agent:main:main",
        storePath: "relative-sessions.json",
      }),
    ).toMatchObject({ runId: "run-2", context: { to: "discord:dm:456" } });

    expect(
      claimRestartRecoveryDeliveryContext({
        ...base,
        runId: "run-3",
        sessionId: "session-2",
        updatedAtMs: 150,
        context: {
          channel: "discord",
          to: "discord:dm:456",
        },
      }),
    ).toBe(true);
    expect(
      readRestartRecoveryDeliveryContext({
        sessionKey: "agent:main:main",
        storePath: "relative-sessions.json",
      }),
    ).toMatchObject({ runId: "run-3", sessionId: "session-2" });
    expect(
      clearRestartRecoveryDeliveryContext({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: "relative-sessions.json",
      }),
    ).toBe(false);
    expect(
      readRestartRecoveryDeliveryContext({
        sessionKey: "agent:main:main",
        storePath: "relative-sessions.json",
      }),
    ).toMatchObject({ runId: "run-3", sessionId: "session-2" });

    expect(
      claimRestartRecoveryDeliveryContext({
        ...base,
        runId: "run-3",
        sessionId: "session-2",
        updatedAtMs: 200,
        context: {
          channel: "discord",
          to: "discord:dm:789",
        },
      }),
    ).toBe(true);
    expect(
      clearRestartRecoveryDeliveryContext({
        ...base,
        runId: "run-2",
      }),
    ).toBe(false);
    expect(
      clearRestartRecoveryDeliveryContext({
        ...base,
        runId: "run-3",
        sessionId: "session-2",
      }),
    ).toBe(true);
    expect(
      readRestartRecoveryDeliveryContext({
        sessionKey: "agent:main:main",
        storePath: "relative-sessions.json",
      }),
    ).toBeUndefined();
  });

  it("uses the real session store path as the SQLite key", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-restart-state-"));
    const realSessionsDir = path.join(tmpDir, "state", "agents", "main", "sessions");
    const aliasDir = path.join(tmpDir, "alias-sessions");
    fs.mkdirSync(realSessionsDir, { recursive: true });
    const realStorePath = path.join(realSessionsDir, "sessions.json");
    fs.writeFileSync(realStorePath, "{}");
    fs.symlinkSync(realSessionsDir, aliasDir);
    const aliasStorePath = path.join(aliasDir, "sessions.json");
    try {
      expect(
        claimRestartRecoveryDeliveryContext({
          context: {
            channel: "discord",
            to: "discord:dm:123",
          },
          runId: "run-1",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          storePath: aliasStorePath,
        }),
      ).toBe(true);
      expect(
        readRestartRecoveryDeliveryContext({
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          storePath: realStorePath,
        }),
      ).toMatchObject({
        runId: "run-1",
        context: { to: "discord:dm:123" },
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

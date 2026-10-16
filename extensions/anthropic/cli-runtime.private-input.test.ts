import { writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { CliBackendToolPermissionResult } from "openclaw/plugin-sdk/cli-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import {
  collect,
  createContext,
  createLiveSession,
  fixtureReadyBeforeSettlement,
  useClaudeFixture,
} from "./cli-runtime.test-harness.js";
import { resultDetail } from "./cli-runtime.test-support.js";

useClaudeFixture();

describe("Claude native stdio private-input check", () => {
  it("sends user input only after a fresh private-input check", async ({ signal }) => {
    let loginHolds = true;
    const reason = new Error("Synthetic account reassigned before send.");
    const liveSession = createLiveSession();
    const context = await createContext("revoked-initialize", {
      liveSession,
      // The host's private-input check fails while the run itself stays current.
      assertPrivateInputCurrent: () => {
        if (!loginHolds) {
          throw reason;
        }
      },
    });
    const running = collect(context);
    const outcome = running.catch((error: unknown) => error);
    try {
      await fixtureReadyBeforeSettlement(context, "initialize.ready", running, signal);
      loginHolds = false;
    } finally {
      await writeFile(path.join(context.cwd, "initialize.release"), "release");
    }
    expect(await withinTest(outcome, signal)).toBe(reason);
    await expect(access(path.join(context.cwd, "user.received"))).rejects.toThrow();
  });

  it("withholds private turn context when the private-input check fails after the prompt was sent", async () => {
    let checks = 0;
    const context = await createContext("normal", {
      prompt: "Remember orange.",
      promptContext: { prependContext: "saved private context" },
      // The first check guards the prompt send; the login changes from there on.
      assertPrivateInputCurrent: () => {
        if (++checks > 1) {
          throw new Error("Synthetic account reassigned after send.");
        }
      },
    });
    const detail = resultDetail(await collect(context));
    expect(detail).toMatchObject({ turn: 1, user: "Remember orange." });
    expect(detail.privateContext).toBeUndefined();
  });

  it("keeps an awaited tool hook decision independent of the private-input check", async () => {
    let loginHolds = true;
    const approvalStarted = createDeferred<void>();
    const approval = createDeferred<CliBackendToolPermissionResult>();
    const context = await createContext("revoked-approval", {
      assertPrivateInputCurrent: () => {
        if (!loginHolds) {
          throw new Error("A tool hook decision carries no saved turn context.");
        }
      },
      requestToolPermission: () => {
        approvalStarted.resolve();
        return approval.promise;
      },
    });
    const running = collect(context);
    await approvalStarted.promise;
    loginHolds = false;
    approval.resolve({ behavior: "allow", updatedInput: { file_path: "approved.txt" } });
    const detail = resultDetail(await running);
    expect(detail.hookDecision).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
  });
});

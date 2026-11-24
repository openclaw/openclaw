import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import {
  readSessionEventTargetCommandOwner,
  readSessionEventTargetOwnerContinuation,
} from "../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTestOperatorAuthority } from "./admitted-run-context.test-support.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { prepareExecExitNotification } from "./bash-tools.exec-notify.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

it.each([
  ["456", true],
  ["789", false],
] as const)(
  "retains requester %s's owner authority for its completion: %s",
  async (senderId, owner) => {
    await withOpenClawTestState({ label: "exec-live-owner" }, async (state) => {
      const sessionKey = "agent:main:exec-owner";
      setRuntimeConfigSnapshot({
        agents: { entries: { main: {} } },
        channels: { telegram: {} },
        commands: { ownerAllowFrom: ["456"] },
      });
      openOpenClawStateDatabase({ env: state.env });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      writeSessionEntry(database, sessionKey, {
        sessionId: "exec-owner",
        updatedAt: Date.now(),
        permissionMode: "full",
      });
      const process = createProcessSessionFixture({ id: "exec-owner", backgrounded: true });
      Object.assign(process, {
        agentId: "main",
        sessionKey,
        notifyOnExit: true,
        notifyOnExitEmptySuccess: true,
        exitCode: 0,
      });
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey,
          requesterOrigin: { sessionKey, messageProvider: "telegram", senderId },
        },
        () => prepareExecExitNotification(process, false, false),
      );
      const target = expectDefined(process.notifySessionTarget, "exec completion destination");
      expect(readSessionEventTargetCommandOwner(target)?.requester.senderId).toBe(
        owner ? senderId : undefined,
      );
      expect(readSessionEventTargetOwnerContinuation(target)).toBe(false);
    });
  },
);

it("preserves ownerContinuation when caller holds operatorAuthority", async () => {
  await withOpenClawTestState({ label: "exec-owner-continuation" }, async (state) => {
    const sessionKey = "agent:main:main";
    setRuntimeConfigSnapshot({
      agents: { entries: { main: {} } },
    });
    openOpenClawStateDatabase({ env: state.env });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    writeSessionEntry(database, sessionKey, {
      sessionId: "exec-owner-continuation",
      updatedAt: Date.now(),
      permissionMode: "full",
    });
    const process = createProcessSessionFixture({ id: "exec-owner-cont", backgrounded: true });
    Object.assign(process, {
      agentId: "main",
      sessionKey,
      notifyOnExit: true,
      notifyOnExitEmptySuccess: true,
      exitCode: 0,
    });
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        operatorAuthority: createTestOperatorAuthority({
          profileId: "gateway-owner",
          scopes: ["operator.admin"],
        }),
      },
      () => prepareExecExitNotification(process, false, false),
    );
    const target = expectDefined(process.notifySessionTarget, "exec completion destination");
    expect(readSessionEventTargetOwnerContinuation(target)).toBe(true);
  });
});

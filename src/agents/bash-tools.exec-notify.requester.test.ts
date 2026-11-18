import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { captureCommandOwnerAssertion } from "../auto-reply/command-owner-authority.js";
import { buildSessionEventContext } from "../auto-reply/reply/session-event-context.js";
import {
  readSessionEventTargetOwnerContinuation,
  readSessionEventTargetCommandOwner,
} from "../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
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
      const ctx = buildSessionEventContext({
        cfg: { agents: { entries: { main: {} } } },
        agentId: "main",
        sessionKey,
        text: "channel completion",
        options: { source: "exec" },
        target,
        occurrenceId: "channel",
        assertCurrent() {},
      });
      const assertion = captureCommandOwnerAssertion(ctx);
      expect(Boolean(assertion)).toBe(owner);
      target.sessionId = "reset-channel";
      expect(readSessionEventTargetCommandOwner(target)).toBeUndefined();
      if (owner) {
        expect(() => assertion?.()).toThrow("authority changed");
      }
    });
  },
);

it.each([
  [true, true],
  [false, true],
  [true, false],
] as const)(
  "exec completion preserves the owner decision %s only in the same session %s",
  async (owner, sameSession) => {
    await withOpenClawTestState({ label: "exec-operator-owner" }, async (state) => {
      const sessionKey = "agent:main:exec-operator";
      setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
      openOpenClawStateDatabase({ env: state.env });
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      writeSessionEntry(database, sessionKey, {
        sessionId: "exec-operator",
        updatedAt: Date.now(),
      });
      const authority = createAdmittedRunOperatorAuthority({
        profileId: "owner",
        scopes: ["operator.admin"],
        assertCurrent() {},
      });
      const process = createProcessSessionFixture({ id: "exec-operator", backgrounded: true });
      Object.assign(process, { agentId: "main", sessionKey, notifyOnExit: true });
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: sameSession ? sessionKey : "agent:main:other",
          operatorAuthority: authority,
        },
        () => prepareExecExitNotification(process, false, false, owner),
      );
      const target = expectDefined(process.notifySessionTarget, "exec completion destination");
      expect(readSessionEventTargetOwnerContinuation(target)).toBe(owner && sameSession);
      for (const source of ["exec", "hook"] as const) {
        const ctx = buildSessionEventContext({
          cfg: { agents: { entries: { main: {} } } },
          agentId: "main",
          sessionKey,
          text: "untrusted output",
          options: { source },
          target,
          occurrenceId: "exec-test",
          assertCurrent() {},
        });
        expect(Boolean(captureCommandOwnerAssertion(ctx))).toBe(
          owner && sameSession && source === "exec",
        );
      }
      let adoptedSessionId = target.sessionId;
      const queuedContext = buildSessionEventContext({
        cfg: { agents: { entries: { main: {} } } },
        agentId: "main",
        sessionKey,
        text: "queued completion",
        options: { source: "exec" },
        target,
        occurrenceId: "queued",
        readSessionId: () => adoptedSessionId,
        assertCurrent() {},
      });
      const queuedOwner = captureCommandOwnerAssertion(queuedContext);
      adoptedSessionId = "reset-transcript";
      if (owner && sameSession) {
        expect(() => queuedOwner?.()).toThrow("authority changed");
      }
      target.sessionId = "reset-transcript";
      if (owner && sameSession) {
        expect(() => queuedOwner?.()).toThrow("authority changed");
      }
      expect(readSessionEventTargetOwnerContinuation(target)).toBe(false);
    });
  },
);

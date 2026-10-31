import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import {
  hasSessionEventOriginatingCaller,
  readSessionEventTargetCommandOwner,
  readSessionEventTargetOperatorAuthority,
} from "../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareAdoptedDurableProcessNotification } from "./bash-process-durable-notify.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

it("adopts completion as host input and observes current notification policy", async () => {
  await withOpenClawTestState({ label: "durable-exec-principal" }, async (state) => {
    const sessionKey = "agent:main:durable-exec";
    const cfg = {
      agents: { entries: { main: {} } },
      commands: { ownerAllowFrom: ["456"] },
    };
    setRuntimeConfigSnapshot(cfg);
    openOpenClawStateDatabase({ env: state.env });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    writeSessionEntry(database, sessionKey, {
      sessionId: "durable-exec",
      updatedAt: Date.now(),
      permissionMode: "full",
    });
    const process = createProcessSessionFixture({ id: "durable-exec", backgrounded: true });
    Object.assign(process, { agentId: "main", sessionKey, notifyOnExit: true });
    await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey,
        requesterOrigin: { sessionKey, messageProvider: "telegram", senderId: "456" },
      },
      () => prepareAdoptedDurableProcessNotification(process, "durable-exec"),
    );
    const target = expectDefined(process.notifySessionTarget, "adopted completion target");
    expect(target.sessionId).toBe("durable-exec");
    expect(hasSessionEventOriginatingCaller(target)).toBe(false);
    expect(readSessionEventTargetCommandOwner(target)).toBeUndefined();
    expect(readSessionEventTargetOperatorAuthority(target)).toBeUndefined();
    setRuntimeConfigSnapshot({ ...cfg, tools: { exec: { notifyOnExit: false } } });
    expect(() => target.assertCurrent?.()).toThrow("notifications are disabled");
  });
});

it("suppresses adopted wakes for retired and ineligible sessions", async () => {
  await withOpenClawTestState({ label: "durable-exec-eligibility" }, async (state) => {
    setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
    openOpenClawStateDatabase({ env: state.env });
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    for (const [kind, extra] of [
      ["reset", { sessionId: "replacement" }],
      ["archived", { archivedAt: 1 }],
      ["dashboard:spawned", { spawnDepth: 1, spawnedBy: "agent:main:main" }],
      ["cron:job:run:ended", {}],
      ["subagent:child", {}],
    ] as const) {
      const sessionKey = `agent:main:${kind}`;
      writeSessionEntry(database, sessionKey, {
        sessionId: "original",
        updatedAt: Date.now(),
        ...extra,
      });
      const process = createProcessSessionFixture({ id: kind, backgrounded: true });
      Object.assign(process, { agentId: "main", sessionKey, notifyOnExit: true });
      await prepareAdoptedDurableProcessNotification(process, "original");
      expect(process.notifySessionTarget, kind).toBeUndefined();
      expect(process.notifyOnExit, kind).toBe(false);
    }
  });
});

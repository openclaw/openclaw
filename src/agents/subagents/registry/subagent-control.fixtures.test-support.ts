import { expect } from "vitest";
import { loadExactSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  getActiveSessionWorkAdmissionCount,
} from "../../../sessions/session-lifecycle-admission.js";
import { enqueueSwarmRun } from "../swarm/swarm-scheduler.js";
import { registerSubagentRun } from "./subagent-registry.js";
import { writeSubagentSessionEntry } from "./subagent-registry.persistence.test-support.js";

export const controlSessionKey = (id: string) => `agent:main:subagent:${id}`;
export const controlController = {
  controllerSessionKey: "agent:main:main",
  controllerAgentId: "main",
  callerSessionKey: "agent:main:main",
  callerIsSubagent: false,
  controlScope: "children" as const,
};
type RunOptions = Partial<Parameters<typeof registerSubagentRun>[0]>;
type SessionOptions = { sessionKey?: string; agentId?: string; defaultSessionId?: string };

export function createControlRunFixture(stateDir: () => string) {
  const targetFor = (id: string, options: SessionOptions = {}) => ({
    agentId: options.agentId ?? "main",
    sessionKey: options.sessionKey ?? controlSessionKey(id),
    defaultSessionId: options.defaultSessionId ?? `${id}-session`,
  });
  const writeSession = (id: string, lifecycleRevision?: string, options?: SessionOptions) =>
    writeSubagentSessionEntry({
      stateDir: stateDir(),
      ...targetFor(id, options),
      lifecycleRevision,
    });
  const register = (
    id: string,
    storePath: string | undefined,
    options: RunOptions = {},
    registrationOptions?: Parameters<typeof registerSubagentRun>[1],
  ) => {
    const sessionKey = options.childSessionKey ?? controlSessionKey(id);
    const agentId = options.childAgentId ?? "main";
    return registerSubagentRun(
      {
        runId: id,
        childSessionKey: sessionKey,
        childAgentId: agentId,
        sessionEntry:
          "sessionEntry" in options
            ? options.sessionEntry
            : loadExactSessionEntryReadOnly({ agentId, storePath, sessionKey })?.entry,
        requesterSessionKey: "agent:main:main",
        requesterAgentId: "main",
        requesterDisplayKey: "main",
        task: id,
        cleanup: "keep",
        expectsCompletionMessage: false,
        ...options,
      },
      registrationOptions,
    );
  };
  const seed = async (
    id: string,
    options: RunOptions = {},
    lifecycleRevision = `${id}-session-revision`,
  ) => {
    const target = targetFor(id, {
      sessionKey: options.childSessionKey,
      agentId: options.childAgentId,
    });
    const storePath = await writeSession(id, lifecycleRevision, target);
    await register(id, storePath, options);
    return {
      ...target,
      storePath,
      sessionId: target.defaultSessionId,
      runId: options.runId ?? id,
      target: { stateDir: stateDir(), ...target, lifecycleRevision },
    };
  };
  return { writeSession, register, seed };
}

export function beginControlAdmission(
  scope: string,
  sessionKey: string,
  sessionId: string,
  onInterrupt?: Parameters<typeof beginSessionWorkAdmission>[0]["onInterrupt"],
) {
  return beginSessionWorkAdmission({
    scope,
    identities: [sessionKey, sessionId],
    assertAllowed: () => {},
    onInterrupt,
  });
}

export function expectControlIdle() {
  expect(getActiveSessionWorkAdmissionCount()).toBe(0);
  expect(getActiveSessionLifecycleMutationCount()).toBe(0);
}

type QueueOptions = Parameters<typeof enqueueSwarmRun>[0];
export function enqueueControlRun(
  groupId: string,
  runId: string,
  activeRunIds: QueueOptions["activeRunIds"],
  start: QueueOptions["start"],
  options: Partial<QueueOptions> = {},
) {
  enqueueSwarmRun({
    groupId,
    runId,
    activeRunIds,
    start,
    maxConcurrent: 1,
    onStartFailure: () => true,
    ...options,
  });
}

import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { agentSessionAutomaticCompaction } from "../sessions/agent-session-compaction.js";
import { useCompactHooksSessionFixture } from "./compact.hooks.fixture.test-support.js";
import { createAgentSessionMock, loadCompactHooksHarness } from "./compact.hooks.harness.js";

const sessionKey = "agent:main:recovery-identity";
const fixture = useCompactHooksSessionFixture(sessionKey);
let compact: Awaited<
  ReturnType<typeof loadCompactHooksHarness>
>["compactEmbeddedAgentSessionDirect"];
let configRuntime: typeof import("../../config/runtime-snapshot.js");
let storePath: string;
let prepared: Awaited<ReturnType<typeof fixture.prepareSession>>;

beforeAll(async () => {
  compact = (await loadCompactHooksHarness()).compactEmbeddedAgentSessionDirect;
  configRuntime = await import("../../config/runtime-snapshot.js");
  storePath = await fixture.prepare();
});
beforeEach(async () => {
  configRuntime.setRuntimeConfigSnapshot({});
  prepared = await fixture.prepareSession();
});

afterEach(() => configRuntime.clearRuntimeConfigSnapshot());

it("persists recovery compaction under the identity its progress announced", async () => {
  await compact({
    agentId: "main",
    sessionId: prepared.sessionId,
    sessionKey,
    sessionFile: sessionKey,
    sessionTarget: { agentId: "main", sessionId: prepared.sessionId, sessionKey, storePath },
    workspaceDir: prepared.workspaceDir,
    trigger: "overflow",
    diagId: "ovf-host-progress",
  });

  const { session } = await createAgentSessionMock.mock.results[0]!.value;
  expect(session[agentSessionAutomaticCompaction]).toHaveBeenCalledOnce();
  expect(session[agentSessionAutomaticCompaction].mock.calls[0]?.[3]).toMatchObject({
    itemId: "ovf-host-progress",
  });
});

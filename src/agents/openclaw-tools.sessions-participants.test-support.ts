import path from "node:path";
import { afterAll, expect, it, type Mock } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listSessionParticipantsReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

export function registerSessionsSendParticipantTests({
  config,
  callGatewayMock,
}: {
  config: OpenClawConfig;
  callGatewayMock: Mock;
}) {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-send-participant-");
  it("does not record a cross-agent contribution when admission fails", async () => {
    const storeTemplate = path.join(
      sessionDirs.make(),
      "agents/{agentId}/agent/openclaw-agent.sqlite",
    );
    const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "research" });
    const scope = { agentId: "research", sessionKey: "agent:research:main", storePath };
    const sessionId = "participant-target";
    await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.resolve") {
        return { key: scope.sessionKey, agentId: scope.agentId };
      }
      if (request.method === "agent") {
        throw new Error("admission rejected");
      }
      return { messages: [] };
    });
    const tool = createSessionsSendTool({
      agentSessionKey: "agent:main:main",
      expectedTargetSessionId: sessionId,
      config: { ...config, session: { ...config.session, store: storeTemplate } },
      callGateway: callGatewayMock,
    });
    const result = await tool.execute("participant-send", {
      sessionKey: scope.sessionKey,
      message: "Review this input",
      timeoutSeconds: 0,
    });
    expect(result.details).toMatchObject({ status: "error", error: "admission rejected" });
    await runOpenClawAgentWriteAdmission(
      toDatabaseOptions(resolveSqliteScope(scope)),
      () => undefined,
    );
    expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? []).toEqual([]);
  });
}

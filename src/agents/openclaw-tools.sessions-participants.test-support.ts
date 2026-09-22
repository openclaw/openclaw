import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
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
import { disposeOpenClawAgentDatabaseByPath } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

export function registerSessionsSendParticipantTests({
  config,
  makeTempDir,
  callGatewayMock,
}: {
  config: OpenClawConfig;
  makeTempDir: (prefix: string) => string;
  callGatewayMock: Mock;
}) {
  it.each([
    { timeoutSeconds: 0, admitted: true },
    { timeoutSeconds: 1, admitted: true },
    { timeoutSeconds: 0, admitted: false },
    { timeoutSeconds: 1, admitted: false },
  ])(
    "records exactly one cross-agent contribution at the original prompt time only after admission (timeoutSeconds: $timeoutSeconds, admitted: $admitted)",
    async ({ timeoutSeconds, admitted }) => {
      const storeTemplate = path.join(
        makeTempDir("openclaw-session-send-participant-"),
        "agents/{agentId}/agent/openclaw-agent.sqlite",
      );
      const storePath = resolveSessionStorePathCore(storeTemplate, { agentId: "research" });
      const scope = { agentId: "research", sessionKey: "agent:research:main", storePath };
      const sessionId = "participant-target";
      const promptedAt = 1_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(promptedAt);
      try {
        await upsertSessionEntryCore(scope, { sessionId, updatedAt: 1 });
        callGatewayMock.mockImplementation(async (opts: unknown) => {
          const request = opts as { method?: string };
          if (request.method === "sessions.resolve") {
            return { key: scope.sessionKey, agentId: scope.agentId };
          }
          if (request.method === "agent") {
            clock.mockReturnValue(promptedAt + 100);
            if (!admitted) {
              throw new Error("admission rejected");
            }
            return { runId: "participant-run", status: "accepted" };
          }
          if (request.method === "agent.wait") {
            return { status: "ok" };
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
          timeoutSeconds,
        });
        expect(result.details).toMatchObject(
          admitted
            ? { status: timeoutSeconds === 0 ? "accepted" : "no_reply", runId: "participant-run" }
            : { status: "error", error: "admission rejected" },
        );
        await runOpenClawAgentWriteAdmission(
          toDatabaseOptions(resolveSqliteScope(scope)),
          () => undefined,
        );
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey) ?? []).toEqual(
          admitted
            ? [
                {
                  identity: { type: "agent", id: "main" },
                  contributionCount: 1,
                  firstPromptedAt: promptedAt,
                  lastPromptedAt: promptedAt,
                },
              ]
            : [],
        );
      } finally {
        clock.mockRestore();
        disposeOpenClawAgentDatabaseByPath(storePath);
      }
    },
  );
}

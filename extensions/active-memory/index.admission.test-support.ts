import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";

type AdmissionFixture = {
  api: Pick<OpenClawPluginApi, "runtime">;
  hoisted: { getActiveMemorySearchManager: unknown; updateSessionStore: unknown };
  runEmbeddedAgent: unknown;
  runPromptBuild: (
    event: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
  seedSession: (sessionKey: string, sessionId: string) => void;
  getActiveMemoryLines: (sessionKey: string) => string[];
  hasInfoLine: (needle: string) => boolean;
  expectPrependContextContains: (result: unknown, text: string) => void;
};

export function registerAdmissionTests({
  api,
  hoisted,
  runEmbeddedAgent,
  runPromptBuild,
  seedSession,
  getActiveMemoryLines,
  hasInfoLine,
  expectPrependContextContains,
}: AdmissionFixture) {
  it("does not read or inject memory when the turn authority denies recall tools", async () => {
    const assertActive = vi.fn();

    const result = await runPromptBuild(
      { prompt: "what wings should i order?" },
      {
        toolAuthority: {
          fingerprint: "denied-memory-authority",
          allows: () => false,
          assertActive,
        },
      },
    );

    expect(result).toBeUndefined();
    expect(assertActive).toHaveBeenCalled();
    expect(hoisted.getActiveMemorySearchManager).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(hasInfoLine("active-memory: recall skipped reason=policy-disabled")).toBe(true);
  });

  it.each([
    { identity: "key", recallAllowed: true },
    { identity: "session-id", recallAllowed: true },
    { identity: "key", recallAllowed: false },
    { identity: "session-id", recallAllowed: false },
  ])(
    "skips Incognito $identity recall before state writes with recallAllowed=$recallAllowed",
    async ({ identity, recallAllowed }) => {
      const sessionKey = "agent:main:dashboard:incognito-recall";
      seedSession(sessionKey, "incognito-source");
      const openKeyedStore = vi.spyOn(api.runtime.state, "openKeyedStore");

      const result = await runPromptBuild(
        { prompt: "SYNTHETIC_PRIVATE_RECALL_PROMPT" },
        {
          ...(identity === "key" ? { sessionKey } : { sessionId: "incognito-source" }),
          toolAuthority: {
            fingerprint: "incognito-memory-authority",
            allows: () => recallAllowed,
            assertActive: vi.fn(),
          },
        },
      );

      expect(result).toBeUndefined();
      expect(openKeyedStore).not.toHaveBeenCalled();
      expect(hoisted.updateSessionStore).not.toHaveBeenCalled();
      expect(hoisted.getActiveMemorySearchManager).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(getActiveMemoryLines(sessionKey)).toEqual([]);
    },
  );

  it("skips recall when canonical identity lookup fails", async () => {
    seedSession("agent:main:dashboard:incognito-recall", "incognito-source");
    vi.spyOn(api.runtime.agent.session, "listSessionEntries").mockImplementation(() => {
      throw new Error("synthetic session-store read failure");
    });
    const openKeyedStore = vi.spyOn(api.runtime.state, "openKeyedStore");

    const result = await runPromptBuild(
      { prompt: "SYNTHETIC_PRIVATE_RECALL_PROMPT" },
      { sessionId: "incognito-source" },
    );

    expect(result).toBeUndefined();
    expect(openKeyedStore).not.toHaveBeenCalled();
    expect(hoisted.updateSessionStore).not.toHaveBeenCalled();
    expect(hoisted.getActiveMemorySearchManager).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("skips recall for inter-session deliveries that reuse the user trigger", async () => {
    const result = await runPromptBuild(
      {
        prompt:
          "[Inter-session message] sourceSession=agent:main:other sourceTool=sessions_send isUser=false\nHandoff payload",
      },
      {
        inputProvenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:other",
          sourceTool: "sessions_send",
        },
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(hoisted.getActiveMemorySearchManager).not.toHaveBeenCalled();
    expect(hasInfoLine("active-memory: recall skipped reason=session-ineligible")).toBe(true);
  });

  it("skips recall for subagent settlement deliveries into a visible session", async () => {
    const result = await runPromptBuild(
      { prompt: "[Subagent Context] subagent_settle\nTask finished" },
      {
        inputProvenance: {
          kind: "inter_session",
          sourceTool: "subagent_settle",
        },
      },
    );

    expect(result).toBeUndefined();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(hasInfoLine("active-memory: recall skipped reason=session-ineligible")).toBe(true);
  });

  it("still recalls for external-user provenance", async () => {
    const result = await runPromptBuild(
      { prompt: "what wings should i order?" },
      { inputProvenance: { kind: "external_user" } },
    );

    expectPrependContextContains(result, "lemon pepper wings");
  });
}

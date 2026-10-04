import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi, type Mock } from "vitest";

type DiagnosticTestParams = {
  logger: OpenClawPluginApi["logger"];
  getActiveMemorySearchManager: Mock;
  runPromptBuild: (
    event: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
  runActiveMemoryCommand: (params: Record<string, unknown>) => Promise<{ text?: string }>;
  configure: (logging: boolean) => void;
  expectPrependContextContains: (result: unknown, text: string) => void;
};

/** Registers trigger-recall diagnostics against the shared plugin hook fixture. */
export function registerActiveMemoryDiagnosticTests(params: DiagnosticTestParams): void {
  it.each([true, false])(
    "reports an unconfigured trigger-recall agent (logging=%s)",
    async (logging) => {
      params.configure(logging);
      const result = await params.runPromptBuild({ prompt: "What do I usually order?" });
      expect(result).toBeUndefined();
      const line = "active-memory: lane-1 skipped reason=agent-not-configured agent=main";
      expect(params.logger.debug).toHaveBeenCalledWith(line);
      if (logging) {
        expect(params.logger.info).toHaveBeenCalledWith(line);
      } else {
        expect(params.logger.info).not.toHaveBeenCalledWith(line);
      }
      expect(params.getActiveMemorySearchManager).not.toHaveBeenCalled();
      const status = await params.runActiveMemoryCommand({
        sessionKey: "agent:main:main",
        args: "status",
      });
      expect(status.text).toContain("Trigger recall: off for agent main.");
      expect(status.text).toContain("Remember across conversations: on.");
    },
  );

  it("logs deterministic trigger injections when invocation logging is enabled", async () => {
    params.getActiveMemorySearchManager.mockResolvedValueOnce({
      manager: {
        search: vi.fn(async () => []),
        listTriggerCandidates: vi.fn(async () => [
          {
            path: "MEMORY.md",
            startLine: 1,
            endLine: 1,
            score: 1,
            snippet: "Prefer aisle seats.",
            source: "memory" as const,
            provenance: {
              originClass: "agent" as const,
              sessionKind: "interactive" as const,
              observedAt: 1,
            },
            triggers: "booking a flight",
          },
        ]),
      },
    } as never);

    const result = await params.runPromptBuild(
      { prompt: "Help when booking a flight" },
      {
        sessionKey: "agent:main:telegram:direct:owner",
        messageProvider: "telegram",
        channelId: "owner",
      },
    );

    params.expectPrependContextContains(result, "Prefer aisle seats.");
    expect(
      vi
        .mocked(params.logger.info)
        .mock.calls.some(
          (call: unknown[]) =>
            String(call[0]) === "active-memory: lane-1 injected 1 trigger-matched entries",
        ),
    ).toBe(true);
  });
}

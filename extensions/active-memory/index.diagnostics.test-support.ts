import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, type Mock } from "vitest";

type DiagnosticTestParams = {
  logger: OpenClawPluginApi["logger"];
  getActiveMemorySearchManager: Mock;
  runPromptBuild: (
    event: Record<string, unknown>,
    context?: Record<string, unknown>,
  ) => Promise<unknown>;
  runActiveMemoryCommand: (params: Record<string, unknown>) => Promise<{ text?: string }>;
  configure: (logging: boolean, remember?: boolean) => void;
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
      expect(status.text).toContain("Active Memory: on for this session.");
      expect(status.text).toContain("Trigger recall configuration: off for agent main.");
      expect(status.text).toContain("Remember across conversations setting: on.");
      await params.runActiveMemoryCommand({ sessionKey: "agent:main:main", args: "off" });
      const paused = await params.runActiveMemoryCommand({ sessionKey: "agent:main:main" });
      expect(paused.text).toContain("Active Memory: off for this session.");
      expect(paused.text).toContain("Remember across conversations setting: on.");
    },
  );

  it("reports session status off when the current agent is outside the active-memory allowlist (#78986)", async () => {
    params.configure(true, false);
    const status = await params.runActiveMemoryCommand({ sessionKey: "agent:main:main" });
    expect(status.text).toBe("Active Memory: off for this session.");
  });
}

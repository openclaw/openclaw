import { describe, expect, it, vi } from "vitest";
import { teamsMeetingsPlugin } from "../index.js";

const URL = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_probe%40thread.v2/0";
type TeamsMeetingsProbeContext = Parameters<typeof teamsMeetingsPlugin.probes.testListening>[0];

describe.each(["chrome", "chrome-node"] as const)(
  "Microsoft Teams %s runtime probes",
  (transport) => {
    it.each([
      ["waits when Chrome launched without a tracked target", true, undefined, 1],
      ["waits for a reused manually opened tab", false, "teams-manual-tab", 1],
      ["does not wait without a launched browser or tracked tab", false, undefined, 0],
    ] as const)("%s", async (_name, launched, targetId, refreshCalls) => {
      const session = {
        agentId: "main",
        chrome: {
          health: { inCall: true },
          launched,
          ...(targetId ? { browserTab: { targetId, openedByPlugin: false } } : {}),
        },
        id: "teams-listen",
        mode: "transcribe",
        transport,
      } as ReturnType<TeamsMeetingsProbeContext["list"]>[number];
      const refreshCaptionHealth = vi.fn(async () => {
        session.chrome!.health = {
          ...session.chrome!.health,
          manualAction: { reason: "teams-admission-required", message: "Waiting" },
        };
      });
      const context = {
        config: teamsMeetingsPlugin.config.resolveConfig({}),
        hasHealthHandle: () => false,
        isReusable: () => false,
        join: vi.fn(async () => ({ session, spoken: false })),
        list: () => [],
        refreshCaptionHealth,
        refreshHealth: () => {},
        resolveAgentId: () => "main",
      } satisfies TeamsMeetingsProbeContext;

      const result = await teamsMeetingsPlugin.probes.testListening(context, {
        mode: "transcribe",
        timeoutMs: 100,
        url: URL,
      });

      expect(refreshCaptionHealth).toHaveBeenCalledTimes(refreshCalls);
      expect(result.manualAction).toEqual(
        refreshCalls ? { reason: "teams-admission-required", message: "Waiting" } : undefined,
      );
      expect(result.listenTimedOut).toBe(false);
    });
  },
);

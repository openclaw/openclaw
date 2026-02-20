import { vi } from "vitest";

vi.mock("./accounts.js", () => ({
  resolveBlueBubblesAccount: vi.fn(
    (params: {
      cfg?: { channels?: { bluebubbles?: Record<string, unknown> } };
      accountId?: string;
    }) => {
      const config = params.cfg?.channels?.bluebubbles ?? {};
      return {
        accountId: params.accountId ?? "default",
        enabled: config.enabled !== false,
        configured: Boolean(config.serverUrl && config.password),
        config,
      };
    },
  ),
}));

vi.mock("./probe.js", () => ({
  getCachedBlueBubblesPrivateApiStatus: vi.fn().mockReturnValue(null),
}));

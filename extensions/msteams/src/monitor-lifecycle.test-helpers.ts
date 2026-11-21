import { vi } from "vitest";
import type { OpenClawConfig, RuntimeEnv } from "../runtime-api.js";

// mock-isolation: Keep conversation state outside the monitor lifecycle and SSO fixtures.
vi.mock("./conversation-store-state.js", () => ({
  createMSTeamsConversationStoreState: () => ({}),
}));
vi.mock("./polls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./polls.js")>()),
  createMSTeamsPollStoreState: vi.fn(() => ({})),
}));

export function createConfig(): OpenClawConfig {
  return {
    channels: {
      msteams: {
        enabled: true,
        appId: "app-id",
        appPassword: "app-password", // pragma: allowlist secret
        tenantId: "tenant-id",
        legacyWebhook: false,
        webhook: {
          path: "/api/messages",
        },
      },
    },
  } as OpenClawConfig;
}

export function updateMSTeamsConfig(
  cfg: OpenClawConfig,
  patch: NonNullable<NonNullable<OpenClawConfig["channels"]>["msteams"]>,
): void {
  const msteams = cfg.channels?.msteams;
  if (!cfg.channels || !msteams) {
    throw new Error("Expected Microsoft Teams config fixture");
  }
  cfg.channels.msteams = {
    ...msteams,
    ...patch,
  };
}

export function createRuntime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
}

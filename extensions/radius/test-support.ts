import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import { vi } from "vitest";

export const devicePayload = {
  device_code: "device-secret",
  user_code: "ABCD-EFGH",
  verification_uri: "https://radius.earendil.com/device",
  expires_in: 120,
  interval: 1,
};
export const tokenPayload = {
  access_token: "access-test",
  refresh_token: "refresh-test",
  expires_in: 3600,
};

export function authContext(overrides: Partial<ProviderAuthContext> = {}) {
  const progress = { update: vi.fn(), stop: vi.fn() };
  const unexpectedPrompt = async () => {
    throw new Error("Radius sign-in must not ask for text or selection");
  };
  const ctx: ProviderAuthContext = {
    config: {},
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: {
      intro: vi.fn(async () => {}),
      outro: vi.fn(async () => {}),
      note: vi.fn(async () => {}),
      select: unexpectedPrompt,
      multiselect: unexpectedPrompt,
      text: unexpectedPrompt,
      confirm: unexpectedPrompt,
      progress: vi.fn(() => progress),
    },
    isRemote: false,
    openUrl: vi.fn(async () => {}),
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Radius sign-in must use its device grant");
      },
    },
    ...overrides,
  };
  return { ctx, progress };
}

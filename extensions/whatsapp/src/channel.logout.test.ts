// Whatsapp tests cover channel logout plugin behavior.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";
import {
  clearWebAuthLoggedOut,
  isWebAuthLoggedOut,
  markWebAuthLoggedOut,
} from "./web-auth-terminal-state.js";

const hoisted = vi.hoisted(() => ({
  logoutWeb: vi.fn(async () => true),
}));

vi.mock("./channel.runtime.js", () => ({
  logoutWeb: hoisted.logoutWeb,
}));

describe("WhatsApp channel logout", () => {
  beforeEach(() => {
    hoisted.logoutWeb.mockClear();
    clearWebAuthLoggedOut("work");
  });

  afterEach(() => {
    clearWebAuthLoggedOut("work");
  });

  it("clears terminal logged-out state after explicit logout", async () => {
    markWebAuthLoggedOut("work");

    const result = await whatsappPlugin.gateway?.logoutAccount?.({
      cfg: { channels: { whatsapp: {} } },
      accountId: "work",
      account: {
        accountId: "work",
        authDir: "/tmp/openclaw-whatsapp-work",
        enabled: true,
        isLegacyAuthDir: false,
        sendReadReceipts: false,
      },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as RuntimeEnv,
    });

    expect(result).toEqual({ cleared: true, loggedOut: true });
    expect(hoisted.logoutWeb).toHaveBeenCalledWith({
      authDir: "/tmp/openclaw-whatsapp-work",
      isLegacyAuthDir: false,
      runtime: expect.anything(),
    });
    expect(isWebAuthLoggedOut("work")).toBe(false);
  });

  it("keeps terminal logged-out state when logout leaves auth in place", async () => {
    hoisted.logoutWeb.mockResolvedValueOnce(false);
    markWebAuthLoggedOut("work");

    const result = await whatsappPlugin.gateway?.logoutAccount?.({
      cfg: { channels: { whatsapp: {} } },
      accountId: "work",
      account: {
        accountId: "work",
        authDir: "/tmp/openclaw-whatsapp-work",
        enabled: true,
        isLegacyAuthDir: false,
        sendReadReceipts: false,
      },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as RuntimeEnv,
    });

    expect(result).toEqual({ cleared: false, loggedOut: false });
    expect(isWebAuthLoggedOut("work")).toBe(true);
  });
});

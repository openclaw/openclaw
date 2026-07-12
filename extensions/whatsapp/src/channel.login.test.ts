// Whatsapp tests cover the public channel login adapter.
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";

const hoisted = vi.hoisted(() => ({
  createClackPrompter: vi.fn(() => ({ kind: "clack-prompter" })),
  runWhatsAppLogin: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/setup-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/setup-runtime")>(
    "openclaw/plugin-sdk/setup-runtime",
  );
  return {
    ...actual,
    createClackPrompter: hoisted.createClackPrompter,
  };
});

vi.mock("./login-flow.js", () => ({
  runWhatsAppLogin: hoisted.runWhatsAppLogin,
}));

describe("WhatsApp channel login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes the public auth callback through the channel runtime login flow", async () => {
    const login = whatsappPlugin.auth?.login;
    if (!login) {
      throw new Error("WhatsApp auth.login unavailable");
    }
    const runtime = createNonExitingRuntimeEnv();

    await login({
      cfg: {},
      accountId: " work ",
      runtime,
      verbose: true,
    });

    expect(hoisted.createClackPrompter).toHaveBeenCalledOnce();
    expect(hoisted.runWhatsAppLogin).toHaveBeenCalledWith({
      accountId: "work",
      prompter: { kind: "clack-prompter" },
      runtime,
      verbose: true,
    });
  });
});

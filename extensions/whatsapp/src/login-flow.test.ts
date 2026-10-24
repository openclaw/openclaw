// Whatsapp tests cover the public interactive login path.
import {
  createNonExitingRuntimeEnv,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { whatsappPlugin } from "./channel.js";

const hoisted = vi.hoisted(() => ({
  createClackPrompter: vi.fn<() => WizardPrompter>(),
  loginWeb: vi.fn(async () => {}),
  loginWebWithPhoneCode: vi.fn(async () => {}),
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

vi.mock("./login.js", async () => {
  const actual = await vi.importActual<typeof import("./login.js")>("./login.js");
  return {
    ...actual,
    loginWeb: hoisted.loginWeb,
    loginWebWithPhoneCode: hoisted.loginWebWithPhoneCode,
  };
});

async function runPublicWhatsAppLogin(params: {
  accountId: string;
  runtime: RuntimeEnv;
  verbose: boolean;
}): Promise<void> {
  const login = whatsappPlugin.auth?.login;
  if (!login) {
    throw new Error("WhatsApp auth.login unavailable");
  }
  await login({ cfg: {}, ...params });
}

describe("WhatsApp public login flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs QR linking when selected", async () => {
    const harness = createQueuedWizardPrompter({ selectValues: ["qr"] });
    const runtime = createNonExitingRuntimeEnv();
    hoisted.createClackPrompter.mockReturnValue(harness.prompter);

    await runPublicWhatsAppLogin({ accountId: " work ", runtime, verbose: true });

    expect(hoisted.createClackPrompter).toHaveBeenCalledOnce();
    expect(harness.select).toHaveBeenCalledWith({
      message: "Choose a WhatsApp login method",
      options: [
        { value: "qr", label: "Scan QR code" },
        { value: "phone-number", label: "Link with phone number" },
      ],
      initialValue: "qr",
    });
    expect(hoisted.loginWeb).toHaveBeenCalledWith(true, undefined, runtime, "work");
    expect(hoisted.loginWebWithPhoneCode).not.toHaveBeenCalled();
  });

  it("prompts for a phone number when phone-number linking is selected", async () => {
    const harness = createQueuedWizardPrompter({
      selectValues: ["phone-number"],
      textValues: ["+1 555 123 4567"],
    });
    const runtime = createNonExitingRuntimeEnv();
    hoisted.createClackPrompter.mockReturnValue(harness.prompter);

    await runPublicWhatsAppLogin({ accountId: "default", runtime, verbose: false });

    expect(hoisted.createClackPrompter).toHaveBeenCalledOnce();
    expect(harness.text).toHaveBeenCalledWith({
      message: "Phone number (with country code)",
      placeholder: "+15551234567",
      validate: expect.any(Function),
    });
    expect(hoisted.loginWebWithPhoneCode).toHaveBeenCalledWith(
      false,
      "+1 555 123 4567",
      undefined,
      runtime,
      "default",
    );
    expect(hoisted.loginWeb).not.toHaveBeenCalled();
  });
});

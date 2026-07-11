// Whatsapp tests cover interactive login method selection.
import {
  createNonExitingRuntimeEnv,
  createQueuedWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWhatsAppLogin } from "./login-flow.js";

const hoisted = vi.hoisted(() => ({
  loginWeb: vi.fn(async () => {}),
  loginWebWithPhoneCode: vi.fn(async () => {}),
}));

vi.mock("./login.js", async () => {
  const actual = await vi.importActual<typeof import("./login.js")>("./login.js");
  return {
    ...actual,
    loginWeb: hoisted.loginWeb,
    loginWebWithPhoneCode: hoisted.loginWebWithPhoneCode,
  };
});

describe("WhatsApp login flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs QR linking when selected", async () => {
    const harness = createQueuedWizardPrompter({ selectValues: ["qr"] });
    const runtime = createNonExitingRuntimeEnv();

    await runWhatsAppLogin({
      accountId: "work",
      prompter: harness.prompter,
      runtime,
      verbose: true,
    });

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

    await runWhatsAppLogin({
      accountId: "default",
      prompter: harness.prompter,
      runtime,
      verbose: false,
    });

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

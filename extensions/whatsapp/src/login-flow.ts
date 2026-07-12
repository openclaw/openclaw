// Whatsapp plugin module coordinates interactive login method selection.
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup-runtime";
import { loginWeb, loginWebWithPhoneCode, normalizeWhatsAppPairingPhoneNumber } from "./login.js";

type WhatsAppLoginMethod = "qr" | "phone-number";

export async function runWhatsAppLogin(params: {
  accountId: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  verbose: boolean;
}): Promise<void> {
  const method = await params.prompter.select<WhatsAppLoginMethod>({
    message: "Choose a WhatsApp login method",
    options: [
      { value: "qr", label: "Scan QR code" },
      { value: "phone-number", label: "Link with phone number" },
    ],
    initialValue: "qr",
  });

  if (method === "phone-number") {
    const phoneNumber = await params.prompter.text({
      message: "Phone number (with country code)",
      placeholder: "+15551234567",
      validate: (value) => {
        try {
          normalizeWhatsAppPairingPhoneNumber(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : "Enter a valid phone number.";
        }
      },
    });
    await loginWebWithPhoneCode(
      params.verbose,
      phoneNumber,
      undefined,
      params.runtime,
      params.accountId,
    );
    return;
  }

  await loginWeb(params.verbose, undefined, params.runtime, params.accountId);
}

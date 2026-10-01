import { formatCliCommand } from "openclaw/plugin-sdk/cli-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { prepareWebAuthForLogin, WhatsAppAuthUnstableError } from "./auth-store.js";

export function formatWhatsAppAccountCommand(
  action: "login" | "logout",
  accountId: string,
): string {
  return formatCliCommand(`openclaw channels ${action} --channel whatsapp --account ${accountId}`);
}

function formatStalePhoneCodeAuthNotClearedMessage(accountId: string): string {
  return `Previous WhatsApp phone-code login left partial credentials in this auth directory, but OpenClaw could not safely clear them. Run ${formatWhatsAppAccountCommand("logout", accountId)} for managed accounts, or remove the custom auth directory's WhatsApp credentials manually, then retry login.`;
}

export async function prepareWebAuthForLoginOrThrow(params: {
  authDir: string;
  accountId: string;
  isLegacyAuthDir: boolean;
  runtime: RuntimeEnv;
  beforeCredentialPersistence?: () => Promise<void>;
}): Promise<void> {
  const { accountId, ...authParams } = params;
  const result = await prepareWebAuthForLogin({ ...authParams, mode: "preserve-linked" });
  if (result === "unstable") {
    throw new WhatsAppAuthUnstableError();
  }
  if (result === "not-cleared") {
    throw new Error(formatStalePhoneCodeAuthNotClearedMessage(accountId));
  }
}

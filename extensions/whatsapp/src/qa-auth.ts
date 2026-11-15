import fs from "node:fs/promises";
import path from "node:path";
import { initAuthCreds, jidDecode } from "baileys";
import { writeCredsJsonAtomically } from "./creds-persistence.js";
import { isWhatsAppUserTarget } from "./normalize-target.js";

/** Create synthetic linked state for a local provider fixture, never an operator account. */
export async function createWhatsAppQaAuthState(params: {
  parentDir: string;
  selfJid: string;
  name: string;
}): Promise<string> {
  const jid = jidDecode(params.selfJid);
  if (
    jid?.server !== "s.whatsapp.net" ||
    !/^\d+$/u.test(jid.user) ||
    !isWhatsAppUserTarget(params.selfJid)
  ) {
    throw new Error("WhatsApp QA identity must be a native user JID");
  }
  // Exclusive allocation prevents fixture initialization from replacing linked account state.
  const authDir = await fs.mkdtemp(path.join(params.parentDir, "whatsapp-qa-auth-"));
  try {
    const creds = initAuthCreds();
    // Crabline accepts a preauthenticated synthetic identity with real Baileys key material.
    // Preserve its exact JID; the Gateway owns the first socket and subsequent credential saves.
    creds.me = { id: params.selfJid, name: params.name };
    await writeCredsJsonAtomically(authDir, creds);
    return authDir;
  } catch (error) {
    try {
      await fs.rm(authDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "WhatsApp QA auth initialization and cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

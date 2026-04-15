// Intentional seam for production lazy-loading of @whiskeysockets/baileys.
// Tests mock this module and provide their own Baileys object via
// loadBaileysRuntime(), so this file should not expose static re-exports.
// Do NOT add top-level `export ... from "@whiskeysockets/baileys"` here,
// because that pulls Baileys into the root dist graph and breaks build-smoke.
export async function loadBaileysRuntime() {
  return import("@whiskeysockets/baileys");
}

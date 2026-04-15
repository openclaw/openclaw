// Intentional seam for testing (mockable via vi.mock) and for production
// code that needs lazy Baileys initialization.
//
// RE-EXPORTS: exist ONLY to satisfy test-helpers.ts which imports this file
// and accesses named exports like makeWASocket, useMultiFileAuthState.
// These are static re-exports — test code only, never imported by production
// session.ts (which uses loadBaileysRuntime facade instead).
//
// FACADE: loadBaileysRuntime() is the production interface.
// session.ts calls loadBaileysRuntime() instead of statically importing Baileys.
export {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

export async function loadBaileysRuntime() {
  return import("@whiskeysockets/baileys");
}

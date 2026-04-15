// This barrel file exists to satisfy test-harness and internal consumers.
// It re-exports from the package directly so the import path stays stable.
// To avoid pulling @whiskeysockets/baileys into the root dist static graph,
// consumers (including session.ts) should use dynamic import("@whiskeysockets/baileys")
// directly rather than routing through this file in production code.
export {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

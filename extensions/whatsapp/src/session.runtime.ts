export {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  // Kept for test-helpers.ts mock wiring; production code uses useAtomicAuthState instead.
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

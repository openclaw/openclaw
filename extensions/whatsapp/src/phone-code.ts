import type { ConnectionState } from "baileys";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { isLinkedWebCredsPayload } from "./auth-store.js";
import { resolveComparableIdentity } from "./identity.js";
import type { createWaSocket } from "./session.js";

const MAX_PAIRING_PHONE_DIGITS = 15;
const PAIRING_PHONE_INPUT_PATTERN = /^\+?[\d\s().-]+$/;
type LoginSocket = Awaited<ReturnType<typeof createWaSocket>>;

export function normalizeWhatsAppPairingPhoneNumber(phoneNumber: string): string {
  const input = phoneNumber.trim();
  const internationalInput = input.startsWith("+") ? input : `+${input}`;
  const parsed = PAIRING_PHONE_INPUT_PATTERN.test(input)
    ? parsePhoneNumberFromString(internationalInput, { extract: false })
    : undefined;
  const suppliedDigits = input.replace(/\D/g, "");
  const canonicalDigits = parsed?.number.slice(1) ?? "";
  // Baileys targets these exact digits, so reject parser "repairs" that remove
  // a national trunk prefix or fold an extension into a different destination.
  const preservesSuppliedDigits = suppliedDigits === canonicalDigits;
  const isCanonicalPairingNumber =
    parsed !== undefined &&
    !parsed.ext &&
    parsed.isPossible() &&
    preservesSuppliedDigits &&
    canonicalDigits.length <= MAX_PAIRING_PHONE_DIGITS;
  if (!isCanonicalPairingNumber) {
    throw new Error(
      "WhatsApp phone-code login requires an international phone number with country code and no extension or national trunk prefix.",
    );
  }
  return canonicalDigits;
}

export function formatPairingCode(code: string): string {
  const trimmed = code.trim();
  return trimmed.length === 8 ? `${trimmed.slice(0, 4)} ${trimmed.slice(4)}` : trimmed;
}

export function isLinkedLoginSocket(sock: LoginSocket): boolean {
  return isLinkedWebCredsPayload(sock.authState.creds);
}

export function assertLinkedLoginSocketMatchesPairingPhoneNumber(
  sock: LoginSocket,
  pairingPhoneNumber: string,
  authDir: string,
  logoutCommand: string,
): void {
  const creds = sock.authState.creds;
  const identity = resolveComparableIdentity(
    {
      jid: typeof creds?.me?.id === "string" ? creds.me.id : null,
      lid: typeof creds?.me?.lid === "string" ? creds.me.lid : null,
    },
    authDir,
  );
  const linkedPhoneNumber = identity.e164?.replace(/\D/g, "");
  if (!linkedPhoneNumber || linkedPhoneNumber === pairingPhoneNumber) {
    return;
  }
  const linkedIdentity = identity.e164 ?? identity.jid ?? identity.lid ?? "unknown";
  throw new Error(
    `Existing WhatsApp credentials are linked to ${linkedIdentity}, not +${pairingPhoneNumber}. Run ${logoutCommand} before linking a different phone number.`,
  );
}

export function createWhatsAppPairingCodeReadySignal(timeoutMs: number): {
  onQr: () => void;
  reset: () => void;
  wait: (sock: LoginSocket) => Promise<void>;
} {
  let ready = false;
  return {
    onQr: () => {
      ready = true;
    },
    reset: () => {
      ready = false;
    },
    wait: (sock) =>
      new Promise<void>((resolve, reject) => {
        if (ready) {
          resolve();
          return;
        }
        const timer = setTimeout(onTimeout, timeoutMs);
        function cleanup() {
          clearTimeout(timer);
          sock.ev.off("connection.update", handler);
        }
        function finish() {
          ready = true;
          cleanup();
          resolve();
        }
        function handler(update: Partial<ConnectionState>) {
          // Baileys emits "connecting" on the next tick before its WebSocket is
          // necessarily open. The server's pair-device QR proves sendNode is ready.
          if (update.qr) {
            finish();
            return;
          }
          if (update.connection === "close") {
            cleanup();
            reject(update.lastDisconnect?.error ?? new Error("Connection closed before pairing."));
          }
        }
        function onTimeout() {
          cleanup();
          reject(new Error("Timed out waiting for WhatsApp to offer phone-code pairing."));
        }
        sock.ev.on("connection.update", handler);
        if (ready) {
          finish();
        }
      }),
  };
}

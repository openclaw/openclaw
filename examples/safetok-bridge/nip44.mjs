// nip44.mjs — SafeTok NIP-44 v3 crypto primitives
// Source of truth: NIP44Encryption.kt (acinq secp256k1-kmp 0.7.0) + Linkather nostr.js/crypto.js
// Key deviations from standard NIP-44:
//   ECDH = SHA256(compressed point), NOT raw-x
//   Nonce = 12 bytes (not 32)
//   No padding
//   Conv key = HKDF extract + expand (not extract-only)
//   Decrypt tries both y-parities (safeTok fallback)

import { secp256k1, schnorr } from "@noble/curves/secp256k1";

const te = new TextEncoder();
const td = new TextDecoder();

export const hexToBytes = (h) => Uint8Array.from(h.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
export const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

const concat = (...arrays) => {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
};

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

async function hmacSha256(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// HKDF as separate extract + expand — matches BouncyCastle HKDFBytesGenerator (NIP44Encryption.kt:264-276)
async function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}

async function hkdfExpand(prk, info, len) {
  const n = Math.ceil(len / 32);
  const out = new Uint8Array(n * 32);
  let prev = new Uint8Array(0);
  for (let i = 1; i <= n; i++) {
    prev = await hmacSha256(prk, concat(prev, info, Uint8Array.of(i)));
    out.set(prev, (i - 1) * 32);
  }
  return out.slice(0, len);
}

// ChaCha20 RFC 8439 IETF — 12-byte nonce, counter starts at 0
// NOT the AEAD construction — raw keystream + separate HMAC (NIP44Encryption.kt:311-319)
const rotl = (v, n) => (v << n) | (v >>> (32 - n)) | 0;

function qr(s, a, b, c, d) {
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotl(s[b] ^ s[c], 7);
}

function chachaBlock(key, counter, nonce) {
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  const kv = new DataView(key.buffer, key.byteOffset, key.byteLength);
  for (let i = 0; i < 8; i++) s[4 + i] = kv.getUint32(i * 4, true);
  s[12] = counter;
  const nv = new DataView(nonce.buffer, nonce.byteOffset, nonce.byteLength);
  for (let i = 0; i < 3; i++) s[13 + i] = nv.getUint32(i * 4, true);
  const w = new Uint32Array(s);
  for (let i = 0; i < 10; i++) {
    qr(w, 0, 4, 8, 12);
    qr(w, 1, 5, 9, 13);
    qr(w, 2, 6, 10, 14);
    qr(w, 3, 7, 11, 15);
    qr(w, 0, 5, 10, 15);
    qr(w, 1, 6, 11, 12);
    qr(w, 2, 7, 8, 13);
    qr(w, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) w[i] = (w[i] + s[i]) | 0;
  const out = new Uint8Array(64);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) ov.setUint32(i * 4, w[i], true);
  return out;
}

function chacha20(key, nonce, data) {
  const out = new Uint8Array(data.length);
  for (let b = 0; b * 64 < data.length; b++) {
    const ks = chachaBlock(key, b, nonce);
    const start = b * 64,
      end = Math.min(start + 64, data.length);
    for (let i = start; i < end; i++) out[i] = data[i] ^ ks[i - start];
  }
  return out;
}

// §3.1 — acinq ECDH = SHA256(compressed 33-byte product point), NOT raw-x
// Proven by NIP44EcdhSpecTest.kt; comments in Kotlin source are wrong
async function ecdh(privHex, pubXOnlyHex, parity) {
  // noble/curves getSharedSecret returns compressed point (33 bytes) by default
  const compressed = secp256k1.getSharedSecret(privHex, parity + pubXOnlyHex);
  return sha256(compressed);
}

// §3.2 — deterministic y-parity from last byte of x-only pubkey (NIP44Encryption.kt:220-223)
export function deterministicParity(pubXOnlyHex) {
  const last = parseInt(pubXOnlyHex.slice(-2), 16);
  return (last & 1) === 0 ? "02" : "03";
}

// §3.3 — conversation key: HKDF-Extract("nip44-v2", shared) → Expand(info="", L=32)
async function conversationKey(sharedSecret) {
  const prk = await hkdfExtract(te.encode("nip44-v2"), sharedSecret);
  return hkdfExpand(prk, new Uint8Array(0), 32);
}

// §3.4 — message keys: HKDF-Extract(32 zero bytes, convKey) → Expand(info=n12, L=76)
async function messageKeys(convKey, n12) {
  const prk = await hkdfExtract(new Uint8Array(32), convKey);
  const km = await hkdfExpand(prk, n12, 76);
  return {
    chachaKey: km.slice(0, 32),
    chachaNonce: km.slice(32, 44),
    hmacKey: km.slice(44, 76),
  };
}

async function deriveAll(privHex, pubXOnlyHex, parity, n12) {
  const shared = await ecdh(privHex, pubXOnlyHex, parity);
  const convKey = await conversationKey(shared);
  return messageKeys(convKey, n12);
}

// §3.5 — encrypt (NIP44Encryption.kt:376-380 / nostr.js:104)
export async function encrypt(message, senderPrivHex, recipientPubHex) {
  const n12 = crypto.getRandomValues(new Uint8Array(12));
  const parity = deterministicParity(recipientPubHex);
  const k = await deriveAll(senderPrivHex, recipientPubHex, parity, n12);
  const ct = chacha20(k.chachaKey, k.chachaNonce, te.encode(message));
  const mac = await hmacSha256(k.hmacKey, concat(n12, ct));
  const payload = concat(Uint8Array.of(0x02), n12, ct, mac);
  return btoa(String.fromCharCode(...payload));
}

// §3.6 — decrypt with parity fallback (matches safeTok NIP44Encryption.kt:135-175)
export async function decrypt(content, recipientPrivHex, senderPubHex) {
  const payload = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  if (payload.length < 45 || payload[0] !== 0x02) throw new Error("bad NIP-44 payload");
  const n12 = payload.slice(1, 13);
  const mac = payload.slice(-32);
  const ct = payload.slice(13, -32);
  const det = deterministicParity(senderPubHex);
  for (const parity of [det, det === "02" ? "03" : "02"]) {
    const k = await deriveAll(recipientPrivHex, senderPubHex, parity, n12);
    const expected = await hmacSha256(k.hmacKey, concat(n12, ct));
    if (expected.every((v, i) => v === mac[i]))
      return td.decode(chacha20(k.chachaKey, k.chachaNonce, ct));
  }
  throw new Error("NIP-44 MAC verification failed (both parities tried)");
}

// §4 — build signed kind-4 DM event (NostrEvent.kt:54-100)
export async function buildDmEvent(message, senderPrivHex, recipientPubHex) {
  const pubKeyBytes = secp256k1.getPublicKey(senderPrivHex, true); // compressed 33 bytes
  const pubkey = bytesToHex(pubKeyBytes.slice(1)); // x-only: drop 02/03
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 4;
  const tags = [["p", recipientPubHex]];
  const content = await encrypt(message, senderPrivHex, recipientPubHex);
  // §4.1 — event id: SHA256 of compact JSON serialization
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const id = bytesToHex(await sha256(te.encode(serialized)));
  // §4.2 — BIP-340 Schnorr over raw 32 id bytes (synchronous in noble/curves)
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), hexToBytes(senderPrivHex)));
  return { id, pubkey, created_at, kind, tags, content, sig };
}

// Key generation helpers
export function generatePrivKey() {
  return bytesToHex(secp256k1.utils.randomPrivateKey());
}

export function privToXOnlyPub(privHex) {
  const compressed = secp256k1.getPublicKey(privHex, true);
  return bytesToHex(compressed.slice(1)); // x-only
}

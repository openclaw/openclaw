const STORAGE_KEY = "openclaw-device-identity-v1";

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str) {
  const padded =
    str.replace(/-/g, "+").replace(/_/g, "/") + "==".slice(0, (4 - (str.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function generateIdentity() {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateKeyPkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const hashBuf = await crypto.subtle.digest("SHA-256", publicKeyRaw);
  const deviceId = [...new Uint8Array(hashBuf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return {
    deviceId,
    publicKeyBase64url: base64url(publicKeyRaw),
    privateKeyPkcs8Base64: btoa(String.fromCharCode(...new Uint8Array(privateKeyPkcs8))),
  };
}

export async function getOrCreateIdentity() {
  const stored = await chrome.storage.local.get([STORAGE_KEY]);
  const existing = stored[STORAGE_KEY];

  if (
    existing &&
    existing.deviceId &&
    existing.publicKeyBase64url &&
    existing.privateKeyPkcs8Base64
  ) {
    return existing;
  }

  const identity = await generateIdentity();
  await chrome.storage.local.set({ [STORAGE_KEY]: identity });
  return identity;
}

export async function buildDeviceBlock(identity, params) {
  const { clientId, mode, role, scopes, token, nonce } = params;
  const signedAt = Date.now();
  const scopesCsv = (scopes || []).join(",");
  const payload = `v2|${identity.deviceId}|${clientId}|${mode}|${role}|${scopesCsv}|${signedAt}|${token || ""}|${nonce || ""}`;

  const pkcs8Buf = Uint8Array.from(atob(identity.privateKeyPkcs8Base64), (c) =>
    c.charCodeAt(0),
  ).buffer;
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8Buf, "Ed25519", false, ["sign"]);
  const sigBuf = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(payload));

  return {
    id: identity.deviceId,
    publicKey: identity.publicKeyBase64url,
    signature: base64url(sigBuf),
    signedAt,
    nonce: nonce || "",
  };
}

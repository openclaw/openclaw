// Ed25519 device identity for the side panel's gateway connection. The panel
// pairs with the gateway as its own operator device (approved once via
// `openclaw devices`), so the raw gateway credential never becomes the panel's
// identity. Lives outside modules/ because it needs chrome.storage; the pure
// helpers in modules/ stay chrome-free for vitest.

const STORAGE_KEY = "openclaw-device-identity-v1";

function base64url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateIdentity() {
  let keyPair;
  try {
    keyPair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  } catch (err) {
    // Ed25519 WebCrypto is only enabled by default from Chrome 137, but the rest
    // of the extension supports the manifest's minimum (125) and keeps working,
    // so name the real cause instead of surfacing a bare NotSupportedError.
    throw new Error(
      "The side panel needs Chrome 137 or newer (for Ed25519 device keys). The rest of the extension works on older versions.",
      { cause: err },
    );
  }
  const publicKeyRaw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
  const privateKeyPkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const hashBuf = await crypto.subtle.digest("SHA-256", publicKeyRaw);
  // The gateway requires deviceId === SHA-256(publicKey) (hex), so derive it.
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
  if (existing?.deviceId && existing.publicKeyBase64url && existing.privateKeyPkcs8Base64) {
    return existing;
  }
  const identity = await generateIdentity();
  await chrome.storage.local.set({ [STORAGE_KEY]: identity });
  return identity;
}

/**
 * Sign the gateway's connect challenge. The v2 payload shape (still verified
 * by the gateway alongside v3) binds device, client identity, scopes, the
 * presented shared secret, and the challenge nonce.
 */
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

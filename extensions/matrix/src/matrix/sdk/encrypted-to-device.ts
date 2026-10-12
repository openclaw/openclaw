const ENCRYPTED_TO_DEVICE_PATH_RE =
  /\/_matrix\/client\/(?:v3|r0|unstable)\/sendToDevice\/m\.room\.encrypted\//;

/** True for the request that hands Olm-encrypted to-device messages to the homeserver. */
export function isEncryptedToDeviceSend(resource: RequestInfo | URL, init?: RequestInit): boolean {
  const method = init?.method ?? (resource instanceof Request ? resource.method : "GET");
  if (method.toUpperCase() !== "PUT") {
    return false;
  }
  const url = resource instanceof Request ? resource.url : String(resource);
  return ENCRYPTED_TO_DEVICE_PATH_RE.test(new URL(url).pathname);
}

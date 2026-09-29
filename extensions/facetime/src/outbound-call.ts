const FACETIME_DIAL_MODES = ["audio", "video"] as const;
export type FaceTimeDialMode = (typeof FACETIME_DIAL_MODES)[number];
export type FaceTimeDialRequest = { handle: string; mode: FaceTimeDialMode };

function canonicalizeHandle(value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }
  const digits = trimmed.replace(/[^\d+]/gu, "");
  return digits.startsWith("+")
    ? `+${digits.slice(1).replace(/\D/gu, "")}`
    : digits.replace(/\D/gu, "");
}

function readHandle(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("handle is required");
  }
  const handle = value.trim();
  if (handle.length > 320 || /^[a-z][a-z\d+.-]*:/iu.test(handle)) {
    throw new Error("handle must be a FaceTime email address or phone number");
  }
  if (handle.includes("@")) {
    if (!/^[^@\s]+@[^@\s]+$/u.test(handle)) {
      throw new Error("handle must be a valid FaceTime email address or phone number");
    }
  } else if (!/^[+\d\s().-]+$/u.test(handle) || !/\d/u.test(handle)) {
    throw new Error("handle must be a valid FaceTime email address or phone number");
  }
  return handle;
}

export function resolveFaceTimeDialRequest(params: {
  handle: unknown;
  mode?: unknown;
  ownerHandles: readonly string[];
}): FaceTimeDialRequest {
  const handle = readHandle(params.handle);
  const canonical = canonicalizeHandle(handle);
  if (!params.ownerHandles.some((entry) => canonicalizeHandle(entry) === canonical)) {
    throw new Error("FaceTime handle is not an authorized owner handle");
  }
  const mode = params.mode === undefined ? "audio" : params.mode;
  if (mode !== "audio" && mode !== "video") {
    throw new Error("mode must be audio or video");
  }
  return { handle, mode };
}

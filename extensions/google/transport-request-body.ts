import { GOOGLE_VIDEO_SLOT_OMISSION } from "openclaw/plugin-sdk/provider-transport-runtime";

const GOOGLE_REQUEST_BYTES_EXCLUSIVE = 20_000_000;

export function assertGoogleRequestSize(bytes: number): void {
  if (bytes >= GOOGLE_REQUEST_BYTES_EXCLUSIVE) {
    throw new Error(
      `Google request body must be smaller than ${GOOGLE_REQUEST_BYTES_EXCLUSIVE} bytes`,
    );
  }
}

export function replaceGooglePartWithText(part: Record<string, unknown>, text: string): void {
  Object.keys(part).forEach((key) => Reflect.deleteProperty(part, key));
  part.text = text;
}

export function serializeGoogleRequest(
  request: object,
  videoSlots: Record<string, unknown>[],
): string {
  let body = JSON.stringify(request);
  for (const slot of videoSlots.toReversed()) {
    if (Buffer.byteLength(body, "utf8") < GOOGLE_REQUEST_BYTES_EXCLUSIVE) {
      break;
    }
    replaceGooglePartWithText(slot, GOOGLE_VIDEO_SLOT_OMISSION);
    body = JSON.stringify(request);
  }
  assertGoogleRequestSize(Buffer.byteLength(body, "utf8"));
  return body;
}

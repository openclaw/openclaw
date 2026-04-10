/**
 * Some `imsg rpc` notification payloads include a protobuf-style length-delimited
 * UTF-8 blob inside the JSON `text` (or `reply_to_text`) string. When the
 * framing is not stripped upstream, a short binary prefix appears before the
 * real message. This helper removes a leading varint length plus exactly that
 * many following bytes only when they consume the entire string, so normal
 * messages are unchanged.
 */
export function stripImessageLengthPrefixedUtf8Text(text: string): string {
  if (!text) {
    return text;
  }
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= 1) {
    return text;
  }

  let offset = 0;
  let payloadLen = 0;
  let shift = 0;
  let varintBytes = 0;

  while (offset < buf.length && varintBytes < 10) {
    const b = buf[offset];
    offset += 1;
    varintBytes += 1;
    payloadLen |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      break;
    }
    shift += 7;
    if (shift > 35) {
      return text;
    }
  }

  if (varintBytes === 0) {
    return text;
  }

  // Truncated varint (last byte still has continuation bit set).
  const varintLast = buf[offset - 1];
  if (varintLast !== undefined && (varintLast & 0x80) !== 0) {
    return text;
  }

  if (payloadLen === 0 || payloadLen > buf.length - offset) {
    return text;
  }

  if (offset + payloadLen !== buf.length) {
    return text;
  }

  const inner = buf.subarray(offset, offset + payloadLen).toString("utf8");
  return inner.length > 0 ? inner : text;
}

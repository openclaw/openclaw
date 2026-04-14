/**
 * Compute the duration of an Ogg Opus audio stream from its raw bytes.
 *
 * Ogg files consist of pages, each starting with the capture pattern "OggS".
 * The last page's granule position (bytes 6–13, little-endian uint64) divided
 * by the Opus sample rate (always 48 000 Hz) gives the total duration.
 *
 * This is intentionally minimal — it only needs the last page header, so it
 * scans backwards from the end of the buffer.
 */

const OGG_CAPTURE = Buffer.from("OggS");
const OPUS_SAMPLE_RATE = 48_000;
// Minimum bytes needed: "OggS"(4) + version(1) + type(1) + granule(8) = 14
const OGG_MIN_HEADER_BYTES = 14;

/**
 * Return the duration of an Ogg Opus buffer in whole seconds, or `undefined`
 * if the buffer does not look like a valid Ogg stream.
 */
export function getOggDurationSecs(buffer: Buffer): number | undefined {
  if (!buffer || buffer.length < OGG_MIN_HEADER_BYTES) {
    return undefined;
  }

  // Verify the file starts with an Ogg page.
  if (buffer.compare(OGG_CAPTURE, 0, OGG_CAPTURE.length, 0, OGG_CAPTURE.length) !== 0) {
    return undefined;
  }

  // Scan backwards for the last "OggS" capture pattern.
  let lastPageOffset = -1;
  for (let i = buffer.length - OGG_CAPTURE.length; i >= 0; i--) {
    if (
      buffer[i] === 0x4f && // 'O'
      buffer[i + 1] === 0x67 && // 'g'
      buffer[i + 2] === 0x67 && // 'g'
      buffer[i + 3] === 0x53 // 'S'
    ) {
      lastPageOffset = i;
      break;
    }
  }

  if (lastPageOffset < 0 || lastPageOffset + OGG_MIN_HEADER_BYTES > buffer.length) {
    return undefined;
  }

  // Granule position is at offset 6 from the page start (after "OggS" + version + header_type).
  const granuleOffset = lastPageOffset + 6;
  if (granuleOffset + 8 > buffer.length) {
    return undefined;
  }

  // Read 64-bit little-endian granule position.
  // Use two 32-bit reads to avoid BigInt for broader compatibility.
  const lo = buffer.readUInt32LE(granuleOffset);
  const hi = buffer.readUInt32LE(granuleOffset + 4);

  // 0xFFFFFFFF_FFFFFFFF means "granule not set" — skip.
  if (lo === 0xffffffff && hi === 0xffffffff) {
    return undefined;
  }

  const granule = hi * 0x1_0000_0000 + lo;
  if (granule <= 0) {
    return undefined;
  }

  return Math.round(granule / OPUS_SAMPLE_RATE);
}

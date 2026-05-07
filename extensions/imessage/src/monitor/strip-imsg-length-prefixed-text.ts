type Varint = {
  nextOffset: number;
  value: number;
};

const utf8Decoder = new TextDecoder();

function isControlCodeUnit(value: number): boolean {
  return value <= 0x1f || (value >= 0x7f && value <= 0x9f);
}

function isAsciiPrintableCodeUnit(value: number): boolean {
  return value >= 0x20 && value <= 0x7e;
}

function attributedBodyCorruptionPrefixLength(text: string): number {
  if (text.charCodeAt(0) !== 0xfffd) {
    return 0;
  }

  const second = text.charCodeAt(1);
  if (second === 0xfffd) {
    const third = text.charCodeAt(2);
    return Number.isNaN(third) || !isControlCodeUnit(third) ? 2 : 3;
  }

  if (isControlCodeUnit(second)) {
    let offset = 1;
    while (offset < 4 && isControlCodeUnit(text.charCodeAt(offset))) {
      offset += 1;
    }
    return offset;
  }

  const third = text.charCodeAt(2);
  if (isAsciiPrintableCodeUnit(second) && isControlCodeUnit(third)) {
    return 3;
  }

  return 0;
}

function stripLeadingAttributedBodyCorruption(text: string): string {
  const prefixLength = attributedBodyCorruptionPrefixLength(text);
  if (prefixLength === 0) {
    return text;
  }
  const next = text.slice(prefixLength);
  if (!next || isControlCodeUnit(next.charCodeAt(0))) {
    return text;
  }
  return next;
}

function readVarint(buf: Uint8Array, start: number): Varint | null {
  let offset = start;
  let value = 0;
  let shift = 0;

  while (offset < buf.length && shift <= 28) {
    const byte = buf[offset];
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { nextOffset: offset, value };
    }
    shift += 7;
  }

  return null;
}

export function tryStripImessageLengthPrefixedUtf8Buffer(buf: Uint8Array): Uint8Array | null {
  const key = readVarint(buf, 0);
  if (!key || key.nextOffset >= buf.length) {
    return null;
  }

  if (key.value !== 0x0a) {
    return null;
  }

  const length = readVarint(buf, key.nextOffset);
  if (!length || length.value === 0) {
    return null;
  }

  if (length.nextOffset + length.value !== buf.length) {
    return null;
  }

  return buf.subarray(length.nextOffset, buf.length);
}

export function stripImessageLengthPrefixedUtf8Text(text: string): string {
  if (!text) {
    return text;
  }

  const attributedBodyCleaned = stripLeadingAttributedBodyCorruption(text);
  if (attributedBodyCleaned !== text) {
    return attributedBodyCleaned;
  }

  const stripped = tryStripImessageLengthPrefixedUtf8Buffer(Buffer.from(text, "utf8"));
  if (!stripped) {
    return text;
  }

  const inner = utf8Decoder.decode(stripped);
  return inner.length > 0 ? inner : text;
}

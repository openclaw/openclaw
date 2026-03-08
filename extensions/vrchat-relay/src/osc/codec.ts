// OSC message types for VRChat
export interface OSCArg {
  type: "string" | "integer" | "float" | "boolean" | "null";
  value?: string | number | boolean;
}

export interface OSCMessageOut {
  address: string;
  args: OSCArg[];
}

export interface OSCMessageIn {
  address: string;
  args: unknown[];
}

// Minimal OSC encoder/decoder for VRChat
export function encodeOSCMessage(message: OSCMessageOut): Buffer {
  const parts: Buffer[] = [];

  // Encode address
  parts.push(encodeString(message.address));

  // Encode type tag and values
  if (message.args.length > 0) {
    const typeTags = message.args
      .map((arg) => {
        switch (arg.type) {
          case "string":
            return "s";
          case "integer":
            return "i";
          case "float":
            return "f";
          case "boolean":
            return arg.value ? "T" : "F";
          case "null":
            return "N";
          default:
            return "N";
        }
      })
      .join("");

    parts.push(encodeString("," + typeTags));

    // Encode values
    for (const arg of message.args) {
      if (arg.type === "string") {
        parts.push(encodeString(String(arg.value ?? "")));
      } else if (arg.type === "integer") {
        const buf = Buffer.allocUnsafe(4);
        buf.writeInt32BE(Number(arg.value ?? 0), 0);
        parts.push(buf);
      } else if (arg.type === "float") {
        const buf = Buffer.allocUnsafe(4);
        buf.writeFloatBE(Number(arg.value ?? 0), 0);
        parts.push(buf);
      }
      // boolean and null don't need additional data
    }
  }

  return Buffer.concat(parts);
}

export function decodeOSCMessage(buffer: Buffer): OSCMessageIn | null {
  try {
    let offset = 0;

    // Decode address
    const addressResult = decodeString(buffer, offset);
    if (!addressResult) return null;
    const address = addressResult.value;
    offset = addressResult.newOffset;

    // Check if there's a type tag
    if (offset >= buffer.length) {
      return { address, args: [] };
    }

    // Check for comma (type tag start)
    if (buffer[offset] === 0x2c) {
      const typeTagResult = decodeString(buffer, offset);
      if (!typeTagResult) return { address, args: [] };
      const typeTags = typeTagResult.value.slice(1); // Remove leading comma
      offset = typeTagResult.newOffset;

      const args: unknown[] = [];

      for (const tag of typeTags) {
        switch (tag) {
          case "s": {
            const strResult = decodeString(buffer, offset);
            if (strResult) {
              args.push(strResult.value);
              offset = strResult.newOffset;
            }
            break;
          }
          case "i": {
            if (offset + 4 <= buffer.length) {
              args.push(buffer.readInt32BE(offset));
              offset += 4;
            }
            break;
          }
          case "f": {
            if (offset + 4 <= buffer.length) {
              args.push(buffer.readFloatBE(offset));
              offset += 4;
            }
            break;
          }
          case "T":
            args.push(true);
            break;
          case "F":
            args.push(false);
            break;
          case "N":
            args.push(null);
            break;
        }
      }

      return { address, args };
    }

    return { address, args: [] };
  } catch {
    return null;
  }
}

function encodeString(str: string): Buffer {
  const buf = Buffer.from(str + "\0");
  const padding = (4 - (buf.length % 4)) % 4;
  return Buffer.concat([buf, Buffer.alloc(padding)]);
}

function decodeString(buffer: Buffer, offset: number): { value: string; newOffset: number } | null {
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) {
    end++;
  }

  if (end >= buffer.length) return null;

  const value = buffer.toString("utf8", offset, end);
  // Skip null terminator and padding
  const newOffset = end + 1 + ((4 - ((end - offset + 1) % 4)) % 4);

  return { value, newOffset };
}

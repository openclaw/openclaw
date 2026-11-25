import type { RawData } from "openclaw/plugin-sdk/websocket-runtime";

export function codexWebSocketDataToBuffer(data: RawData | Uint8Array): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : data instanceof Uint8Array
        ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
        : Buffer.from(data);
}

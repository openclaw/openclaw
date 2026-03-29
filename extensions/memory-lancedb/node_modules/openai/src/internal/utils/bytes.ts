export function concatBytes(buffers: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const buffer of buffers) {
    length += buffer.length;
  }
  const output = new Uint8Array(length);
  let index = 0;
  for (const buffer of buffers) {
    output.set(buffer, index);
    index += buffer.length;
  }

  return output;
}

let encodeUTF8_: (str: string) => Uint8Array;
export function encodeUTF8(str: string) {
  let encoder;
  return (
    encodeUTF8_ ??
    ((encoder = new (globalThis as any).TextEncoder()), (encodeUTF8_ = encoder.encode.bind(encoder)))
  )(str);
}

let decodeUTF8_: (bytes: Uint8Array) => string;
export function decodeUTF8(bytes: Uint8Array) {
  let decoder;
  return (
    decodeUTF8_ ??
    ((decoder = new (globalThis as any).TextDecoder()), (decodeUTF8_ = decoder.decode.bind(decoder)))
  )(bytes);
}

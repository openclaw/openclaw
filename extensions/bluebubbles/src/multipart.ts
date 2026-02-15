import { blueBubblesFetchWithTimeout } from "./types.js";

export function concatUint8Arrays(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}

export async function postMultipartFormData(params: {
  url: string;
  boundary: string;
  parts: Uint8Array[];
  timeoutMs: number;
}): Promise<Response> {
  const body = Buffer.from(concatUint8Arrays(params.parts));
  return await blueBubblesFetchWithTimeout(
    params.url,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${params.boundary}`,
      },
      body,
    },
    params.timeoutMs,
  );
}

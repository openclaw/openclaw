import { blueBubblesFetchWithTimeout } from "./types.js";
function concatUint8Arrays(parts) {
  const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }
  return body;
}
async function postMultipartFormData(params) {
  const body = Buffer.from(concatUint8Arrays(params.parts));
  return await blueBubblesFetchWithTimeout(
    params.url,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${params.boundary}`
      },
      body
    },
    params.timeoutMs
  );
}
async function assertMultipartActionOk(response, action) {
  if (response.ok) {
    return;
  }
  const errorText = await response.text().catch(() => "");
  throw new Error(`BlueBubbles ${action} failed (${response.status}): ${errorText || "unknown"}`);
}
export {
  assertMultipartActionOk,
  concatUint8Arrays,
  postMultipartFormData
};

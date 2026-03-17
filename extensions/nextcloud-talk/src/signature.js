import { createHmac, randomBytes } from "node:crypto";
const SIGNATURE_HEADER = "x-nextcloud-talk-signature";
const RANDOM_HEADER = "x-nextcloud-talk-random";
const BACKEND_HEADER = "x-nextcloud-talk-backend";
function verifyNextcloudTalkSignature(params) {
  const { signature, random, body, secret } = params;
  if (!signature || !random || !secret) {
    return false;
  }
  const expected = createHmac("sha256", secret).update(random + body).digest("hex");
  if (signature.length !== expected.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}
function extractNextcloudTalkHeaders(headers) {
  const getHeader = (name) => {
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };
  const signature = getHeader(SIGNATURE_HEADER);
  const random = getHeader(RANDOM_HEADER);
  const backend = getHeader(BACKEND_HEADER);
  if (!signature || !random || !backend) {
    return null;
  }
  return { signature, random, backend };
}
function generateNextcloudTalkSignature(params) {
  const { body, secret } = params;
  const random = randomBytes(32).toString("hex");
  const signature = createHmac("sha256", secret).update(random + body).digest("hex");
  return { random, signature };
}
export {
  extractNextcloudTalkHeaders,
  generateNextcloudTalkSignature,
  verifyNextcloudTalkSignature
};

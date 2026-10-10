import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { request } from "node:https";
import type {
  InvokeNativeHookRelayParams,
  NativeHookRelayProcessResponse,
} from "./native-hook-relay-types.js";

const MAX_CREDENTIAL_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** Read a dedicated credential, never a Gateway config or shared state database. */
export async function invokeRemoteNativeHookRelay(
  credentialPath: string,
  params: InvokeNativeHookRelayParams,
  signal: AbortSignal,
): Promise<NativeHookRelayProcessResponse> {
  const file = await open(credentialPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let credential: { url: string; token: string };
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("Invalid native hook callback credential");
    }
    const buffer = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CREDENTIAL_BYTES) {
      throw new Error("Invalid native hook callback credential");
    }
    try {
      credential = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      throw new Error("Invalid native hook callback credential");
    }
  } finally {
    await file.close();
  }
  if (
    !credential ||
    typeof credential.url !== "string" ||
    typeof credential.token !== "string" ||
    !credential.token
  ) {
    throw new Error("Invalid native hook callback credential");
  }
  let url: URL;
  try {
    url = new URL(credential.url);
  } catch {
    throw new Error("Invalid native hook callback URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Native hook callback requires an HTTPS URL without credentials or query");
  }
  signal.throwIfAborted();
  const body = JSON.stringify(params);
  return await new Promise((resolve, reject) => {
    // Node's HTTPS client verifies certificates, honors NODE_EXTRA_CA_CERTS, and
    // does not follow redirects. A relay credential never leaves this endpoint.
    const req = request(
      url,
      {
        method: "POST",
        signal,
        headers: {
          authorization: `Bearer ${credential.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.destroy();
          reject(new Error(`Native hook callback rejected (${res.statusCode ?? 0})`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            reject(new Error("Native hook callback response too large"));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", () => reject(new Error("Native hook callback response failed")));
        res.on("end", () => {
          try {
            const decoded = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const result = decoded?.result;
            if (
              decoded?.ok !== true ||
              !result ||
              typeof result.stdout !== "string" ||
              typeof result.stderr !== "string" ||
              !Number.isInteger(result.exitCode)
            ) {
              throw new Error("Invalid response");
            }
            resolve(result);
          } catch {
            reject(new Error("Invalid native hook callback response"));
          }
        });
      },
    );
    // Do not surface URLs, headers, or a server-supplied error containing secrets.
    req.on("error", () => reject(new Error("Native hook callback connection failed")));
    req.end(body);
  });
}

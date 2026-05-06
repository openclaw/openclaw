/**
 * OCI request signer (RSA-SHA256).
 *
 * Implements the [HTTP Signature variant Oracle uses](https://docs.oracle.com/en-us/iaas/Content/API/Concepts/signingrequests.htm)
 * for authenticating REST API calls to Oracle Cloud Infrastructure
 * services, including Generative AI's `/openai/v1` chat-completions endpoint.
 *
 * The signature is RSA-SHA256 over a deterministic canonical string built
 * from a fixed list of request headers.  The header set differs by HTTP
 * method:
 *
 *   GET / DELETE / HEAD:     (request-target) host date
 *   PUT / POST / PATCH:      (request-target) host date content-length
 *                            content-type x-content-sha256
 *
 * The signed value is placed in the `Authorization` header in the
 * IETF Signature scheme:
 *
 *   Authorization: Signature version="1",
 *     keyId="<tenancy>/<user>/<fingerprint>",
 *     algorithm="rsa-sha256",
 *     signature="<base64>",
 *     headers="(request-target) host date ..."
 *
 * This module is a pure function over Node's built-in `crypto` — no
 * network access, no SDK dependencies, fully testable in isolation.
 */

import { createHash, createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { OciProfile } from "./profile-loader.js";

const SIGNATURE_ALGORITHM = "rsa-sha256";
const SIGNATURE_VERSION = "1";

const HEADERS_NO_BODY = ["(request-target)", "host", "date"] as const;
const HEADERS_WITH_BODY = [
  "(request-target)",
  "host",
  "date",
  "content-length",
  "content-type",
  "x-content-sha256",
] as const;

const METHODS_WITH_BODY = new Set(["POST", "PUT", "PATCH"]);

export type SignableRequest = {
  /** Upper-cased HTTP method, e.g. "POST". */
  readonly method: string;
  /** Absolute URL of the request. */
  readonly url: string | URL;
  /** Already-stringified request body for body-bearing methods, or empty. */
  readonly body?: string | Uint8Array;
  /**
   * Caller-supplied headers whose names are case-insensitive.  Any
   * `host`, `date`, `content-length`, `content-type`, `x-content-sha256`
   * already present here is preserved; others are derived.  Returned
   * map merges both.
   */
  readonly headers?: Record<string, string>;
};

export type SignedHeaders = Record<string, string>;

export type OciSignerOptions = {
  /** Profile (already loaded from `~/.oci/config`). */
  readonly profile: OciProfile;
  /**
   * Override the current time — used by tests to produce deterministic
   * signatures.  Production callers should leave unset.
   */
  readonly nowMs?: number;
};

/**
 * Stateful signer.  Caches the resolved private key so a single signer can
 * sign many requests without re-reading the file every time.
 */
export class OciRequestSigner {
  readonly #profile: OciProfile;
  readonly #now: () => number;
  #privateKey?: KeyObject;

  constructor(options: OciSignerOptions) {
    this.#profile = options.profile;
    this.#now =
      typeof options.nowMs === "number" ? () => options.nowMs as number : () => Date.now();
  }

  /**
   * Compute the signed headers for one outbound request.
   *
   * Returns the merged header set (caller's headers + everything OCI
   * requires).  The caller passes this to `fetch` (or any HTTP client)
   * verbatim.
   *
   * The body is fully consumed to compute the SHA-256 — callers that need
   * to stream large uploads must either buffer first or sign manually.
   */
  async sign(request: SignableRequest): Promise<SignedHeaders> {
    const url = request.url instanceof URL ? request.url : new URL(request.url);
    const method = request.method.toUpperCase();
    const isBodyMethod = METHODS_WITH_BODY.has(method);

    const headers = lowerCaseHeaders(request.headers ?? {});
    headers.host = headers.host ?? url.host;
    headers.date = headers.date ?? new Date(this.#now()).toUTCString();

    let bodyBytes: Uint8Array | undefined;
    if (isBodyMethod) {
      bodyBytes = encodeBody(request.body);
      headers["content-type"] = headers["content-type"] ?? "application/json";
      headers["content-length"] = headers["content-length"] ?? String(bodyBytes.byteLength);
      headers["x-content-sha256"] = headers["x-content-sha256"] ?? sha256Base64(bodyBytes);
    }

    const requestTarget = `${method.toLowerCase()} ${url.pathname}${url.search}`;
    const headerOrder = isBodyMethod ? HEADERS_WITH_BODY : HEADERS_NO_BODY;

    const canonical = headerOrder
      .map((name) => {
        if (name === "(request-target)") {
          return `(request-target): ${requestTarget}`;
        }
        const value = headers[name];
        if (value === undefined) {
          throw new OciSignerError(`Required header "${name}" missing during sign()`);
        }
        return `${name}: ${value}`;
      })
      .join("\n");

    const signature = await this.#signCanonical(canonical);
    const keyId = `${this.#profile.tenancy}/${this.#profile.user}/${this.#profile.fingerprint}`;

    headers.authorization = formatAuthorization({
      keyId,
      signature,
      headers: headerOrder.slice(),
    });
    return headers;
  }

  async #signCanonical(canonical: string): Promise<string> {
    if (!this.#privateKey) {
      this.#privateKey = await loadPrivateKey(this.#profile.keyFile, this.#profile.passPhrase);
    }
    const signer = createSign("RSA-SHA256");
    signer.update(canonical);
    signer.end();
    return signer.sign(this.#privateKey).toString("base64");
  }
}

/**
 * Convenience: build a `fetch`-compatible wrapper that signs every outgoing
 * request before delegating to the underlying fetch implementation.  Slots
 * into the `fetch:` option of OpenAI's SDK client without further surgery.
 */
export function createOciSignedFetch(
  signer: OciRequestSigner,
  innerFetch: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" || input instanceof URL ? input : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = serializeFetchBody(init?.body);
    const incoming = headersToRecord(init?.headers, input);
    // OCI rejects an Authorization that already says Bearer; strip it before
    // signing.  OpenAI SDK always sets one — that's the value we replace.
    delete incoming.authorization;
    const signed = await signer.sign({ method, url, body, headers: incoming });
    return innerFetch(input, { ...init, headers: signed });
  };
}

export class OciSignerError extends Error {
  readonly code = "OCI_SIGNER";
  constructor(message: string, options?: { cause?: Error }) {
    super(message, options);
    this.name = "OciSignerError";
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

async function loadPrivateKey(keyFile: string, passphrase: string | undefined): Promise<KeyObject> {
  let pem: string;
  try {
    pem = await readFile(keyFile, "utf8");
  } catch (err) {
    throw new OciSignerError(`Could not read OCI private key at ${keyFile}`, {
      cause: err as Error,
    });
  }
  try {
    return createPrivateKey({
      key: pem,
      ...(passphrase ? { passphrase } : {}),
    });
  } catch (err) {
    throw new OciSignerError(
      `OCI private key at ${keyFile} could not be parsed (${(err as Error).message})`,
      { cause: err as Error },
    );
  }
}

function lowerCaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name.toLowerCase()] = value;
  }
  return out;
}

function encodeBody(body: SignableRequest["body"]): Uint8Array {
  if (body === undefined || body === null) {
    return new Uint8Array(0);
  }
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  return body;
}

function sha256Base64(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64");
}

function formatAuthorization(params: {
  keyId: string;
  signature: string;
  headers: readonly string[];
}): string {
  return [
    `Signature version="${SIGNATURE_VERSION}"`,
    `keyId="${params.keyId}"`,
    `algorithm="${SIGNATURE_ALGORITHM}"`,
    `signature="${params.signature}"`,
    `headers="${params.headers.join(" ")}"`,
  ].join(",");
}

function serializeFetchBody(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body === null || body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  // FormData / Blob / streams: not supported on this signed path — chat
  // completion bodies are JSON, and OpenAI SDK serializes JSON synchronously.
  throw new OciSignerError(
    `Unsupported fetch body type for OCI signing: ${Object.prototype.toString.call(body)}. ` +
      `Provide a string or Uint8Array.`,
  );
}

function headersToRecord(
  headers: HeadersInit | undefined,
  input: RequestInfo | URL,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof input !== "string" && !(input instanceof URL)) {
    for (const [name, value] of input.headers.entries()) {
      out[name.toLowerCase()] = value;
    }
  }
  if (headers) {
    if (headers instanceof Headers) {
      for (const [name, value] of headers.entries()) {
        out[name.toLowerCase()] = value;
      }
    } else if (Array.isArray(headers)) {
      for (const [name, value] of headers) {
        out[name.toLowerCase()] = value;
      }
    } else {
      for (const [name, value] of Object.entries(headers)) {
        out[name.toLowerCase()] = value;
      }
    }
  }
  return out;
}

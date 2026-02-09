/**
 * Gonka.ai stream integration.
 *
 * Wraps `streamSimple` from pi-ai so that every HTTP request to the Gonka
 * node is signed with the user's ECDSA Secp256k1 private key.
 *
 * Because pi-ai's `streamSimple` instantiates its own OpenAI client internally
 * and does not expose a `fetch` injection point, we temporarily replace
 * `globalThis.fetch` with a signing version.  The original `fetch` is restored
 * once the stream object is created (the OpenAI SDK captures the reference).
 *
 * Signing uses the "Phase 3" algorithm (matching gonka-openai Python SDK v0.2.4):
 *   sig_input = SHA256(body).hexdigest() + str(timestamp_ns) + transferAddress
 *   message_hash = SHA256(sig_input)
 *   signature = ECDSA_secp256k1_sign(message_hash, privateKey)
 *
 * Additionally, vLLM (Gonka's backend) requires `messages[].content` as plain
 * strings, but pi-ai's openai-completions provider may emit content as arrays
 * of content parts.  We intercept fetch requests to normalize these.
 */

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@mariozechner/pi-ai";
import type { GonkaEndpoint } from "gonka-openai";
import { streamSimple } from "@mariozechner/pi-ai";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Allowed transfer agents (v0.2.9 whitelist)
// https://github.com/gonka-ai/gonka/blob/e5eeb515/inference-chain/app/upgrades/v0_2_9/upgrades.go#L16
// ---------------------------------------------------------------------------

const ALLOWED_TRANSFER_AGENTS = new Set([
  "gonka1y2a9p56kv044327uycmqdexl7zs82fs5ryv5le",
  "gonka1dkl4mah5erqggvhqkpc8j3qs5tyuetgdy552cp",
  "gonka1kx9mca3xm8u8ypzfuhmxey66u0ufxhs7nm6wc5",
  "gonka1ddswmmmn38esxegjf6qw36mt4aqyw6etvysy5x",
  "gonka10fynmy2npvdvew0vj2288gz8ljfvmjs35lat8n",
  "gonka1v8gk5z7gcv72447yfcd2y8g78qk05yc4f3nk4w",
  "gonka1gndhek2h2y5849wf6tmw6gnw9qn4vysgljed0u",
]);

// ---------------------------------------------------------------------------
// Endpoint cache with TTL (5 minutes)
// ---------------------------------------------------------------------------

const ENDPOINT_CACHE_TTL_MS = 5 * 60 * 1000;

let cachedEndpoints: GonkaEndpoint[] | null = null;
let cacheTimestamp = 0;

async function resolveGonkaEndpoints(sourceUrl?: string): Promise<GonkaEndpoint[]> {
  const now = Date.now();
  if (cachedEndpoints && now - cacheTimestamp < ENDPOINT_CACHE_TTL_MS) {
    return cachedEndpoints;
  }

  const { resolveEndpoints } = await import("gonka-openai");
  const allEndpoints = await resolveEndpoints(sourceUrl ? { sourceUrl } : {});

  // Filter to only endpoints whose transfer agent address is whitelisted.
  const allowed = allEndpoints.filter((ep) =>
    ALLOWED_TRANSFER_AGENTS.has(ep.transferAddress ?? ep.address),
  );
  cachedEndpoints = allowed.length > 0 ? allowed : allEndpoints;
  cacheTimestamp = Date.now();
  return cachedEndpoints;
}

/** Strip /v1 suffix to get the base source URL for endpoint discovery. */
function toSourceUrl(baseUrl: string): string {
  const u = baseUrl.replace(/\/+$/, "");
  return u.endsWith("/v1") ? u.slice(0, -3) : u;
}

function selectRandomEndpoint(endpoints: GonkaEndpoint[]): GonkaEndpoint {
  return endpoints[Math.floor(Math.random() * endpoints.length)];
}

// ---------------------------------------------------------------------------
// ECDSA signing (Phase 3 algorithm, matching Python SDK v0.2.4)
// ---------------------------------------------------------------------------

/** secp256k1 curve order */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const HALF_N = SECP256K1_N >> 1n;

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) {
    v = (v << 8n) + BigInt(b);
  }
  return v;
}

function bigIntToBytes32(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/**
 * Sign using the Phase 3 algorithm:
 *   payload_hash = SHA256(body).hexdigest()
 *   sig_input = payload_hash + str(timestamp) + transferAddress
 *   message = SHA256(sig_input)
 *   signature = ECDSA_sign(message, privateKey)
 */
async function gonkaSign(
  body: string,
  timestamp: bigint,
  transferAddress: string,
  privateKeyHex: string,
): Promise<string> {
  // Phase 3: hash payload first, then build signature input string
  const payloadHash = createHash("sha256").update(body, "utf8").digest("hex");
  const sigInput = payloadHash + timestamp.toString() + transferAddress;
  const messageHash = createHash("sha256").update(sigInput, "utf8").digest();

  // Sign with secp256k1 via @cosmjs/crypto (already a dependency of gonka-openai)
  const { Secp256k1 } = await import("@cosmjs/crypto");
  const privateKey = hexToBytes(privateKeyHex);
  const sig = Secp256k1.createSignature(new Uint8Array(messageHash), privateKey);

  // Extract r, s and apply low-S normalization
  const r = sig.r();
  const s = sig.s();
  const sBig = bytesToBigInt(s);
  const sNorm = sBig > HALF_N ? SECP256K1_N - sBig : sBig;

  // Pad r to 32 bytes
  const r32 = new Uint8Array(32);
  r32.set(r, 32 - r.length);

  const rawSig = new Uint8Array(64);
  rawSig.set(r32, 0);
  rawSig.set(bigIntToBytes32(sNorm), 32);

  return Buffer.from(rawSig).toString("base64");
}

/** Nanosecond timestamp */
function nanoTimestamp(): bigint {
  return BigInt(Date.now()) * 1000000n;
}

// ---------------------------------------------------------------------------
// vLLM body normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a chat-completions request body for vLLM compatibility:
 * - Flatten content-part arrays into plain strings
 * - Replace `max_completion_tokens` with `max_tokens`
 * - Remove unsupported fields (`stream_options`, `store`)
 */
function normalizeBodyForVLLM(body: Record<string, unknown>): void {
  const messages = body.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (
        msg &&
        typeof msg === "object" &&
        "content" in msg &&
        Array.isArray((msg as Record<string, unknown>).content)
      ) {
        const record = msg as Record<string, unknown>;
        const parts: string[] = [];
        for (const part of record.content as unknown[]) {
          if (
            part &&
            typeof part === "object" &&
            "text" in part &&
            typeof (part as Record<string, unknown>).text === "string"
          ) {
            parts.push((part as Record<string, unknown>).text as string);
          }
        }
        record.content = parts.join("");
      }
    }
  }

  if (body.max_completion_tokens !== undefined) {
    body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
  }

  delete body.stream_options;
  if (body.store !== undefined) {
    delete body.store;
  }

  // vLLM doesn't support tool_choice or tools without --enable-auto-tool-choice
  delete body.tool_choice;
  delete body.tools;
}

// ---------------------------------------------------------------------------
// Signing fetch wrapper
// ---------------------------------------------------------------------------

/**
 * Create a fetch wrapper that:
 * 1. Redirects requests to the selected Gonka endpoint URL
 * 2. Normalizes bodies for vLLM compatibility
 * 3. Signs requests with the Gonka ECDSA Phase 3 algorithm
 */
function createSignedFetch(
  privateKeyHex: string,
  address: string,
  transferAddress: string,
  endpointUrl: string,
  configuredBaseUrl: string,
): typeof globalThis.fetch {
  const original = globalThis.fetch;

  // Normalize URLs for comparison: strip trailing slashes
  const normalizedConfigBase = configuredBaseUrl.replace(/\/+$/, "");
  const normalizedEndpointUrl = endpointUrl.replace(/\/+$/, "");

  return async function signedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Rewrite URL to use the selected endpoint instead of the configured base
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else {
      url = input.url;
    }

    // Replace the configured base URL with the selected endpoint URL
    if (normalizedConfigBase && url.includes(normalizedConfigBase)) {
      url = url.replace(normalizedConfigBase, normalizedEndpointUrl);
    }

    let bodyStr = typeof init?.body === "string" ? init.body : undefined;

    // Normalize JSON bodies for vLLM
    if (bodyStr) {
      try {
        const parsed = JSON.parse(bodyStr) as Record<string, unknown>;
        if (parsed.messages) {
          normalizeBodyForVLLM(parsed);
          bodyStr = JSON.stringify(parsed);
        }
      } catch {
        // Not JSON — pass through
      }
    }

    // Sign the request
    const timestamp = nanoTimestamp();
    const headers = new Headers((init?.headers as HeadersInit) ?? {});
    headers.set("X-Requester-Address", address);
    headers.set("X-Timestamp", timestamp.toString());

    if (bodyStr) {
      const signature = await gonkaSign(bodyStr, timestamp, transferAddress, privateKeyHex);
      headers.set("Authorization", signature);
    }

    return original(url, {
      ...init,
      body: bodyStr ?? init?.body,
      headers,
    });
  };
}

// ---------------------------------------------------------------------------
// Gonka stream function factory
// ---------------------------------------------------------------------------

/**
 * Prepare the Gonka stream function asynchronously (resolves endpoints, derives
 * address, creates signed fetch).  Returns a synchronous stream function that
 * can be assigned to `agent.streamFn`.
 *
 * @param privateKey  ECDSA private key (hex, with or without 0x prefix)
 * @param baseUrl     Optional override; otherwise resolved from the network
 */
export async function initGonkaStream(
  privateKey: string,
  baseUrl?: string,
): Promise<
  <TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream
> {
  const { gonkaAddress: deriveAddress } = await import("gonka-openai");

  // Resolve real endpoints (with transfer addresses) from the network.
  const sourceUrl = baseUrl ? toSourceUrl(baseUrl) : undefined;
  const endpoints = await resolveGonkaEndpoints(sourceUrl);
  const endpoint = selectRandomEndpoint(endpoints);
  const transferAddress = endpoint.transferAddress ?? endpoint.address;

  const address = deriveAddress(privateKey);

  // The configured baseUrl (from model config) may differ from the selected
  // endpoint URL. The signedFetch must redirect requests to the selected
  // endpoint so the transfer address used for signing matches the node.
  const configuredBaseUrl = baseUrl ?? "";
  const signedFetch = createSignedFetch(
    privateKey,
    address,
    transferAddress,
    endpoint.url,
    configuredBaseUrl,
  );

  return function gonkaStream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = signedFetch;

    // streamSimple creates the OpenAI client synchronously, which captures the
    // current globalThis.fetch.  We can safely restore the original fetch right
    // after the call returns (the captured reference is kept internally by the
    // OpenAI SDK instance).
    const stream = streamSimple(model, context, options);
    globalThis.fetch = originalFetch;

    return stream;
  };
}

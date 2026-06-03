import { NextRequest, NextResponse } from 'next/server';
import { createHash, createPublicKey, verify as ed25519Verify } from 'crypto';

export const runtime = 'nodejs';

/**
 * fal.ai webhook receiver — called when a queued generation completes.
 *
 * Payload shape (from https://fal.ai/docs/model-endpoints/webhooks):
 *   {
 *     request_id: string,
 *     gateway_request_id: string,
 *     status: 'OK' | 'ERROR',
 *     payload: { images: [{ url, content_type, file_name, file_size, width, height }], seed },
 *     error?: string
 *   }
 *
 * Production checklist:
 *   1. [DONE] Verify the request signature against fal's ED25519 public keys
 *      (see verifyFalWebhook below). Unsigned / invalid requests get a 401.
 *   2. Persist {request_id → asset_url} in your DB / KV so the client can poll
 *      or subscribe via SSE / Pusher / Ably.
 *   3. Always return 200 quickly — fal retries non-2xx responses.
 */

const JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
const JWKS_TTL_MS = 24 * 60 * 60 * 1000; // fal recommends caching keys up to 24h
const MAX_CLOCK_SKEW_SECONDS = 300; // reject requests older/newer than ±5 min (replay protection)

let jwksCache: { keys: string[]; fetchedAt: number } | null = null;

/** Fetch fal's ED25519 public keys (base64url `x` values), cached for 24h. */
async function getFalPublicKeys(): Promise<string[]> {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(JWKS_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to fetch fal JWKS: ${res.status}`);
  const jwks = (await res.json()) as { keys?: Array<{ x?: string }> };
  const keys = (jwks.keys ?? []).map((k) => k.x).filter((x): x is string => Boolean(x));
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
}

/**
 * Verify a fal.ai webhook per https://fal.ai/docs/model-endpoints/webhooks.
 *
 * Signed message = `${requestId}\n${userId}\n${timestamp}\n${sha256hex(body)}`
 * signed with ED25519; signature delivered as hex in X-Fal-Webhook-Signature.
 */
async function verifyFalWebhook(req: NextRequest, rawBody: string): Promise<boolean> {
  const requestId = req.headers.get('x-fal-webhook-request-id');
  const userId = req.headers.get('x-fal-webhook-user-id');
  const timestamp = req.headers.get('x-fal-webhook-timestamp');
  const signatureHex = req.headers.get('x-fal-webhook-signature');

  if (!requestId || !userId || !timestamp || !signatureHex) return false;

  // 1. Reject stale/future timestamps to blunt replay attacks.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > MAX_CLOCK_SKEW_SECONDS) {
    return false;
  }

  // 2. Rebuild the exact signed message.
  const bodyHashHex = createHash('sha256').update(rawBody, 'utf8').digest('hex');
  const message = Buffer.from(`${requestId}\n${userId}\n${timestamp}\n${bodyHashHex}`, 'utf8');

  const signature = Buffer.from(signatureHex, 'hex');
  if (signature.length !== 64) return false; // ED25519 signatures are 64 bytes

  // 3. Accept if any current fal public key verifies the signature.
  let keys: string[];
  try {
    keys = await getFalPublicKeys();
  } catch {
    return false; // fail closed if keys can't be fetched
  }

  for (const x of keys) {
    try {
      const publicKey = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x },
        format: 'jwk',
      });
      if (ed25519Verify(null, message, publicKey, signature)) return true;
    } catch {
      // malformed key — try the next one
    }
  }
  return false;
}

export async function POST(req: NextRequest) {
  // Read the raw body once — needed verbatim for signature hashing.
  const rawBody = await req.text();

  const verified = await verifyFalWebhook(req, rawBody);
  if (!verified) {
    return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
  }

  let body: {
    request_id?: string;
    gateway_request_id?: string;
    status?: 'OK' | 'ERROR';
    payload?: { images?: Array<{ url?: string }>; seed?: number };
    error?: string;
  };

  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const chapterId = req.nextUrl.searchParams.get('chapter') ?? 'unknown';
  const imageUrl = body.payload?.images?.[0]?.url;

  // TODO(you): persist this to your storage layer.
  // Example with @vercel/kv:
  //   await kv.set(`asset:${chapterId}`, { url: imageUrl, requestId: body.request_id });
  console.log('[fal-webhook]', {
    chapterId,
    requestId: body.request_id,
    status: body.status,
    url: imageUrl,
    error: body.error,
  });

  return NextResponse.json({ received: true });
}

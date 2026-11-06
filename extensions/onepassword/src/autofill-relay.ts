import { webcrypto } from "node:crypto";
import { z } from "zod";

const subtle = webcrypto.subtle;
const text = new TextEncoder();
const publicKey = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string(),
    y: z.string(),
  })
  .strict();
const envelopeSchema = z
  .object({
    v: z.literal(1),
    alg: z.literal("ECDH-ES+HKDF-SHA256+A256GCM"),
    purpose: z.enum(["integration_key", "tokens"]),
    epk: publicKey,
    iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ct: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
type SealedEnvelope = z.infer<typeof envelopeSchema>;
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive().max(86_400),
  scope: z.string(),
  user_id: z.string().min(1).optional(),
});
export type AutofillTokens = z.infer<typeof tokenSchema>;
const sessionSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  connectUrl: z.string().url(),
  confirmationCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/),
  pickupToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.string().datetime(),
});
export type RelaySession = z.infer<typeof sessionSchema> & { privateKey: webcrypto.CryptoKey };
export type Pickup =
  | { state: "pending" }
  | { state: "failed"; error: string }
  | { state: "connected"; tokens: AutofillTokens; integrationKey: string | null };

/** Safe fixed diagnostic; upstream bodies and cryptographic errors never become tool text. */
export class AutofillError extends Error {
  constructor(readonly code: string) {
    super(`1Password Agentic Autofill: ${code}.`);
    this.name = "AutofillError";
  }
}

/** Open the exact v1 relay envelope; purpose and session are authenticated, not inferred. */
async function openRelayEnvelope(
  input: unknown,
  privateKey: webcrypto.CryptoKey,
  sessionId: string,
  purpose: SealedEnvelope["purpose"],
): Promise<string> {
  try {
    const envelope = envelopeSchema.parse(input);
    if (envelope.purpose !== purpose) {
      throw new AutofillError("invalidEnvelope");
    }
    const peer = await subtle.importKey(
      "jwk",
      envelope.epk,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
    const secret = await subtle.deriveBits({ name: "ECDH", public: peer }, privateKey, 256);
    const material = await subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"]);
    const key = await subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: new Uint8Array(),
        info: text.encode(`openclaw-connect/v1/${purpose}`),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const plaintext = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(envelope.iv, "base64url"),
        additionalData: text.encode(`${sessionId}\n${purpose}`),
        tagLength: 128,
      },
      key,
      Buffer.from(envelope.ct, "base64url"),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    throw new AutofillError("invalidEnvelope");
  }
}

/** Fixed-origin relay client. No OAuth secret ships in OpenClaw. */
export class AutofillRelayClient {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  // Never include upstream response text, request bodies, or URLs in an error.
  private async request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    try {
      return await this.fetcher(url, {
        ...init,
        redirect: "error",
        cache: "no-store",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      throw new AutofillError("networkError");
    }
  }

  /** Begin one session with a nonextractable Gateway private key. */
  async create(signal?: AbortSignal): Promise<RelaySession> {
    const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, [
      "deriveBits",
    ]);
    const exported = await subtle.exportKey("jwk", pair.publicKey);
    const response = await this.request(
      "https://connect.openclaw.ai/1password/v1/sessions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          gatewayPublicKey: publicKey.parse({
            kty: exported.kty,
            crv: exported.crv,
            x: exported.x,
            y: exported.y,
          }),
        }),
      },
      signal,
    );
    if (response.status !== 201) {
      throw new AutofillError(response.status === 429 ? "rateLimited" : "connectFailed");
    }
    try {
      const session = sessionSchema.parse(await response.json());
      if (
        session.connectUrl !== `https://connect.openclaw.ai/1password/start/${session.sessionId}`
      ) {
        throw new AutofillError("invalidRelayResponse");
      }
      return { ...session, privateKey: pair.privateKey };
    } catch {
      throw new AutofillError("invalidRelayResponse");
    }
  }

  /** Pick up once; the relay consumes a completed session, so failures are not retried blindly. */
  async pickup(session: RelaySession, signal?: AbortSignal): Promise<Pickup> {
    const response = await this.request(
      `https://connect.openclaw.ai/1password/v1/sessions/${session.sessionId}`,
      { headers: { authorization: `Bearer ${session.pickupToken}` } },
      signal,
    );
    if (response.status !== 200 && response.status !== 202) {
      throw new AutofillError(response.status === 429 ? "rateLimited" : "pickupUnavailable");
    }
    try {
      const body = z
        .discriminatedUnion("state", [
          z.object({ state: z.literal("pending") }),
          z.object({ state: z.literal("failed"), error: z.string() }),
          z.object({
            state: z.literal("connected"),
            sealedTokens: envelopeSchema,
            sealedIntegrationKey: envelopeSchema.nullable(),
          }),
        ])
        .parse(await response.json());
      if (body.state !== "connected") {
        return body.state === "pending" ? body : { state: "failed", error: "connectDeclined" };
      }
      const integrationKey =
        body.sealedIntegrationKey === null
          ? null
          : await openRelayEnvelope(
              body.sealedIntegrationKey,
              session.privateKey,
              session.sessionId,
              "integration_key",
            );
      const tokens = tokenSchema.parse(
        JSON.parse(
          await openRelayEnvelope(
            body.sealedTokens,
            session.privateKey,
            session.sessionId,
            "tokens",
          ),
        ),
      );
      return { state: "connected", tokens, integrationKey };
    } catch {
      throw new AutofillError("invalidRelayResponse");
    }
  }

  /** Rotate through the relay; invalid_grant is terminal and never retried. */
  async refresh(refreshToken: string, signal?: AbortSignal): Promise<AutofillTokens> {
    const response = await this.request(
      "https://connect.openclaw.ai/1password/v1/token/refresh",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      },
      signal,
    );
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (z.object({ error: z.literal("invalid_grant") }).safeParse(body).success) {
        throw new AutofillError("reconnectRequired");
      }
      throw new AutofillError(response.status === 429 ? "rateLimited" : "refreshFailed");
    }
    const tokens = tokenSchema.safeParse(body);
    if (!tokens.success) {
      throw new AutofillError("invalidRelayResponse");
    }
    return tokens.data;
  }

  /** Revoke directly with 1Password; callers delete local state only after success. */
  async revoke(accessToken: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(
      "https://api.1password.com/v1alpha1/oauth-integrations/self:revoke",
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: "{}",
      },
      signal,
    );
    if (!response.ok) {
      throw new AutofillError("revokeFailed");
    }
  }
}

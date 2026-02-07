import { SignJWT, jwtVerify } from "jose";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";

export type RuntimeJwtPayload = Record<string, unknown>;

type RuntimeJwk = JsonWebKey & {
  kid?: string;
  use?: string;
  alg?: string;
};

export type RuntimeJwtSigner = {
  kid: string;
  mint: (params: {
    subject: string;
    audiences: string[];
    scope: string;
    ttlSec: number;
    nowMs?: number;
  }) => Promise<string>;
  verify: (params: {
    token: string;
    audience: string;
    nowMs?: number;
  }) => Promise<{ ok: true; payload: RuntimeJwtPayload } | { ok: false; error: string }>;
  jwks: () => { keys: RuntimeJwk[] };
};

function deriveKid(publicKey: ReturnType<typeof createPublicKey>): string {
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return createHash("sha256").update(spki).digest("hex").slice(0, 16);
}

function resolvePrivateKey() {
  const configured = process.env.MUX_JWT_PRIVATE_KEY?.trim();
  if (configured) {
    return createPrivateKey(configured);
  }
  return generateKeyPairSync("ed25519").privateKey;
}

export function hasScope(scope: unknown, expected: string): boolean {
  if (typeof scope !== "string") {
    return false;
  }
  return scope
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .includes(expected);
}

export function createRuntimeJwtSigner(): RuntimeJwtSigner {
  const privateKey = resolvePrivateKey();
  const publicKey = createPublicKey(privateKey);
  const kid = deriveKid(publicKey);
  const rawJwk = publicKey.export({ format: "jwk" }) as RuntimeJwk;
  const jwk: RuntimeJwk = {
    ...rawJwk,
    kid,
    use: "sig",
    alg: "EdDSA",
  };

  return {
    kid,
    mint: async (params) => {
      const nowSec = Math.trunc((params.nowMs ?? Date.now()) / 1000);
      return await new SignJWT({ scope: params.scope })
        .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid })
        .setSubject(params.subject)
        .setAudience(params.audiences)
        .setIssuedAt(nowSec)
        .setNotBefore(nowSec)
        .setExpirationTime(nowSec + Math.max(1, Math.trunc(params.ttlSec)))
        .sign(privateKey);
    },
    verify: async (params) => {
      try {
        const { payload } = await jwtVerify(params.token, publicKey, {
          audience: params.audience,
          clockTolerance: 60,
          currentDate: new Date(params.nowMs ?? Date.now()),
        });
        return { ok: true, payload: payload as RuntimeJwtPayload };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    },
    jwks: () => ({ keys: [jwk] }),
  };
}

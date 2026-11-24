import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

export type ShellgateCredential = {
  subject: string;
  digest: string;
  createdAt: number;
  rotatedAt?: number;
};

export const CREDENTIAL_STORE_OPTIONS = {
  namespace: "credentials",
  maxEntries: 1000,
  overflowPolicy: "reject-new",
} as const;

const CREDENTIAL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BEARER = /^Bearer +(sg_([0-9a-f-]{36})[.][A-Za-z0-9_-]{43})$/iu;

function credentialId(value: unknown): string {
  if (typeof value !== "string" || !CREDENTIAL_ID.test(value)) {
    throw new Error("Expected a credential id from shellgate list.");
  }
  return value;
}

function issueToken(id: string) {
  const token = `sg_${id}.${randomBytes(32).toString("base64url")}`;
  return { token, digest: createHash("sha256").update(token).digest("hex") };
}

/** Credential bindings only: profile creation, identity links, and roles belong to the Gateway. */
export class ShellgateCredentials {
  constructor(private readonly store: PluginStateKeyedStore<ShellgateCredential, 2>) {}

  async issue(subject: unknown) {
    // Generic trusted-proxy profile aliases are case-folded by the Gateway.
    // Require canonical subjects instead of silently changing an existing binding.
    if (
      typeof subject !== "string" ||
      !/^[!-~]{1,256}$/u.test(subject) ||
      subject !== subject.toLowerCase()
    ) {
      throw new Error(
        "Subject must be 1–256 printable ASCII characters without spaces, in lowercase.",
      );
    }
    const id = randomUUID();
    const { token, digest } = issueToken(id);
    const createdAt = Date.now();
    if (!(await this.store.registerIfAbsent(id, { subject, digest, createdAt }))) {
      throw new Error("Credential id collision; no credential was issued. Try again.");
    }
    return { id, subject, createdAt, token };
  }

  async list() {
    return (await this.store.entries()).map(({ key, value }) => ({
      id: key,
      subject: value.subject,
      createdAt: value.createdAt,
      rotatedAt: value.rotatedAt,
    }));
  }

  async rotate(value: unknown) {
    const id = credentialId(value);
    const observed = await this.store.observe(id);
    if (!observed.value) {
      throw new Error("Credential not found; list credentials before rotating.");
    }
    const { token, digest } = issueToken(id);
    const rotatedAt = Date.now();
    const result = await this.store.compareAndApply(id, observed.comparison, {
      operation: "update",
      action: "set",
      value: { ...observed.value, digest, rotatedAt },
    });
    if (result.status !== "applied") {
      throw new Error("Credential changed during rotation; list credentials before retrying.");
    }
    return { id, subject: observed.value.subject, rotatedAt, token };
  }

  async revoke(value: unknown) {
    const id = credentialId(value);
    return { id, revoked: await this.store.delete(id) };
  }

  async authenticate(authorization: string | undefined): Promise<string | undefined> {
    const match = authorization?.match(BEARER);
    const token = match?.[1];
    const id = match?.[2];
    if (!token || !id || !CREDENTIAL_ID.test(id)) {
      return undefined;
    }
    const credential = await this.store.lookup(id);
    if (!credential) {
      return undefined;
    }
    const actual = createHash("sha256").update(token).digest();
    const expected = Buffer.from(credential.digest, "hex");
    return expected.length === actual.length && timingSafeEqual(actual, expected)
      ? credential.subject
      : undefined;
  }
}

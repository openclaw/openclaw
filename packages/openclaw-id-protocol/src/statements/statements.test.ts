import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/v1-draft/statements.json" with { type: "json" };
import { bytesToHex, utf8 } from "../bytes.js";
import { canonicalize, type JsonValue } from "../jcs.js";
import { displayFingerprint, fingerprint, isIrohEndpointKey } from "../keys.js";
import { decodeKit, deriveRootSeed } from "../kit.js";
import { buildStatementVectors, type StatementVectors } from "../testing/vectors.js";
import { signingInput, statementDomain } from "./envelope.js";
import { verifyBindingForPin } from "./pin.js";
import type { SignedStatement } from "./types.js";
import { parseStatement } from "./validate.js";
import {
  verifyInviteRedemptionSignature,
  verifyMembershipSnapshot,
  verifyOwnerStatement,
  verifyRootRotation,
  type TrustAnchor,
  type VerifyOptions,
} from "./verify.js";

const vectors = fixture as unknown as StatementVectors;
const options: VerifyOptions = { now: vectors.now };
const binding = vectors.valid.find((entry) => entry.statement.type === "ServerBinding")!
  .statement as SignedStatement<"ServerBinding">;

// Runs the verifier a vector names and returns ok or the failure code.
async function verify(
  verifier: string,
  statement: SignedStatement,
  anchor: TrustAnchor,
): Promise<string> {
  const result =
    verifier === "rotation"
      ? await verifyRootRotation(statement as SignedStatement<"RootRotation">, anchor)
      : verifier === "snapshot"
        ? await verifyMembershipSnapshot(
            statement as SignedStatement<"MembershipSnapshot">,
            binding.body,
          )
        : verifier === "redemption"
          ? await verifyInviteRedemptionSignature(statement as SignedStatement<"InviteRedemption">)
          : await verifyOwnerStatement(
              statement as SignedStatement<"OwnerDeviceCert">,
              anchor,
              options,
            );
  return result.ok ? "ok" : result.code;
}

describe("statement vectors", () => {
  it("fixture is exactly what the builder produces (deterministic Ed25519)", async () => {
    const built = await buildStatementVectors();
    expect(canonicalize(built as unknown as JsonValue)).toBe(
      canonicalize(fixture as unknown as JsonValue),
    );
  });

  it("derives R from the kit and shows its fingerprint", async () => {
    const secret = await decodeKit(vectors.kit.text);
    expect(bytesToHex(secret)).toBe(vectors.kit.secret_hex);
    expect(bytesToHex(await deriveRootSeed(secret))).toBe(vectors.kit.root_seed_hex);
    expect(await fingerprint(vectors.kit.root_pub)).toBe(vectors.kit.root_fp);
    expect(displayFingerprint(vectors.kit.root_fp as `fp:${string}`)).toMatch(
      /^([0-9A-Z]{5}-){3}[0-9A-Z]{5}$/,
    );
  });

  it("canonicalizes the JCS cases", () => {
    for (const entry of vectors.jcs) {
      expect(canonicalize(entry.input as JsonValue)).toBe(entry.canonical);
    }
  });

  it.each(vectors.valid.map((entry) => [entry.name, entry] as const))(
    "valid: %s",
    async (_name, entry) => {
      expect(parseStatement(entry.statement)).toMatchObject({ ok: true });
      expect(bytesToHex(signingInput(entry.statement.type, entry.statement.body as never))).toBe(
        entry.signing_input_hex,
      );
      await expect(verify(entry.verifier, entry.statement, vectors.anchor)).resolves.toBe("ok");
    },
  );

  it.each(vectors.invalid.map((entry) => [entry.name, entry] as const))(
    "invalid: %s",
    async (_name, entry) => {
      expect(parseStatement(entry.statement)).toMatchObject({ ok: true });
      await expect(
        verify(entry.verifier, entry.statement, entry.anchor ?? vectors.anchor),
      ).resolves.toBe(entry.expected_error);
    },
  );

  it.each(vectors.pins.map((entry) => [entry.name, entry] as const))(
    "pin: %s",
    async (_name, entry) => {
      const result = await verifyBindingForPin(entry.evidence, entry.pin, {
        ...options,
        host: entry.host,
      });
      expect(result.ok ? { ok: true, pin: result.pin } : { ok: false, error: result.code }).toEqual(
        entry.expected,
      );
    },
  );
});

describe("envelope", () => {
  it("prefixes the signing input with the type domain and a NUL", () => {
    const input = signingInput("Revocation", vectors.valid[7]!.statement.body as never);
    expect(new TextDecoder().decode(input.slice(0, statementDomain("Revocation").length))).toBe(
      "openclaw/Revocation/v1\0",
    );
    expect(utf8("openclaw/Revocation/v1\0").at(-1)).toBe(0);
  });
});

describe("parseStatement", () => {
  const cert = vectors.valid[0]!.statement;

  it("rejects unknown fields, uppercase keys, nested chains and wrong types", () => {
    expect(parseStatement({ ...cert, extra: 1 })).toMatchObject({ ok: false, code: "malformed" });
    expect(parseStatement({ ...cert, signer: cert.signer.toUpperCase() })).toMatchObject({
      ok: false,
    });
    expect(parseStatement({ ...cert, alg: "p256" })).toMatchObject({ ok: false });
    expect(parseStatement(cert, "ServerBinding")).toMatchObject({ ok: false });
    const nested = vectors.valid[2]!.statement;
    const link = { ...nested.chain[0]!, chain: nested.chain.slice(1) };
    expect(parseStatement({ ...nested, chain: [link] })).toMatchObject({
      ok: false,
      detail: expect.stringContaining("nested"),
    });
  });

  it("accepts lowercase iroh endpoint keys only", () => {
    const key = vectors.keys.server!.iroh;
    expect(isIrohEndpointKey(key)).toBe(true);
    expect(isIrohEndpointKey(key.toUpperCase())).toBe(false);
    expect(isIrohEndpointKey(`iroh:${key.slice(5, 69)}0`)).toBe(false);
  });
});

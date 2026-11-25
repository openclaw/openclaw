import { bytesToBase64url, concatBytes, utf8 } from "../bytes.js";
// ClawUnlink vectors: the vector claw's Gateway unlinks it at binding 2. Discovery checks a
// ClawUnlink against binding 2; a client checks it against the pin that stored binding 2's K_gw.
import type { StatementSigner } from "../crypto.js";
import { canonicalize } from "../jcs.js";
import { signStatement, statementDomain } from "../statements/envelope.js";
import type { ClawPin } from "../statements/pin.js";
import type { SignedStatement } from "../statements/types.js";
import type { VerifyErrorCode } from "../statements/verify.js";
import type { InvalidStatementVector } from "./vectors.js";

/** One pinned client check of a ClawUnlink served with Discovery's `unlinked` error. */
export type UnlinkPinVector = {
  name: string;
  pin: ClawPin;
  statement: SignedStatement<"ClawUnlink">;
  expected: { ok: true } | { ok: false; error: VerifyErrorCode };
};

/** The valid unlink, the unlinks Discovery refuses and the client pin checks. */
export async function buildUnlinkVectors(input: {
  clawId: string;
  gateway: StatementSigner;
  mallory: StatementSigner;
  /** Pin after verifying binding 2, with its K_gw. */
  keyedPin: ClawPin;
  /** The same pin without `k_gw`. */
  seenPin: ClawPin;
}): Promise<{
  statement: SignedStatement<"ClawUnlink">;
  invalid: InvalidStatementVector[];
  pins: UnlinkPinVector[];
}> {
  const body = { claw_id: input.clawId, binding_seq: 2 };
  const sign = (signer: StatementSigner, change: Partial<typeof body> = {}) =>
    signStatement("ClawUnlink", { ...body, ...change }, signer);
  const unlink = await sign(input.gateway);
  const forged = await sign(input.mallory);
  const otherClaw = await sign(input.gateway, { claw_id: "f".repeat(32) });
  const older = await sign(input.gateway, { binding_seq: 1 });
  const ahead = await sign(input.gateway, { binding_seq: 3 });
  // Named signer is K_gw, but the signature is over another body or another type's domain.
  const corrupted = { ...unlink, sig: older.sig };
  const crossType = {
    ...unlink,
    sig: bytesToBase64url(
      await input.gateway.sign(
        concatBytes(utf8(statementDomain("RootReset")), utf8(canonicalize(body))),
      ),
    ),
  };
  const refused = (
    name: string,
    statement: SignedStatement<"ClawUnlink">,
    expected_error: VerifyErrorCode,
  ): InvalidStatementVector => ({ name, verifier: "unlink", statement, expected_error });
  const pin = (
    name: string,
    pinned: ClawPin,
    statement: SignedStatement<"ClawUnlink">,
    expected: UnlinkPinVector["expected"],
  ): UnlinkPinVector => ({ name, pin: pinned, statement, expected });
  return {
    statement: unlink,
    invalid: [
      refused("unlink not signed by K_gw", forged, "wrong_signer"),
      refused("unlink for another claw", otherClaw, "wrong_claw"),
      refused("unlink replayed from an older binding", older, "rollback"),
      refused("unlink for a binding that was never published", ahead, "not_yet_valid"),
      refused("unlink from K_gw with a signature over another body", corrupted, "bad_signature"),
      refused("unlink signed under another statement type", crossType, "bad_signature"),
    ],
    pins: [
      pin("unlink signed by the pinned K_gw", input.keyedPin, unlink, { ok: true }),
      pin("unlink for a later binding than the pin has seen", input.keyedPin, ahead, { ok: true }),
      pin("unlink not signed by the pinned K_gw", input.keyedPin, forged, {
        ok: false,
        error: "wrong_signer",
      }),
      pin("unlink seen by a pin that never stored K_gw", input.seenPin, unlink, {
        ok: false,
        error: "wrong_signer",
      }),
      pin("unlink from the pinned K_gw with a bad signature", input.keyedPin, corrupted, {
        ok: false,
        error: "bad_signature",
      }),
      pin("unlink signed under another statement type", input.keyedPin, crossType, {
        ok: false,
        error: "bad_signature",
      }),
      pin("unlink for another claw", input.keyedPin, otherClaw, {
        ok: false,
        error: "wrong_claw",
      }),
      pin("unlink for a binding older than the pin", input.keyedPin, older, {
        ok: false,
        error: "rollback",
      }),
    ],
  };
}

// Owner-key regeneration (owner-key spec section 8.3): the local operator, at the
// running Gateway on direct loopback, replaces the owner root. It is the only way to
// end every owner key at once, and the way out of a conflicting-rotation freeze.
import type { Ed25519PublicKey } from "../keys.js";
import type { SignedStatement } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import { repinRoot, submitStatement, type WriteContext } from "./apply.js";
import { ownerDevicePeerKeys, refuse, type AuthorityResult, type AuthorityState } from "./state.js";

/** What the regenerating device sends: the new root R' and its own enrollment under R'. */
export type OwnerKeyRegenerationInput = {
  root_pub: Ed25519PublicKey;
  /** MembershipChange { op: add_owner_device } at the next seq, signed by R' alone. */
  owner_device: unknown;
};

/**
 * Regenerates the owner key: pins R' in a new epoch, clears a freeze, forgets every
 * owner device of earlier epochs and enrolls the regenerating device as the first
 * owner device under R'. Members, invites and revocations are kept. The events end
 * the old owner devices' sessions and tokens and republish. Direct loopback only.
 */
export async function regenerateOwnerKey(
  state: AuthorityState,
  input: OwnerKeyRegenerationInput,
  context: WriteContext,
): Promise<AuthorityResult> {
  if (context.channel !== "local_operator") {
    return refuse(
      state,
      "not_local_operator",
      "owner-key regeneration needs direct loopback on the running Gateway",
    );
  }
  if (Object.values(state.root_history).includes(input.root_pub)) {
    return refuse(state, "root_reused", "the new owner key must not be a root this claw has used");
  }
  const parsed = parseStatement(input.owner_device, "MembershipChange");
  if (!parsed.ok) {
    return refuse(state, "malformed", parsed.detail);
  }
  const change = parsed.statement as SignedStatement<"MembershipChange">;
  if (change.body.target.op !== "add_owner_device" || change.signer !== input.root_pub) {
    return refuse(
      state,
      "target_mismatch",
      "regeneration enrolls one owner device, certified by the new root",
    );
  }
  const repinned = repinRoot(state, input.root_pub, context.channel);
  if (!repinned.ok) {
    return repinned;
  }
  const ended = ownerDevicePeerKeys(state);
  // Old-epoch certificates can never verify again; dropping them keeps listings honest.
  const added = await submitStatement({ ...repinned.state, owner_devices: {} }, change, context);
  if (!added.ok) {
    return refuse(state, added.code, `owner device: ${added.detail}`);
  }
  return {
    ok: true,
    status: "applied",
    state: added.state,
    events: [
      { type: "disconnect", peer_keys: ended },
      { type: "invalidate_tokens", peer_keys: ended },
      { type: "publish_snapshot" },
    ],
  };
}

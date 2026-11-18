import { parseClawDescriptor } from "../discovery/descriptor.js";
import {
  displayFingerprint,
  fingerprint,
  formatEd25519PublicKey,
  type Ed25519PublicKey,
  type IrohEndpointKey,
} from "../keys.js";
// Signing a re-bind (enrollment.md, "Re-bind") with the owner root R derived from the recovery
// kit, where the kit is typed: the CLI (`openclaw id rebind`) and the local Control UI ("Move to
// new keys"). The Gateway stages the keys and stores the binding; R never reaches it.
import { decodeKit, deriveRootSigner } from "../kit.js";
import { signStatement } from "../statements/envelope.js";
import { verifyBindingForPin } from "../statements/pin.js";
import type { ROOT_EPOCH, SignedStatement } from "../statements/types.js";

/** What `openclawId.authority { action: "rebind_prepare" }` returns. */
export type RebindPreparation = {
  claw_id: string;
  hostname: string;
  root_pub: Ed25519PublicKey;
  k_srv: IrohEndpointKey;
  k_gw: Ed25519PublicKey;
  binding_seq: number;
  root_epoch: typeof ROOT_EPOCH;
  current: { k_srv: IrohEndpointKey; k_gw: Ed25519PublicKey; binding_seq: number };
  /** Discovery's published descriptor (untrusted), or why it could not be read. */
  published: { descriptor: unknown } | { error: string; detail: string };
};

/** Why nothing is signed. */
export type RebindSignRefusal =
  | { ok: false; code: "wrong_kit"; kitRoot: string }
  | { ok: false; code: "published_unverifiable"; detail: string }
  | { ok: false; code: "published_unavailable"; detail: string; atLeast: number }
  | { ok: false; code: "binding_seq_too_low"; atLeast: number };

/**
 * The binding_seq to sign: one above the higher of this machine's binding and the binding
 * Discovery publishes, once that verified under the root (it is higher after a restore from an
 * older backup). Unverifiable published data is refused, never used. `override` replaces the
 * choice when Discovery cannot be read, and must be above every binding known to be verified.
 */
async function chooseBindingSeq(
  prep: RebindPreparation,
  rootPub: Ed25519PublicKey,
  now: number,
  override: number | undefined,
): Promise<{ ok: true; bindingSeq: number } | RebindSignRefusal> {
  let published = 0;
  let unreadable: RebindSignRefusal | undefined;
  if ("descriptor" in prep.published) {
    const parsed = parseClawDescriptor(prep.published.descriptor);
    const checked = parsed.ok
      ? await verifyBindingForPin(
          { root_pub: parsed.descriptor.root_pub, binding: parsed.descriptor.binding },
          { claw_id: prep.claw_id, root_fp: await fingerprint(rootPub), binding_seq: 0 },
          { now, host: prep.hostname },
        )
      : { ok: false as const, code: parsed.code, detail: parsed.detail };
    if (!checked.ok) {
      unreadable = {
        ok: false,
        code: "published_unverifiable",
        detail: `Discovery's published binding does not verify under this kit (${checked.code})`,
      };
    } else {
      published = checked.binding.binding_seq;
    }
  } else if (prep.published.error !== "not_found") {
    unreadable = {
      ok: false,
      code: "published_unavailable",
      detail: prep.published.detail,
      atLeast: prep.current.binding_seq + 1,
    };
  }
  const atLeast = Math.max(prep.current.binding_seq, published) + 1;
  if (override !== undefined) {
    return override >= atLeast
      ? { ok: true, bindingSeq: override }
      : { ok: false, code: "binding_seq_too_low", atLeast };
  }
  return unreadable ?? { ok: true, bindingSeq: atLeast };
}

/**
 * Derives R from the kit and signs the prepared binding. A kit for another claw signs
 * nothing: its root's fingerprint is returned so the operator can tell kits apart.
 */
export async function signRebind(
  prep: RebindPreparation,
  kitText: string,
  options: { bindingSeq?: number; now?: number } = {},
): Promise<{ ok: true; binding: SignedStatement<"ServerBinding"> } | RebindSignRefusal> {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const secret = await decodeKit(kitText.trim());
  try {
    const root = await deriveRootSigner(secret);
    const rootPub = formatEd25519PublicKey(root.publicKey);
    if (rootPub !== prep.root_pub) {
      return {
        ok: false,
        code: "wrong_kit",
        kitRoot: displayFingerprint(await fingerprint(rootPub)),
      };
    }
    const seq = await chooseBindingSeq(prep, rootPub, now, options.bindingSeq);
    if (!seq.ok) {
      return seq;
    }
    const binding = await signStatement(
      "ServerBinding",
      {
        claw_id: prep.claw_id,
        hostname: prep.hostname,
        k_srv: prep.k_srv,
        k_gw: prep.k_gw,
        binding_seq: seq.bindingSeq,
        root_epoch: prep.root_epoch,
        issued_at: now,
      },
      root,
    );
    return { ok: true, binding };
  } finally {
    secret.fill(0);
  }
}

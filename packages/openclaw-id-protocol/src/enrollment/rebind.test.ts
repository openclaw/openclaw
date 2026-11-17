import { describe, expect, it } from "vitest";
import {
  deriveRootSigner,
  encodeKit,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  generateKitSecret,
  randomBytes,
  ROOT_EPOCH,
  signStatement,
  verifyOwnerStatement,
  type IrohEndpointKey,
  type StatementSigner,
} from "../index.js";
import { signRebind, type RebindPreparation } from "./rebind.js";

const now = () => Math.floor(Date.now() / 1000);
const key = () => formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
const gw = () => formatEd25519PublicKey(randomBytes(32));

// A claw at binding 1 on this machine; `published` is what Discovery answered for its code.
async function preparation(
  root: StatementSigner,
  published: RebindPreparation["published"] = { error: "not_found", detail: "not registered" },
): Promise<RebindPreparation> {
  return {
    claw_id: "c".repeat(32),
    hostname: "studio-k7x2q.claws.example.test",
    root_pub: formatEd25519PublicKey(root.publicKey),
    k_srv: key(),
    k_gw: gw(),
    binding_seq: 2,
    root_epoch: ROOT_EPOCH,
    current: { k_srv: key(), k_gw: gw(), binding_seq: 1 },
    published,
  };
}

// Discovery's descriptor for that claw with a binding at `seq`, signed by `signer`.
async function publishedAt(prep: RebindPreparation, seq: number, signer: StatementSigner) {
  const binding = await signStatement(
    "ServerBinding",
    {
      claw_id: prep.claw_id,
      hostname: prep.hostname,
      k_srv: key(),
      k_gw: gw(),
      binding_seq: seq,
      root_epoch: ROOT_EPOCH,
      issued_at: now() - 60,
    },
    signer,
  );
  return {
    descriptor: {
      v: 1,
      claw_id: prep.claw_id,
      transport: "iroh",
      relay_url: "https://relay.example.test/",
      root_pub: prep.root_pub,
      binding,
      published_at: now(),
    },
  };
}

async function kit() {
  const secret = generateKitSecret();
  return { text: await encodeKit(secret), root: await deriveRootSigner(secret) };
}

describe("re-bind signing", () => {
  it("signs the binding with the root derived from the kit", async () => {
    const { text, root } = await kit();
    const prep = await preparation(root);
    const signed = await signRebind(prep, `  ${text}\n`);
    if (!signed.ok) {
      throw new Error("refused");
    }
    expect(signed.binding.body).toMatchObject({
      claw_id: prep.claw_id,
      hostname: prep.hostname,
      k_srv: prep.k_srv,
      k_gw: prep.k_gw,
      binding_seq: 2,
    });
    expect(
      await verifyOwnerStatement(signed.binding, { root_pub: prep.root_pub }, { now: now() }),
    ).toMatchObject({ ok: true });
  });

  it("refuses a kit for another claw and signs nothing", async () => {
    const prep = await preparation((await kit()).root);
    expect(await signRebind(prep, (await kit()).text)).toMatchObject({
      ok: false,
      code: "wrong_kit",
      kitRoot: expect.stringMatching(/^[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}-[0-9A-Z]{5}$/),
    });
  });

  it("signs above Discovery's verified binding after a restore from an older backup", async () => {
    const { text, root } = await kit();
    const prep = await preparation(root);
    prep.published = await publishedAt(prep, 7, root);
    expect(await signRebind(prep, text)).toMatchObject({
      ok: true,
      binding: { body: { binding_seq: 8 } },
    });
  });

  it("refuses Discovery data that does not verify under the kit and never uses it", async () => {
    const { text, root } = await kit();
    const prep = await preparation(root);
    prep.published = await publishedAt(prep, 99, await generateEd25519Signer());
    expect(await signRebind(prep, text)).toMatchObject({
      ok: false,
      code: "published_unverifiable",
    });
    // An explicit number above this machine's binding is the way out.
    expect(await signRebind(prep, text, { bindingSeq: 3 })).toMatchObject({
      ok: true,
      binding: { body: { binding_seq: 3 } },
    });
  });

  it("needs --binding-seq when Discovery cannot be read, and refuses one at or below a verified binding", async () => {
    const { text, root } = await kit();
    const prep = await preparation(root, { error: "unavailable", detail: "fetch failed" });
    expect(await signRebind(prep, text)).toMatchObject({
      ok: false,
      code: "published_unavailable",
      atLeast: 2,
    });
    expect(await signRebind(prep, text, { bindingSeq: 1 })).toMatchObject({
      ok: false,
      code: "binding_seq_too_low",
    });
    prep.published = await publishedAt(prep, 7, root);
    expect(await signRebind(prep, text, { bindingSeq: 7 })).toMatchObject({
      ok: false,
      code: "binding_seq_too_low",
      atLeast: 8,
    });
    expect(await signRebind(prep, text, { bindingSeq: 9 })).toMatchObject({ ok: true });
  });
});

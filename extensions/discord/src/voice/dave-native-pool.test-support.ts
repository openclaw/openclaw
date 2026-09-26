import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";

function vector(bytes: Buffer): Buffer {
  assert.ok(bytes.length < 16384);
  const prefix = Buffer.alloc(bytes.length < 64 ? 1 : 2);
  if (bytes.length < 64) {
    prefix[0] = bytes.length;
  } else {
    prefix.writeUInt16BE(bytes.length | 0x4000);
  }
  return Buffer.concat([prefix, bytes]);
}

/** Generate a real MLS membership rekey without captured payloads or fixed keys. */
export function exerciseDaveRekey(): void {
  const { DAVESession } = loadDiscordVoiceSdk();
  const externalSigner = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = externalSigner.publicKey.export({ format: "jwk" });
  assert.ok(publicJwk.x && publicJwk.y);
  const externalSender = Buffer.concat([
    vector(
      Buffer.concat([
        Buffer.from([4]),
        Buffer.from(publicJwk.x, "base64url"),
        Buffer.from(publicJwk.y, "base64url"),
      ]),
    ),
    Buffer.from([0, 1]), // BasicCredential
    vector(Buffer.from([0])),
  ]);
  const groupId = Buffer.alloc(8);
  groupId.writeBigUInt64BE(1000n);
  const proposal = (body: Buffer, epoch: bigint): Buffer => {
    const epochBytes = Buffer.alloc(8);
    epochBytes.writeBigUInt64BE(epoch);
    const tbs = Buffer.concat([
      Buffer.from([0, 1, 0, 1]), // MLS 1.0 public message
      vector(groupId),
      epochBytes,
      Buffer.from([2, 0, 0, 0, 0]), // external sender index zero
      vector(Buffer.alloc(0)),
      Buffer.from([2]), // proposal content
      body,
    ]);
    const signature = sign(
      "sha256",
      Buffer.concat([vector(Buffer.from("MLS 1.0 FramedContentTBS")), vector(tbs)]),
      externalSigner.privateKey,
    );
    return vector(Buffer.concat([tbs, vector(signature)]));
  };
  const wrappers = ["1001", "1002", "1003"].map((id) => new DAVESession(1, id, "1000", {}));
  try {
    const sessions = wrappers.map((wrapper) => {
      wrapper.reinit();
      assert.ok(wrapper.session);
      wrapper.session.setExternalSender(externalSender);
      return wrapper.session;
    });
    const [session, peer, third] = sessions;
    assert.ok(session && peer && third);
    const first = session.processProposals(
      0,
      proposal(Buffer.concat([Buffer.from([0, 1]), peer.getSerializedKeyPackage()]), 0n),
      ["1002"],
    );
    assert.ok(first.commit && first.welcome);
    session.processCommit(first.commit);
    peer.processWelcome(first.welcome);
    const added = session.processProposals(
      0,
      proposal(Buffer.concat([Buffer.from([0, 1]), third.getSerializedKeyPackage()]), 1n),
      ["1002", "1003"],
    );
    assert.ok(added.commit && added.welcome);
    session.processCommit(added.commit);
    third.processWelcome(added.welcome);
    // Unlike Add alone, removing one of three members encrypts an MLS update path.
    const removal = proposal(Buffer.from([0, 3, 0, 0, 0, 1]), 2n);
    const removed = session.processProposals(0, removal);
    assert.ok(removed.commit);
    // The broadcast commit references this proposal; each recipient must retain it first.
    third.processProposals(0, removal);
    session.processCommit(removed.commit);
    third.processCommit(removed.commit);
    assert.ok(session.ready && third.ready);
    // Exact Opus silence bypasses encryption, so use a distinct synthetic payload.
    const packet = Buffer.from([0xf8, 0xff, 0xfc]);
    const encrypted = session.encryptOpus(packet);
    assert.notDeepEqual(encrypted, packet);
    assert.deepEqual(third.decrypt("1001", 0, encrypted), packet);
  } finally {
    for (const wrapper of wrappers) {
      wrapper.session?.reset();
    }
  }
}

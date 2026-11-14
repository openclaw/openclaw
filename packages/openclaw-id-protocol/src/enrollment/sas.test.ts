import { describe, expect, it } from "vitest";
import {
  generateEphemeralKey,
  openHandoff,
  sasCode,
  sasCommitment,
  sasSharedSecret,
  sasTranscript,
  sealHandoff,
  verifySasCommitment,
  type SasStart,
} from "./sas.js";

const start: SasStart = {
  request_id: "0f".repeat(16),
  claw_id: "c1".repeat(16),
  device_pub: `ed25519:${"11".repeat(32)}`,
  peer_key: `iroh:${"22".repeat(32)}`,
  label: "new phone",
};

describe("SAS approval", () => {
  it("gives both honest sides the same 6-digit code and opens the sealed handoff", async () => {
    const n = await generateEphemeralKey(new Uint8Array(32).fill(1));
    const e = await generateEphemeralKey(new Uint8Array(32).fill(2));
    const commit = await sasCommitment(n.publicKey, start);
    expect(await verifySasCommitment(commit, n.publicKey, start)).toBe(true);
    const transcript = await sasTranscript({
      start,
      commit,
      ephemeralPublicE: e.publicKey,
      ephemeralPublicN: n.publicKey,
      devicePubE: "ed25519:e",
    });
    const ssN = await sasSharedSecret(n, e.publicKey);
    const ssE = await sasSharedSecret(e, n.publicKey);
    const code = await sasCode(ssN, transcript);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(await sasCode(ssE, transcript)).toBe(code);
    const sealed = await sealHandoff(ssE, transcript, { root_pub: "ed25519:r" });
    await expect(openHandoff(ssN, transcript, sealed)).resolves.toEqual({ root_pub: "ed25519:r" });
  });

  it("binds an app's node key and surface into the commitment and code", async () => {
    const n = await generateEphemeralKey(new Uint8Array(32).fill(1));
    const node = {
      peer_key: `iroh:${"33".repeat(32)}`,
      description: { display_name: "Mac", platform: "macos", commands: ["system.run"], caps: [] },
    };
    const withNode: SasStart = { ...start, node };
    const plain = await sasCommitment(n.publicKey, start);
    const bound = await sasCommitment(n.publicKey, withNode);
    expect(bound).not.toBe(plain);
    // A browser's start (no node) commits exactly as before.
    expect(plain).toBe(await sasCommitment(n.publicKey, { ...start }));
    const swapped: SasStart = { ...start, node: { ...node, peer_key: `iroh:${"44".repeat(32)}` } };
    expect(await verifySasCommitment(bound, n.publicKey, swapped)).toBe(false);
    const widened: SasStart = {
      ...start,
      node: { ...node, description: { ...node.description, caps: ["screen"] } },
    };
    expect(await verifySasCommitment(bound, n.publicKey, widened)).toBe(false);
  });
});

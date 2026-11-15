// An app approved as an owner device may bring its node in the same decision: the node is listed
// for admission, never gains human authority, and goes with the device.
import { describe, expect, it } from "vitest";
import { fingerprint, formatIrohEndpointKey } from "../keys.js";
import { signStatement } from "../statements/envelope.js";
import type { OwnerDeviceNode } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import {
  buildWorld,
  certBody,
  signChange,
  signRevocation,
  worldKey,
  WORLD_NOW,
} from "../testing/world.js";
import { DEFAULT_INACTIVITY_WINDOWS, dropInactive } from "./allowlist.js";
import { submitStatement, type WriteContext } from "./apply.js";
import { isAdmitted, isNode, ownerLookup, snapshotBody, type AuthorityResult } from "./state.js";

const tunnel: WriteContext = { channel: "tunnel", now: WORLD_NOW };
const mailbox: WriteContext = { channel: "mailbox", now: WORLD_NOW };
const description = {
  display_name: "Josh’s Mac Studio",
  platform: "macos",
  commands: ["system.run", "screen.capture"],
  caps: ["system", "screen"],
};

function ok(result: AuthorityResult) {
  if (!result.ok) {
    throw new Error(`${result.code}: ${result.detail}`);
  }
  return result;
}

async function macWorld(expiresAt: number | null = null) {
  const world = await buildWorld();
  const mac = await worldKey("mac");
  const nodeKey = formatIrohEndpointKey((await worldKey("mac-node")).signer.publicKey);
  const node: OwnerDeviceNode = { peer_key: nodeKey, label: "Josh’s Mac Studio", description };
  const cert = await signStatement(
    "OwnerDeviceCert",
    { ...certBody(mac), expires_at: expiresAt },
    world.device1.signer,
  );
  const change = await signChange(world.state, world.device1.signer, {
    op: "add_owner_device",
    cert,
    node,
  });
  return { world, mac, nodeKey, node, cert, change, fp: await fingerprint(mac.pub) };
}

describe("owner device with a node", () => {
  it("expires the bound node with its device, keeping independently approved descendants", async () => {
    const expiresAt = WORLD_NOW + 60;
    const { world, mac, nodeKey, change } = await macWorld(expiresAt);
    let state = ok(await submitStatement(world.state, change, tunnel)).state;
    const child = await worldKey("child-app");
    const childNode = (await worldKey("child-node")).peer;
    state = ok(
      await submitStatement(
        state,
        await signChange(state, mac.signer, {
          op: "add_owner_device",
          cert: await signStatement("OwnerDeviceCert", certBody(child), mac.signer),
          node: { peer_key: childNode, label: "Child app", description },
        }),
        tunnel,
      ),
    ).state;

    expect(isAdmitted(state, mac.peer, expiresAt - 1)).toBe(true);
    expect(isAdmitted(state, nodeKey, expiresAt - 1)).toBe(true);
    expect(isAdmitted(state, mac.peer, expiresAt)).toBe(false);
    expect(isAdmitted(state, nodeKey, expiresAt)).toBe(false);
    expect(snapshotBody(state, 1, expiresAt).node_peer_keys).toEqual([childNode]);
    expect(isAdmitted(state, child.peer, expiresAt)).toBe(true);
    expect(isAdmitted(state, childNode, expiresAt)).toBe(true);
  });

  it("lists the node bound to the device in the same approval, as a node only", async () => {
    const { world, mac, nodeKey, change, fp } = await macWorld();
    expect(parseStatement(change, "MembershipChange").ok).toBe(true);
    const result = ok(await submitStatement(world.state, change, tunnel));
    expect(result.state.owner_devices[fp]).toBeDefined();
    expect(result.state.nodes[nodeKey]).toMatchObject({
      owner_device: fp,
      description,
      added_by: await fingerprint(world.device1.pub),
    });
    expect(result.state.nodes[nodeKey]?.invite_id).toBeUndefined();
    expect(isAdmitted(result.state, nodeKey, WORLD_NOW)).toBe(true);
    expect(isNode(result.state, nodeKey)).toBe(true);
    expect(isNode(result.state, mac.peer)).toBe(false);
    expect(snapshotBody(result.state, 1, WORLD_NOW).node_peer_keys).toEqual([nodeKey]);
  });

  it("keeps the change without a node valid and unchanged", async () => {
    const { world, cert } = await macWorld();
    const change = await signChange(world.state, world.device1.signer, {
      op: "add_owner_device",
      cert,
    });
    expect(JSON.stringify(change.body.target)).not.toContain("node");
    expect(Object.keys(ok(await submitStatement(world.state, change, tunnel)).state.nodes)).toEqual(
      [],
    );
  });

  it("refuses a node key that is a human key", async () => {
    const { world, mac, cert } = await macWorld();
    for (const peer_key of [
      mac.peer,
      world.device1.peer,
      formatIrohEndpointKey(mac.signer.publicKey),
    ]) {
      const change = await signChange(world.state, world.device1.signer, {
        op: "add_owner_device",
        cert,
        node: { peer_key, label: "x", description },
      });
      expect(await submitStatement(world.state, change, tunnel)).toMatchObject({
        ok: false,
        code: "target_mismatch",
      });
    }
  });

  it("removes only the node with remove_node, keeping the owner device", async () => {
    const { world, nodeKey, change, fp } = await macWorld();
    const state = ok(await submitStatement(world.state, change, tunnel)).state;
    const removed = ok(
      await submitStatement(
        state,
        await signChange(state, world.device1.signer, { op: "remove_node", peer_key: nodeKey }),
        tunnel,
      ),
    );
    expect(removed.state.nodes[nodeKey]).toBeUndefined();
    expect(removed.state.owner_devices[fp]).toBeDefined();
    expect(removed.events).toContainEqual({ type: "remove_node_pairings", peer_keys: [nodeKey] });
  });

  it("lets the device turn its node back on by re-adding itself", async () => {
    const { world, mac, nodeKey, node, cert, change } = await macWorld();
    let state = ok(await submitStatement(world.state, change, tunnel)).state;
    state = ok(
      await submitStatement(
        state,
        await signChange(state, world.device1.signer, { op: "remove_node", peer_key: nodeKey }),
        tunnel,
      ),
    ).state;
    const self = await signStatement("OwnerDeviceCert", cert.body, mac.signer);
    const again = ok(
      await submitStatement(
        state,
        await signChange(state, mac.signer, { op: "add_owner_device", cert: self, node }),
        tunnel,
      ),
    );
    expect(again.state.nodes[nodeKey]?.owner_device).toBe(await fingerprint(mac.pub));
  });

  it("removes the node with its device, and with the device that approved it", async () => {
    const { world, nodeKey, change, fp } = await macWorld();
    const state = ok(await submitStatement(world.state, change, tunnel)).state;
    for (const target of [fp, await fingerprint(world.device1.pub)]) {
      const result = ok(
        await submitStatement(state, await signRevocation(state, world.root, target), tunnel),
      );
      expect(result.state.nodes[nodeKey]).toBeUndefined();
      expect(isAdmitted(result.state, nodeKey, WORLD_NOW)).toBe(false);
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: "remove_node_pairings", peer_keys: [nodeKey] }),
      );
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "invalidate_tokens",
          peer_keys: expect.arrayContaining([nodeKey]),
        }),
      );
    }
  });

  it("drops the node when its device is dropped for inactivity", async () => {
    const { world, nodeKey, change } = await macWorld();
    const state = ok(await submitStatement(world.state, change, tunnel)).state;
    const later = WORLD_NOW + DEFAULT_INACTIVITY_WINDOWS.ownerDeviceSeconds + 1;
    const fresh = {
      ...state,
      nodes: { ...state.nodes, [nodeKey]: { ...state.nodes[nodeKey]!, last_seen: later } },
    };
    const dropped = dropInactive(fresh, later);
    expect(dropped?.state.nodes[nodeKey]).toBeUndefined();
    expect(dropped?.peers).toContain(nodeKey);
  });

  it("enrolls the device and its node with the recovery kit through the mailbox", async () => {
    const { world, mac, nodeKey, node, fp } = await macWorld();
    const cert = await signStatement("OwnerDeviceCert", certBody(mac), world.root);
    const change = await signChange(world.state, world.root, {
      op: "add_owner_device",
      cert,
      node,
    });
    const result = ok(await submitStatement(world.state, change, mailbox));
    expect(result.state.nodes[nodeKey]).toMatchObject({ owner_device: fp, added_by: "root" });
    expect(result.events).toContainEqual({ type: "notify_owners", event: "kit_used", ref: fp });
    expect(ownerLookup(result.state, WORLD_NOW)(mac.pub)).toBeDefined();
  });

  it("refuses binding another node's key to a device", async () => {
    const { world, cert, change } = await macWorld();
    const state = ok(await submitStatement(world.state, change, tunnel)).state;
    const other = await worldKey("other-mac");
    const otherCert = await signStatement("OwnerDeviceCert", certBody(other), world.device1.signer);
    const steal = await signChange(state, world.device1.signer, {
      op: "add_owner_device",
      cert: otherCert,
      node: {
        peer_key: Object.keys(state.nodes)[0] as OwnerDeviceNode["peer_key"],
        label: "x",
        description,
      },
    });
    expect(await submitStatement(state, steal, tunnel)).toMatchObject({
      ok: false,
      code: "target_mismatch",
    });
    expect(cert).toBeDefined();
  });
});

import { describe, expect, it, vi } from "vitest";
import { ActiveFaceTimeCall, FaceTimeCallRegistry } from "../src/runtime-state.js";

describe("FaceTime call lifecycle", () => {
  it("resolves every retained UUID alias to exactly the current generation", () => {
    const registry = new FaceTimeCallRegistry();
    const current = new ActiveFaceTimeCall({
      callUUID: "stable-uuid",
      phase: "active",
      owner: { senderId: "owner@example.com", senderIsOwner: true },
    });
    registry.create(current);
    registry.retainAlias(current, "provisional-uuid");

    expect(registry.get("PROVISIONAL-UUID")).toBe(current);
    registry.close(current);
    expect(registry.get("provisional-uuid")).toBeUndefined();

    const successor = new ActiveFaceTimeCall({
      callUUID: "successor-uuid",
      phase: "active",
      owner: { senderId: "owner@example.com", senderIsOwner: true },
    });
    registry.create(successor);
    expect(registry.get("provisional-uuid")).toBeUndefined();
    expect(registry.get("successor-uuid")).toBe(successor);
  });

  it("rejects a carrier command that settles after closing advances generation", async () => {
    const call = new ActiveFaceTimeCall({
      callUUID: "call-1",
      phase: "active",
      owner: { senderId: "owner@example.com", senderIsOwner: true },
    });
    let settle = (_value: string) => {};
    const nativeAction = vi.fn(
      async () =>
        await new Promise<string>((resolve) => {
          settle = resolve;
        }),
    );
    const generation = call.captureGeneration();
    const command = call.runCarrierCommand({ generation, action: nativeAction });
    await vi.waitFor(() => expect(nativeAction).toHaveBeenCalledOnce());
    call.beginClosing();
    settle("unmuted");

    await expect(command).rejects.toThrow("lifecycle changed");
    expect(call.carrierMode).toBe("closing");
  });
});

// Verifies bounded owner prompt identities.
import { describe, expect, it } from "vitest";
import { resolveOwnerPromptNumbers } from "./owner-display.js";

describe("resolveOwnerPromptNumbers", () => {
  it("preserves small owner lists and omits empty lists", () => {
    const owners = ["owner-a", "owner-b"];

    expect(resolveOwnerPromptNumbers({ ownerNumbers: owners })).toBe(owners);
    expect(resolveOwnerPromptNumbers({ ownerNumbers: [] })).toBeUndefined();
    expect(resolveOwnerPromptNumbers({})).toBeUndefined();
  });

  it("retains the current verified owner without changing the authorization list", () => {
    const owners = Array.from({ length: 24 }, (_, index) => `owner-${index}`);
    const selected = resolveOwnerPromptNumbers({
      ownerNumbers: owners,
      senderId: "owner-23",
      senderIsOwner: true,
    });

    expect(selected).toHaveLength(16);
    expect(selected?.slice(0, 15)).toEqual(owners.slice(0, 15));
    expect(selected?.at(-1)).toBe("owner-23");
    expect(owners).toHaveLength(24);
    expect(owners[15]).toBe("owner-15");
  });

  it("reserves prompt bytes for the current owner when preceding identities are long", () => {
    const currentOwner = "npub140x77qfrg4ncn27dauqjx3t83x4ummcpydzk0zdtehhszg69v7ystddknj";
    const owners = [
      ...Array.from({ length: 15 }, (_, index) => `owner-${index}-${"a".repeat(72)}`),
      currentOwner,
    ];
    const selected = resolveOwnerPromptNumbers({
      ownerNumbers: owners,
      senderId: currentOwner,
      senderIsOwner: true,
    });

    expect(selected?.[0]).toBe(currentOwner);
    expect(selected).toHaveLength(16);
    expect(owners.at(-1)).toBe(currentOwner);
  });

  it("never promotes an unverified or unlisted sender into owner guidance", () => {
    const owners = Array.from({ length: 24 }, (_, index) => `owner-${index}`);

    for (const sender of [
      { senderId: "owner-23", senderIsOwner: false },
      { senderId: "operator-admin", senderIsOwner: true },
      { senderId: "owner-23" },
    ]) {
      expect(resolveOwnerPromptNumbers({ ownerNumbers: owners, ...sender })).toEqual(
        owners.slice(0, 16),
      );
    }
  });
});

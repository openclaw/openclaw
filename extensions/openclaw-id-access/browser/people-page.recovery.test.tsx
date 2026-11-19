/* @vitest-environment jsdom */

import { render } from "@solidjs/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeoplePage } from "./people-page.js";
import {
  button,
  disposers,
  hostFor,
  linked,
  mountPage,
  recoveryUse,
} from "./people-page.test-support.js";

// Signing needs this browser's owner key from IndexedDB; the tests stand in for it.
// mock-isolation: the owner device key lives in IndexedDB, which these page tests replace with a fixed signer.
vi.mock("./owner-signing.js", () => ({
  thisOwnerDevice: vi.fn(async (link: { ownerDevices?: Array<{ devicePub: string }> }) =>
    link.ownerDevices?.find((device) => device.devicePub === "ed25519:mine"),
  ),
  signMembershipChange: vi.fn(async (_link: unknown, target: unknown) => ({ signed: target })),
  signAsOwner: vi.fn(async () => ({ signed: "cap" })),
}));

describe("Access page recovery history", () => {
  afterEach(() => {
    disposers
      .splice(0)
      .toReversed()
      .forEach((dispose) => dispose());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows no people to a client that is not an owner, and never asks for them", async () => {
    const { host, request } = hostFor([
      { ...linked({ recoveryUses: [recoveryUse] }), owner: false },
    ]);
    const container = document.createElement("div");
    document.body.append(container);
    disposers.push(render(() => <PeoplePage host={host} />, container));
    await vi.waitFor(() =>
      expect(container.textContent).toContain(
        "Only the owner can see who has access. Open this page from an approved owner browser.",
      ),
    );
    expect(request).not.toHaveBeenCalledWith("openclawId.people", {});
    expect(container.textContent).not.toContain("member@example.test");
    expect(container.textContent).not.toContain("Recovery kit history");
    expect(container.textContent).not.toContain(recoveryUse.memberName);
    expect(button(container, "Add node")).toBeUndefined();
  });

  it("keeps literal recovery history after a member disappears and renders labels as text", async () => {
    const member = {
      accountId: recoveryUse.accountId,
      role: "operator",
      peerKeys: [],
      displayName: recoveryUse.memberName,
    };
    const harness = await mountPage([
      linked({ invites: [], members: [member], recoveryUses: [recoveryUse] }),
      linked({ invites: [], members: [], recoveryUses: [recoveryUse] }),
    ]);
    const history = () =>
      harness.container.querySelector('[aria-labelledby="ocid-access-recovery-uses"]');
    await vi.waitFor(() =>
      expect(history()?.textContent).toContain("Mira <Example> used a recovery kit"),
    );
    expect(history()?.textContent).toContain("Browser added: Firefox <Linux>");
    expect(history()?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2027-01-15T08:00:00.000Z",
    );
    expect(history()?.querySelector("time")?.textContent).toMatch(/2027/);
    expect(history()?.querySelector("example, linux")).toBeNull();
    expect(history()?.querySelector("a")).toBeNull();
    expect(harness.container.querySelectorAll(".ocid-access__row--member")).toHaveLength(1);
    harness.emit();
    await vi.waitFor(() =>
      expect(harness.container.querySelectorAll(".ocid-access__row--member")).toHaveLength(0),
    );
    expect(history()?.textContent).toContain("Mira <Example> (removed) used a recovery kit");
    expect(history()?.textContent).toContain("Browser added: Firefox <Linux>");
    expect(history()?.querySelector("a")).toBeNull();
  });

  it("sorts the requested recovery browser first and follows route changes without remounting", async () => {
    const deviceFp = `fp:${"1".repeat(64)}` as const;
    const device = {
      peerKey: recoveryUse.peerKey,
      deviceFp,
      label: recoveryUse.deviceLabel,
      approvedBy: { kind: "member_recovery_kit" as const, device_fp: deviceFp },
      connections: 0,
      lastSeenAt: null,
      lastSeen: recoveryUse.usedAt,
      runs: [],
    };
    const member = {
      accountId: recoveryUse.accountId,
      displayName: recoveryUse.memberName,
      role: "operator",
      peerKeys: [device.peerKey],
      devices: [
        { ...device, peerKey: `iroh:${"2".repeat(64)}`, label: "Existing browser" },
        device,
      ],
      recoveryKit: true,
    };
    const other = {
      accountId: "other-account",
      displayName: "Other Member",
      role: "viewer",
      peerKeys: [],
      devices: [],
    };
    const harness = await mountPage(
      [linked({ invites: [], members: [other, member], recoveryUses: [recoveryUse] })],
      {},
      { member: member.accountId, device: device.peerKey },
    );
    const row = () => harness.container.querySelector<HTMLElement>(".ocid-access__row--member")!;
    await vi.waitFor(() =>
      expect(harness.container.querySelectorAll(".ocid-access__row--member")).toHaveLength(1),
    );
    expect(row().textContent).toContain(member.displayName);
    expect(row().textContent).not.toContain(other.displayName);
    const highlighted = row().querySelector<HTMLElement>(".ocid-access__device--highlighted")!;
    expect(highlighted.textContent).toContain(device.label);
    expect(row().querySelector(".ocid-access__device")).toBe(highlighted);
    harness.update({ member: other.accountId });
    await vi.waitFor(() => expect(row().textContent).toContain(other.displayName));
    harness.update({});
    await vi.waitFor(() =>
      expect(harness.container.querySelector(".ocid-access__row--owner")).not.toBeNull(),
    );
  });
});

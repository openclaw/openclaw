import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  enrichBlueBubblesParticipantsWithContactNames,
  resetBlueBubblesParticipantContactNameCacheForTest,
} from "./participant-contact-names.js";

describe("enrichBlueBubblesParticipantsWithContactNames", () => {
  beforeEach(() => {
    resetBlueBubblesParticipantContactNameCacheForTest();
  });

  it("enriches unnamed phone participants and reuses cached names across formats", async () => {
    const resolver = vi.fn(
      async (phoneKeys: string[]) =>
        new Map(
          phoneKeys.map((phoneKey) => [
            phoneKey,
            phoneKey === "5551234567" ? "Alice Example" : "Bob Example",
          ]),
        ),
    );

    const first = await enrichBlueBubblesParticipantsWithContactNames(
      [{ id: "+1 (555) 123-4567" }, { id: "+15557654321" }],
      {
        platform: "darwin",
        now: () => 1_000,
        resolvePhoneNames: resolver,
      },
    );

    expect(first).toEqual([
      { id: "+1 (555) 123-4567", name: "Alice Example" },
      { id: "+15557654321", name: "Bob Example" },
    ]);
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith(["5551234567", "5557654321"]);

    const secondResolver = vi.fn(async () => new Map<string, string>());
    const second = await enrichBlueBubblesParticipantsWithContactNames([{ id: "+15551234567" }], {
      platform: "darwin",
      now: () => 2_000,
      resolvePhoneNames: secondResolver,
    });

    expect(second).toEqual([{ id: "+15551234567", name: "Alice Example" }]);
    expect(secondResolver).not.toHaveBeenCalled();
  });

  it("skips email addresses and keeps existing participant names", async () => {
    const resolver = vi.fn(async () => new Map<string, string>());

    const participants = await enrichBlueBubblesParticipantsWithContactNames(
      [{ id: "alice@example.com" }, { id: "+15551234567", name: "Alice Existing" }],
      {
        platform: "darwin",
        now: () => 1_000,
        resolvePhoneNames: resolver,
      },
    );

    expect(participants).toEqual([
      { id: "alice@example.com" },
      { id: "+15551234567", name: "Alice Existing" },
    ]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("gracefully returns original participants when lookup fails", async () => {
    const participants = [{ id: "+15551234567" }, { id: "+15557654321" }];

    await expect(
      enrichBlueBubblesParticipantsWithContactNames(participants, {
        platform: "darwin",
        now: () => 1_000,
        resolvePhoneNames: vi.fn(async () => {
          throw new Error("contacts unavailable");
        }),
      }),
    ).resolves.toBe(participants);
  });

  it("skips contact lookup on non macOS hosts", async () => {
    const participants = [{ id: "+15551234567" }];

    const result = await enrichBlueBubblesParticipantsWithContactNames(participants, {
      platform: "linux",
    });

    expect(result).toBe(participants);
  });
});

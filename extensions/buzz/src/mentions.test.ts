import { nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  inspectBuzzMentionSyntax,
  resolveBuzzMessageMentions,
  type BuzzMentionMember,
} from "./mentions.js";

const BOT_PUBLIC_KEY = "a".repeat(64);
const ALICE_PUBLIC_KEY = "b".repeat(64);
const SECOND_ALICE_PUBLIC_KEY = "c".repeat(64);
const BOB_PUBLIC_KEY = "d".repeat(64);

function resolve(text: string, ...values: BuzzMentionMember[]) {
  return resolveBuzzMessageMentions({
    text,
    members: [{ publicKey: BOT_PUBLIC_KEY, displayName: "OpenClaw" }, ...values],
    senderPublicKey: BOT_PUBLIC_KEY,
  });
}

const alice = { publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" };
const secondAlice = { publicKey: SECOND_ALICE_PUBLIC_KEY, displayName: "Alice" };

describe("Buzz outbound mentions", () => {
  it("resolves unique room-member names and preserves multi-word matching", () => {
    expect(
      resolve("Thanks @Alice Example, please review. @ALICE EXAMPLE", {
        ...alice,
        displayName: " Alice Example ",
      }),
    ).toEqual([ALICE_PUBLIC_KEY]);
  });

  it("resolves a known non-ASCII room-member name without treating emails as mentions", () => {
    expect(inspectBuzzMentionSyntax("Hello @Élodie").hasAtMention).toBe(true);
    expect(resolve("Hello @Élodie", { ...alice, displayName: "Élodie" })).toEqual([
      ALICE_PUBLIC_KEY,
    ]);
    expect(inspectBuzzMentionSyntax("mail user@example.com")).toEqual({
      hasAtMention: false,
      hasExplicitIdentity: false,
    });
  });

  it("rejects unknown non-ASCII mention text instead of publishing it without a tag", () => {
    expect(() => resolve("Hello @不存在", alice)).toThrow(
      "Buzz mention does not match a current room member",
    );
  });

  it("rejects unknown and ambiguous names without an explicit identity", () => {
    expect(() => resolve("Hello @Missing", alice)).toThrow(
      'Buzz mention "@missing" does not match a current room member',
    );
    expect(() => resolve("Hello @Alice", alice, secondAlice)).toThrow(
      nip19.npubEncode(ALICE_PUBLIC_KEY),
    );
  });

  it("allows unresolved labels as presentation text when an explicit identity is present", () => {
    const explicitBob = nip19.npubEncode(BOB_PUBLIC_KEY);
    const roomMembers = [alice, secondAlice, { publicKey: BOB_PUBLIC_KEY, displayName: "Bob" }];

    expect(
      resolve(
        `Hello @Missing (nostr:${explicitBob}) nostr:npub1invalid nostr:${explicitBob}`,
        ...roomMembers,
      ),
    ).toEqual([BOB_PUBLIC_KEY]);

    expect(resolve(`Hello @Alice (nostr:${explicitBob})`, ...roomMembers)).toEqual([
      BOB_PUBLIC_KEY,
    ]);
  });

  it("bounds ambiguous-member guidance", () => {
    const duplicateMembers = Array.from({ length: 8 }, (_, index) => ({
      publicKey: (index + 1).toString(16).repeat(64),
      displayName: "Alice",
    }));

    expect(() => resolve("Hello @Alice", ...duplicateMembers)).toThrow(
      `candidates: ${duplicateMembers
        .slice(0, 5)
        .map((member) => nip19.npubEncode(member.publicKey))
        .join(", ")}, and 3 more.`,
    );
  });

  it("rejects explicit identities outside the room and excludes the bot identity", () => {
    const outsider = "d".repeat(64);
    expect(() => resolve(`nostr:${nip19.npubEncode(outsider)}`, alice)).toThrow(
      "is not a current room member",
    );

    expect(resolve(`nostr:${nip19.npubEncode(BOT_PUBLIC_KEY)}`)).toEqual([]);
  });

  it("does not resolve mention-like text inside Markdown code regions", () => {
    expect(
      resolveBuzzMessageMentions({
        text: "`@Alice`\n```\nnostr:npub1invalid\n```",
        members: undefined,
        senderPublicKey: BOT_PUBLIC_KEY,
      }),
    ).toEqual([]);
  });

  it("rejects messages above the native mention limit", () => {
    const mentionedMembers = Array.from({ length: 51 }, (_, index) => ({
      publicKey: (index + 1).toString(16).padStart(64, "0"),
      displayName: `Member${index + 1}`,
    }));

    expect(() =>
      resolve(
        mentionedMembers.map((member) => `@${member.displayName}`).join(" "),
        ...mentionedMembers,
      ),
    ).toThrow("Buzz messages support at most 50 mentions");
  });
});

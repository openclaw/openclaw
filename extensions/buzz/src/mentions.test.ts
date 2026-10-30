import { nip19 } from "nostr-tools";
import { expect, it } from "vitest";
import {
  inspectBuzzMentionSyntax,
  resolveBuzzMessageMentions,
  type BuzzMentionMember,
} from "./mentions.js";

const BOT_PUBLIC_KEY = "a".repeat(64);
const ALICE_PUBLIC_KEY = "b".repeat(64);
const BOB_PUBLIC_KEY = "d".repeat(64);

function resolve(text: string, values: readonly BuzzMentionMember[] | undefined) {
  return resolveBuzzMessageMentions({
    text,
    members: values && [{ publicKey: BOT_PUBLIC_KEY, displayName: "OpenClaw" }, ...values],
    senderPublicKey: BOT_PUBLIC_KEY,
  });
}

function makeMembers(count: number, name: (index: number) => string) {
  return Array.from({ length: count }, (_, index) => ({
    publicKey: (index + 1).toString(16).padStart(64, "0"),
    displayName: name(index),
  }));
}

const alice = { publicKey: ALICE_PUBLIC_KEY, displayName: "Alice" };
const secondAlice = { publicKey: "c".repeat(64), displayName: "Alice" };
const explicitBob = nip19.npubEncode(BOB_PUBLIC_KEY);
const roomMembers = [alice, secondAlice, { publicKey: BOB_PUBLIC_KEY, displayName: "Bob" }];
const ambiguousMembers = makeMembers(8, () => "Alice");
const excessMembers = makeMembers(51, (index) => `Member${index + 1}`);

it.each([
  [
    "Thanks @Alice Example, please review. @ALICE EXAMPLE",
    [{ ...alice, displayName: " Alice Example " }],
    [ALICE_PUBLIC_KEY],
  ],
  ["Hello @Élodie", [{ ...alice, displayName: "Élodie" }], [ALICE_PUBLIC_KEY]],
  [
    `Hello @Missing (nostr:${explicitBob}) nostr:npub1invalid nostr:${explicitBob}`,
    roomMembers,
    [BOB_PUBLIC_KEY],
  ],
  [`Hello @Alice (nostr:${explicitBob})`, roomMembers, [BOB_PUBLIC_KEY]],
  [`nostr:${nip19.npubEncode(BOT_PUBLIC_KEY)}`, [], []],
  ["`@Alice`\n```\nnostr:npub1invalid\n```", undefined, []],
] as const)("resolves %s", (text, members, expected) => {
  expect(resolve(text, members)).toEqual(expected);
});

it("recognizes non-ASCII mentions but not email addresses", () => {
  expect(inspectBuzzMentionSyntax("Hello @Élodie").hasAtMention).toBe(true);
  expect(inspectBuzzMentionSyntax("mail user@example.com")).toEqual({
    hasAtMention: false,
    hasExplicitIdentity: false,
  });
});

it.each([
  ["Hello @不存在", [alice], "Buzz mention does not match a current room member"],
  ["Hello @Alice", [alice, secondAlice], nip19.npubEncode(ALICE_PUBLIC_KEY)],
  [`nostr:${explicitBob}`, [alice], "is not a current room member"],
  [
    "Hello @Alice",
    ambiguousMembers,
    `candidates: ${ambiguousMembers
      .slice(0, 5)
      .map((member) => nip19.npubEncode(member.publicKey))
      .join(", ")}, and 3 more.`,
  ],
  [
    excessMembers.map((member) => `@${member.displayName}`).join(" "),
    excessMembers,
    "Buzz messages support at most 50 mentions",
  ],
] as const)("rejects %s", (text, members, error) => {
  expect(() => resolve(text, members)).toThrow(error);
});

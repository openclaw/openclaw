import { describe, expect, it } from "vitest";
import {
  resolveWhatsAppDirectSystemPrompt,
  resolveWhatsAppGroupSystemPrompt,
} from "./system-prompt.js";

type Entries = Record<string, { systemPrompt?: string | null }>;
type PromptCase = {
  name: string;
  entries?: Entries;
  targetId: string | null;
  expected?: string;
};

const cases: PromptCase[] = [
  {
    name: "ignores prompts without a target",
    targetId: null,
    entries: { "*": { systemPrompt: "wildcard" } },
  },
  { name: "handles absent account config", targetId: "specific" },
  {
    name: "trims the specific prompt and gives it precedence over the wildcard",
    targetId: "specific",
    entries: { specific: { systemPrompt: "  chosen  " }, "*": { systemPrompt: "wildcard" } },
    expected: "chosen",
  },
  {
    name: "uses the wildcard when the specific entry is absent",
    targetId: "specific",
    entries: { "*": { systemPrompt: "wildcard" } },
    expected: "wildcard",
  },
  {
    name: "suppresses the wildcard for a whitespace-only specific prompt",
    targetId: "specific",
    entries: { specific: { systemPrompt: "   " }, "*": { systemPrompt: "wildcard" } },
  },
  {
    name: "handles an entry with no prompt or wildcard",
    targetId: "specific",
    entries: { specific: {} },
  },
  {
    name: "uses the wildcard for a null specific prompt",
    targetId: "specific",
    entries: { specific: { systemPrompt: null }, "*": { systemPrompt: "wildcard" } },
    expected: "wildcard",
  },
];

describe.each([
  {
    name: "group",
    resolve: (entries: Entries | undefined, targetId: string | null) =>
      resolveWhatsAppGroupSystemPrompt({
        accountConfig: entries ? { groups: entries } : undefined,
        groupId: targetId,
      }),
  },
  {
    name: "direct",
    resolve: (entries: Entries | undefined, targetId: string | null) =>
      resolveWhatsAppDirectSystemPrompt({
        accountConfig: entries ? { direct: entries } : undefined,
        peerId: targetId,
      }),
  },
])("WhatsApp $name system prompts", ({ resolve }) => {
  it.each(cases)("$name", ({ entries, targetId, expected }) => {
    expect(resolve(entries, targetId)).toBe(expected);
  });
});

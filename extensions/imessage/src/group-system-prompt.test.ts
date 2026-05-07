import { describe, expect, it } from "vitest";
import type { ResolvedIMessageAccount } from "./accounts.js";
import {
  buildIMessageGroupKeyCandidates,
  resolveIMessageGroupSystemPrompt,
} from "./group-system-prompt.js";

function buildAccount(
  groups: Record<string, { systemPrompt?: string; requireMention?: boolean } | undefined>,
): ResolvedIMessageAccount {
  return {
    accountId: "main",
    enabled: true,
    cliPath: "/usr/local/bin/imsg",
    config: {
      groups,
    },
  } as unknown as ResolvedIMessageAccount;
}

describe("buildIMessageGroupKeyCandidates", () => {
  it("returns numeric and chat_id-prefixed forms for a chat_id", () => {
    expect(buildIMessageGroupKeyCandidates({ chatId: 42 })).toEqual(["42", "chat_id:42"]);
  });

  it("includes raw + normalized + prefixed candidates for chat_guid", () => {
    const candidates = buildIMessageGroupKeyCandidates({
      chatGuid: "iMessage;+;chat-family",
    });
    expect(candidates).toContain("iMessage;+;chat-family");
    expect(candidates.some((c) => c.startsWith("chat_guid:"))).toBe(true);
  });

  it("does not duplicate when chatGuid already starts with chat_guid:", () => {
    const candidates = buildIMessageGroupKeyCandidates({
      chatGuid: "chat_guid:iMessage;+;chat-family",
    });
    expect(candidates.filter((c) => c.includes("chat_guid:")).length).toBe(1);
  });

  it("returns empty array when nothing is provided", () => {
    expect(buildIMessageGroupKeyCandidates({})).toEqual([]);
  });
});

describe("resolveIMessageGroupSystemPrompt", () => {
  it("returns the per-chat_id systemPrompt", () => {
    const account = buildAccount({
      "chat_id:42": { systemPrompt: "Keep responses under 3 sentences." },
    });
    expect(resolveIMessageGroupSystemPrompt({ account, chatId: 42 })).toBe(
      "Keep responses under 3 sentences.",
    );
  });

  it("returns the per-chat_guid systemPrompt", () => {
    const account = buildAccount({
      "iMessage;+;chat-family": { systemPrompt: "Use the family group style." },
    });
    expect(
      resolveIMessageGroupSystemPrompt({
        account,
        chatGuid: "iMessage;+;chat-family",
      }),
    ).toBe("Use the family group style.");
  });

  it("falls back to the wildcard when no per-channel key matches", () => {
    const account = buildAccount({
      "*": { systemPrompt: "Default group prompt." },
    });
    expect(resolveIMessageGroupSystemPrompt({ account, chatId: 99 })).toBe("Default group prompt.");
  });

  it("prefers per-channel over wildcard when both are set", () => {
    const account = buildAccount({
      "*": { systemPrompt: "wildcard" },
      "chat_id:7": { systemPrompt: "specific" },
    });
    expect(resolveIMessageGroupSystemPrompt({ account, chatId: 7 })).toBe("specific");
  });

  it("treats explicit empty per-channel value as deliberate suppression of the wildcard", () => {
    // Matches WhatsApp / BlueBubbles convention: `specific.systemPrompt != null`
    // suppresses the wildcard. Operators opt this chat out of any prompt by
    // setting `systemPrompt: ""`. Wildcard fallback does NOT kick in.
    const account = buildAccount({
      "*": { systemPrompt: "fallback" },
      "chat_id:42": { systemPrompt: "" },
    });
    expect(resolveIMessageGroupSystemPrompt({ account, chatId: 42 })).toBeUndefined();
  });

  it("treats whitespace-only per-channel value as deliberate suppression too", () => {
    const account = buildAccount({
      "*": { systemPrompt: "fallback" },
      "chat_id:42": { systemPrompt: "   \t\n  " },
    });
    expect(resolveIMessageGroupSystemPrompt({ account, chatId: 42 })).toBeUndefined();
  });

  it("returns undefined when neither per-channel nor wildcard is configured", () => {
    const account = buildAccount({});
    expect(resolveIMessageGroupSystemPrompt({ account, chatId: 42 })).toBeUndefined();
  });

  it("returns undefined when groups is missing entirely", () => {
    const account = {
      accountId: "main",
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      config: {},
    } as unknown as ResolvedIMessageAccount;
    expect(resolveIMessageGroupSystemPrompt({ account, chatId: 42 })).toBeUndefined();
  });

  it("matches via chat_identifier when only chat_identifier is supplied", () => {
    const account = buildAccount({
      "chat_identifier:family-group": { systemPrompt: "identifier prompt" },
    });
    expect(resolveIMessageGroupSystemPrompt({ account, chatIdentifier: "family-group" })).toBe(
      "identifier prompt",
    );
  });
});

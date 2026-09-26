// Imessage test support covers inbound processing.systemPrompt plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";

type DecisionParams = Parameters<typeof resolveIMessageInboundDecision>[0];

function buildCfgWithGroups(
  groups: Record<string, { requireMention?: boolean; systemPrompt?: string }>,
): OpenClawConfig {
  return {
    channels: {
      imessage: {
        groupPolicy: "allowlist",
        groups,
      },
    },
  };
}

function buildDecisionParams(overrides: Partial<DecisionParams> = {}): DecisionParams {
  return {
    cfg: overrides.cfg ?? {},
    accountId: "default",
    message: {
      id: 1,
      sender: "+15555550123",
      text: "hi",
      is_from_me: false,
      is_group: true,
      chat_id: 7,
      chat_guid: "any;+;chatXYZ",
      chat_identifier: "chatXYZ",
      created_at: "2026-05-08T03:00:00Z",
    },
    messageText: "hi",
    bodyText: "hi",
    allowFrom: ["+15555550123"],
    groupAllowFrom: ["+15555550123"],
    groupPolicy: "allowlist",
    dmPolicy: "open",
    storeAllowFrom: [],
    historyLimit: 0,
    groupHistories: new Map(),
    echoCache: undefined,
    selfChatCache: undefined,
    logVerbose: undefined,
    ...overrides,
  };
}

describe("resolveIMessageInboundDecision per-group systemPrompt", () => {
  it("falls back to the groups['*'] wildcard systemPrompt", async () => {
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Default group voice." },
        }),
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBe("Default group voice.");
  });

  it("prefers the per-chat_id systemPrompt over the wildcard when both are set", async () => {
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Default group voice." },
          "7": { systemPrompt: "Specific group voice." },
        }),
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBe("Specific group voice.");
  });

  it("treats whitespace-only per-chat_id systemPrompt as suppression of the wildcard", async () => {
    // Mirrors WhatsApp semantic: defining the systemPrompt key on a specific
    // group entry (even as whitespace) means "this group has no prompt" and
    // suppresses the groups["*"] fallback.
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Wildcard." },
          "7": { systemPrompt: "   " },
        }),
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBeUndefined();
  });

  it("falls back to the wildcard when the per-chat_id entry has no systemPrompt key at all", async () => {
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "*": { systemPrompt: "Wildcard." },
          "7": { requireMention: true },
        }),
        opts: { requireMention: false },
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.groupSystemPrompt).toBe("Wildcard.");
    expect(decision.groupRequireMention).toBe(false);
  });

  it("does not set groupSystemPrompt on true DM decisions", async () => {
    // Use a chat_id that does NOT match any configured group entry, and
    // route through the DM-shaped message (is_group=false, no chat_id key
    // in groups). Without a groupConfig match the path stays a DM and the
    // group prompt must not bleed into the ctx.
    const decision = await resolveIMessageInboundDecision(
      buildDecisionParams({
        cfg: buildCfgWithGroups({
          "999": { systemPrompt: "Other group." },
        }),
        message: {
          id: 1,
          sender: "+15555550123",
          text: "hi",
          is_from_me: false,
          is_group: false,
          chat_id: 42,
          chat_identifier: "+15555550123",
          destination_caller_id: "+15555550456",
          created_at: "2026-05-08T03:00:00Z",
        },
        groupPolicy: "open",
      }),
    );
    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.isGroup).toBe(false);
    expect(decision.groupSystemPrompt).toBeUndefined();
  });
});

describe("buildIMessageInboundContext forwards GroupSystemPrompt", () => {
  async function buildBuildParams(options: {
    isGroup: boolean;
    groupSystemPrompt?: string;
    groupRequireMention?: boolean;
  }): Promise<Parameters<typeof buildIMessageInboundContext>[0]> {
    const params = buildDecisionParams({
      cfg: buildCfgWithGroups({
        "7": {
          systemPrompt: options.groupSystemPrompt,
          requireMention: options.groupRequireMention ?? false,
        },
      }),
    });
    params.message = {
      ...params.message,
      is_group: options.isGroup,
      chat_id: options.isGroup ? 7 : undefined,
      chat_guid: options.isGroup ? "any;+;chatXYZ" : "any;-;+15555550123",
      chat_identifier: options.isGroup ? "chatXYZ" : "+15555550123",
      chat_name: options.isGroup ? "Test Group" : undefined,
    };
    const decision = await resolveIMessageInboundDecision(params);
    if (decision.kind !== "dispatch") {
      throw new Error("expected system-prompt fixture admission");
    }
    if (!options.isGroup) {
      decision.groupSystemPrompt = options.groupSystemPrompt;
    }
    return {
      cfg: params.cfg,
      accountService: undefined,
      decision,
      message: params.message,
      historyLimit: 0,
      groupHistories: params.groupHistories,
    };
  }

  it("sets ctxPayload.GroupSystemPrompt for group messages", async () => {
    const { ctxPayload } = await buildIMessageInboundContext(
      await buildBuildParams({ isGroup: true, groupSystemPrompt: "Be concise." }),
    );
    expect(ctxPayload.GroupSystemPrompt).toBe("Be concise.");
  });

  it("forwards the effective group mention policy", async () => {
    const { ctxPayload } = await buildIMessageInboundContext(
      await buildBuildParams({ isGroup: true, groupRequireMention: true }),
    );
    expect(ctxPayload.GroupRequireMention).toBe(true);
  });

  it("leaves ctxPayload.GroupSystemPrompt undefined when no per-group prompt is configured", async () => {
    const { ctxPayload } = await buildIMessageInboundContext(
      await buildBuildParams({ isGroup: true, groupSystemPrompt: undefined }),
    );
    expect(ctxPayload.GroupSystemPrompt).toBeUndefined();
  });

  it("leaves ctxPayload.GroupSystemPrompt undefined for DMs even if a prompt is somehow on decision", async () => {
    const { ctxPayload } = await buildIMessageInboundContext(
      await buildBuildParams({ isGroup: false, groupSystemPrompt: "should-not-leak" }),
    );
    expect(ctxPayload.GroupSystemPrompt).toBeUndefined();
  });
});

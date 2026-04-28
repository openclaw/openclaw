import { describe, expect, it } from "vitest";
import type { CoreConfig } from "../types.js";
import { resolveMatrixAccountConfig } from "./account-config.js";

describe("resolveMatrixAccountConfig", () => {
  it("deep-merges Matrix participation and freshness account overrides", () => {
    const cfg = {
      channels: {
        matrix: {
          historyLimit: 6,
          participation: {
            enabled: true,
            strategy: "ai-delivery-gate",
            model: "openai-codex/gpt-5.4-mini",
            minRoomMembers: 4,
            minAgentMembers: 2,
            persistence: "always",
          },
          freshness: {
            enabled: true,
            mode: "auto",
            scope: "room",
            draftHoldbackMs: 400,
            model: "openai-codex/gpt-5.4-mini",
            minRoomMembers: 5,
            minAgentMembers: 2,
            allowedFinalActions: ["revise", "send-as-is", "suppress"],
            aiDeterminesFinalAction: true,
          },
          accounts: {
            forge: {
              participation: {
                persistence: "explicit",
              },
              freshness: {
                draftHoldbackMs: 25,
              },
            },
          },
        },
      },
    } as CoreConfig;

    expect(resolveMatrixAccountConfig({ cfg, accountId: "forge" })).toMatchObject({
      historyLimit: 6,
      participation: {
        enabled: true,
        strategy: "ai-delivery-gate",
        model: "openai-codex/gpt-5.4-mini",
        minRoomMembers: 4,
        minAgentMembers: 2,
        persistence: "explicit",
      },
      freshness: {
        enabled: true,
        mode: "auto",
        scope: "room",
        draftHoldbackMs: 25,
        model: "openai-codex/gpt-5.4-mini",
        minRoomMembers: 5,
        minAgentMembers: 2,
        allowedFinalActions: ["revise", "send-as-is", "suppress"],
        aiDeterminesFinalAction: true,
      },
    });
  });
});

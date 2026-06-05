import { discordMessagingActionRuntime } from "../../extensions/discord/src/actions/runtime.messaging.runtime.js";
import { createDiscordMessagingActionContext } from "../../extensions/discord/src/actions/runtime.messaging.shared.js";

// Reproduction script for issue #90499:
// Discord message.read rejects allowlisted one-to-one DM channel targets.
// This script runs directly against production code in a real Node.js environment.
// Discord API is simulated via a temporary runtime patch so the read-guard logic
// can be exercised without a live bot token.

async function main() {
  console.log("=== Issue #90499 Reproduction ===\n");

  // Patch fetchChannelInfoDiscord to return DM metadata (type: 1, no guild_id, recipients present)
  const originalFetchChannelInfo = discordMessagingActionRuntime.fetchChannelInfoDiscord;
  discordMessagingActionRuntime.fetchChannelInfoDiscord = async (channelId: string) => {
    if (channelId === "DM1") {
      return {
        id: "DM1",
        type: 1,
        recipients: [{ id: "123456789012345678" }],
      };
    }
    if (channelId === "DM2") {
      return {
        id: "DM2",
        type: 1,
        recipients: [{ id: "999999999999999999" }],
      };
    }
    if (channelId === "GDM1") {
      return {
        id: "GDM1",
        type: 3,
        recipients: [{ id: "123456789012345678" }, { id: "999999999999999999" }],
      };
    }
    if (channelId === "DM_NO_RECIPIENTS") {
      return {
        id: "DM_NO_RECIPIENTS",
        type: 1,
      };
    }
    if (channelId === "DM_MULTI") {
      return {
        id: "DM_MULTI",
        type: 1,
        recipients: [{ id: "123456789012345678" }, { id: "999999999999999999" }],
      };
    }
    if (channelId === "TEXT_WITH_RECIPIENTS") {
      return {
        id: "TEXT_WITH_RECIPIENTS",
        type: 0,
        recipients: [{ id: "123456789012345678" }],
      };
    }
    throw new Error("Unknown channel");
  };

  try {
    // Case 1: DM recipient is allowlisted -> should PASS
    const ctx1 = createDiscordMessagingActionContext({
      action: "readMessages",
      input: { channelId: "DM1" },
      isActionEnabled: () => true,
      cfg: {
        channels: {
          discord: {
            token: "dummy-token",
            dmPolicy: "allowlist",
            allowFrom: ["123456789012345678"],
            groupPolicy: "allowlist",
          },
        },
      } as unknown as import("../extensions/discord/src/runtime-api.js").OpenClawConfig,
    });

    try {
      await ctx1.assertReadTargetAllowed({ channelId: "DM1" });
      console.log("✅ Case 1 PASS: DM read allowed when recipient is in allowFrom");
    } catch (e) {
      console.log("❌ Case 1 FAIL: DM read rejected for allowlisted recipient");
      console.log("   Error:", (e as Error).message);
      process.exitCode = 1;
    }

    // Case 2: DM recipient is NOT allowlisted -> should REJECT
    const ctx2 = createDiscordMessagingActionContext({
      action: "readMessages",
      input: { channelId: "DM2" },
      isActionEnabled: () => true,
      cfg: {
        channels: {
          discord: {
            token: "dummy-token",
            dmPolicy: "allowlist",
            allowFrom: ["123456789012345678"],
            groupPolicy: "allowlist",
          },
        },
      } as unknown as import("../extensions/discord/src/runtime-api.js").OpenClawConfig,
    });

    try {
      await ctx2.assertReadTargetAllowed({ channelId: "DM2" });
      console.log("❌ Case 2 FAIL: DM read allowed for non-allowlisted recipient");
      process.exitCode = 1;
    } catch (e) {
      console.log("✅ Case 2 PASS: DM read correctly rejected for non-allowlisted recipient");
      console.log("   Error:", (e as Error).message);
    }

    // Case 3: DM channel id in allowFrom (not recipient) -> should REJECT
    const ctx3 = createDiscordMessagingActionContext({
      action: "readMessages",
      input: { channelId: "DM1" },
      isActionEnabled: () => true,
      cfg: {
        channels: {
          discord: {
            token: "dummy-token",
            dmPolicy: "allowlist",
            allowFrom: ["DM1"],
            groupPolicy: "allowlist",
          },
        },
      } as unknown as import("../extensions/discord/src/runtime-api.js").OpenClawConfig,
    });

    try {
      await ctx3.assertReadTargetAllowed({ channelId: "DM1" });
      console.log(
        "❌ Case 3 FAIL: DM read allowed when channel id (not recipient) is in allowFrom",
      );
      process.exitCode = 1;
    } catch (e) {
      console.log("✅ Case 3 PASS: DM read correctly rejected when channel id is in allowFrom");
      console.log("   Error:", (e as Error).message);
    }

    // Case 4: Group DM with matching participant -> should REJECT (security boundary)
    const ctx4 = createDiscordMessagingActionContext({
      action: "readMessages",
      input: { channelId: "GDM1" },
      isActionEnabled: () => true,
      cfg: {
        channels: {
          discord: {
            token: "dummy-token",
            dmPolicy: "allowlist",
            allowFrom: ["123456789012345678"],
            groupPolicy: "allowlist",
          },
        },
      } as unknown as import("../extensions/discord/src/runtime-api.js").OpenClawConfig,
    });

    try {
      await ctx4.assertReadTargetAllowed({ channelId: "GDM1" });
      console.log("❌ Case 4 FAIL: Group DM read allowed for allowlisted participant");
      process.exitCode = 1;
    } catch (e) {
      console.log("✅ Case 4 PASS: Group DM read correctly rejected (security boundary)");
      console.log("   Error:", (e as Error).message);
    }

    // Case 5: DM with missing recipients metadata -> should REJECT
    const ctx5 = createDiscordMessagingActionContext({
      action: "readMessages",
      input: { channelId: "DM_NO_RECIPIENTS" },
      isActionEnabled: () => true,
      cfg: {
        channels: {
          discord: {
            token: "dummy-token",
            dmPolicy: "allowlist",
            allowFrom: ["123456789012345678"],
            groupPolicy: "allowlist",
          },
        },
      } as unknown as import("../extensions/discord/src/runtime-api.js").OpenClawConfig,
    });

    try {
      await ctx5.assertReadTargetAllowed({ channelId: "DM_NO_RECIPIENTS" });
      console.log("❌ Case 5 FAIL: DM read allowed when recipients metadata is missing");
      process.exitCode = 1;
    } catch (e) {
      console.log("✅ Case 5 PASS: DM read correctly rejected when recipients metadata is missing");
      console.log("   Error:", (e as Error).message);
    }

    // Case 6: DM with multiple recipients -> should REJECT
    const ctx6 = createDiscordMessagingActionContext({
      action: "readMessages",
      input: { channelId: "DM_MULTI" },
      isActionEnabled: () => true,
      cfg: {
        channels: {
          discord: {
            token: "dummy-token",
            dmPolicy: "allowlist",
            allowFrom: ["123456789012345678"],
            groupPolicy: "allowlist",
          },
        },
      } as unknown as import("../extensions/discord/src/runtime-api.js").OpenClawConfig,
    });

    try {
      await ctx6.assertReadTargetAllowed({ channelId: "DM_MULTI" });
      console.log("❌ Case 6 FAIL: DM read allowed when multiple recipients present");
      process.exitCode = 1;
    } catch (e) {
      console.log("✅ Case 6 PASS: DM read correctly rejected for multi-recipient DM");
      console.log("   Error:", (e as Error).message);
    }

    // Case 7: Non-DM channel with recipients -> should REJECT
    const ctx7 = createDiscordMessagingActionContext({
      action: "readMessages",
      input: { channelId: "TEXT_WITH_RECIPIENTS" },
      isActionEnabled: () => true,
      cfg: {
        channels: {
          discord: {
            token: "dummy-token",
            dmPolicy: "allowlist",
            allowFrom: ["123456789012345678"],
            groupPolicy: "allowlist",
          },
        },
      } as unknown as import("../extensions/discord/src/runtime-api.js").OpenClawConfig,
    });

    try {
      await ctx7.assertReadTargetAllowed({ channelId: "TEXT_WITH_RECIPIENTS" });
      console.log("❌ Case 7 FAIL: Non-DM read allowed when recipients match allowFrom");
      process.exitCode = 1;
    } catch (e) {
      console.log("✅ Case 7 PASS: Non-DM read correctly rejected despite matching recipients");
      console.log("   Error:", (e as Error).message);
    }
  } finally {
    // Restore original function
    discordMessagingActionRuntime.fetchChannelInfoDiscord = originalFetchChannelInfo;
  }

  console.log("\n=== Reproduction complete ===");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

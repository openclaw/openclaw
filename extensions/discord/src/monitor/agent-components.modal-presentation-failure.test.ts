import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerDiscordComponentEntries,
  resolveDiscordComponentEntryWithPersistence,
  resolveDiscordModalEntryWithPersistence,
} from "../components-registry.js";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import type { ComponentData } from "../internal/discord.js";
import { resetDiscordComponentRuntimeMocks } from "../test-support/component-runtime.js";
import { createDiscordComponentControls } from "./agent-components.js";
import {
  createButtonInteraction,
  ephemeralReply,
  modalFixture,
  modalReply,
} from "./agent-components.modal.test-support.js";

describe("Discord modal presentation failures", () => {
  beforeEach(() => {
    clearDiscordComponentEntriesForTest();
    resetDiscordComponentRuntimeMocks();
  });

  it.each([{ replyRejects: false }, { replyRejects: true }])(
    "handles a rejected modal callback with replyRejects=$replyRejects",
    async ({ replyRejects }) => {
      const sharedComponent = {
        messageId: "msg-1",
        sessionKey: "session-1",
        agentId: "agent-1",
        accountId: "default",
        consumptionGroupId: "group-1",
        consumptionGroupEntryIds: ["btn_1", "btn_cancel"],
      };
      await registerDiscordComponentEntries({
        entries: [
          {
            ...sharedComponent,
            id: "btn_1",
            kind: "modal-trigger",
            label: "Open form",
            modalId: "mdl_1",
          },
          { ...sharedComponent, id: "btn_cancel", kind: "button", label: "Cancel" },
        ],
        modals: [
          {
            ...modalFixture,
            messageId: "msg-1",
            sessionKey: "session-1",
            agentId: "agent-1",
            accountId: "default",
          },
        ],
      });

      const createButton = createDiscordComponentControls[0];
      if (!createButton) {
        throw new Error("expected Discord component button factory");
      }
      const cfg: OpenClawConfig = {
        channels: { discord: { replyToMode: "first" } },
      };
      const button = createButton({
        cfg,
        accountId: "default",
        dmPolicy: "allowlist",
        allowFrom: ["123456789"],
        discordConfig: { replyToMode: "first" },
        token: "token",
      });
      const post = vi.fn().mockRejectedValueOnce(new Error("Discord rejected the modal"));
      if (replyRejects) {
        post.mockRejectedValueOnce(new Error("Discord rejected the recovery reply"));
      } else {
        post.mockResolvedValueOnce(undefined);
      }
      const { interaction } = createButtonInteraction("interaction-1", post);

      await button.run(interaction, { cid: "btn_1", mid: "mdl_1" } as ComponentData);

      const callbackPath = "/interactions/interaction-1/interaction-token/callback";
      expect(post).toHaveBeenCalledTimes(2);
      expect(post).toHaveBeenNthCalledWith(1, callbackPath, modalReply());
      expect(post).toHaveBeenNthCalledWith(
        2,
        callbackPath,
        ephemeralReply("Could not open this form. Request a new form and try again."),
      );
      await expect(
        resolveDiscordComponentEntryWithPersistence({ id: "btn_1", consume: false }),
      ).resolves.toBeNull();
      await expect(
        resolveDiscordComponentEntryWithPersistence({ id: "btn_cancel", consume: false }),
      ).resolves.toBeNull();
      await expect(
        resolveDiscordModalEntryWithPersistence({ id: "mdl_1", consume: false }),
      ).resolves.toEqual(expect.objectContaining({ id: "mdl_1" }));
    },
  );
});

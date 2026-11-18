import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerDiscordComponentEntries,
  resolveDiscordComponentEntryWithPersistence,
  resolveDiscordModalEntryWithPersistence,
} from "../components-registry.js";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import type { ComponentData } from "../internal/discord.js";
import {
  dispatchPluginInteractiveHandlerMock,
  dispatchReplyMock,
  resetDiscordComponentRuntimeMocks,
} from "../test-support/component-runtime.js";
import { createDiscordComponentControls } from "./agent-components.js";
import {
  createButtonInteraction,
  ephemeralReply,
  modalFixture,
  modalReply,
} from "./agent-components.modal.test-support.js";
import type { DiscordLivePolicy, DiscordLivePolicyReader } from "./live-policy.js";

const cfg: OpenClawConfig = {
  channels: { discord: { dmPolicy: "allowlist", allowFrom: ["123456789"] } },
};
const policy: DiscordLivePolicy = {
  isCurrent: () => true,
  accountId: "default",
  cfg,
  discordConfig: { dmPolicy: "allowlist", allowFrom: ["123456789"] },
  guildEntries: undefined,
  allowFrom: ["123456789"],
  dmPolicy: "allowlist",
  groupPolicy: "allowlist",
  dmEnabled: true,
  groupDmEnabled: false,
  groupDmChannels: [],
  allowNameMatching: false,
};

async function createModalScenario(readPolicy: DiscordLivePolicyReader) {
  await registerDiscordComponentEntries({
    entries: [{ id: "btn_1", kind: "modal-trigger", label: "Open form", modalId: "mdl_1" }],
    modals: [modalFixture],
  });
  const createButton = createDiscordComponentControls[0];
  if (!createButton) {
    throw new Error("expected Discord button factory");
  }
  return createButton({ ...policy, readPolicy });
}

describe("Discord component policy deadlines", () => {
  beforeEach(() => {
    clearDiscordComponentEntriesForTest();
    resetDiscordComponentRuntimeMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["resolve", "reject"] as const)(
    "rejects a slow modal interaction without consuming it when policy later $0s",
    async (outcome) => {
      const pendingPolicy = createDeferred<DiscordLivePolicy>();
      const button = await createModalScenario(() => pendingPolicy.promise);
      const { interaction, post, patch } = createButtonInteraction("interaction-1");
      const data: ComponentData = { cid: "btn_1", mid: "mdl_1" };
      const run = button.run(interaction, data);

      await vi.advanceTimersByTimeAsync(1_001);

      expect(post).toHaveBeenCalledExactlyOnceWith(
        "/interactions/interaction-1/interaction-token/callback",
        ephemeralReply("Access policy is still updating. Try this interaction again."),
      );
      await run;
      await expect(
        resolveDiscordComponentEntryWithPersistence({ id: "btn_1", consume: false }),
      ).resolves.toEqual(expect.objectContaining({ id: "btn_1" }));
      await expect(
        resolveDiscordModalEntryWithPersistence({ id: "mdl_1", consume: false }),
      ).resolves.toEqual(expect.objectContaining({ id: "mdl_1" }));

      if (outcome === "resolve") {
        pendingPolicy.resolve(policy);
      } else {
        pendingPolicy.reject(new Error("late policy resolution failure"));
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(post).toHaveBeenCalledTimes(1);
      expect(patch).not.toHaveBeenCalled();
      expect(dispatchPluginInteractiveHandlerMock).not.toHaveBeenCalled();
      expect(dispatchReplyMock).not.toHaveBeenCalled();

      if (outcome === "resolve") {
        const next = createButtonInteraction("interaction-2");
        await button.run(next.interaction, data);
        expect(next.post).toHaveBeenCalledExactlyOnceWith(
          "/interactions/interaction-2/interaction-token/callback",
          modalReply(),
        );
      }
    },
  );

  it("reports a policy failure without opening or consuming the modal", async () => {
    const error = new Error("policy is unavailable");
    const button = await createModalScenario(async () => {
      throw error;
    });
    const { interaction, post } = createButtonInteraction("interaction-error");

    await expect(button.run(interaction, { cid: "btn_1", mid: "mdl_1" })).rejects.toBe(error);

    expect(post).toHaveBeenCalledExactlyOnceWith(
      "/interactions/interaction-error/interaction-token/callback",
      ephemeralReply("Could not verify the current access policy. Try this interaction again."),
    );
    await expect(
      resolveDiscordComponentEntryWithPersistence({ id: "btn_1", consume: false }),
    ).resolves.toEqual(expect.objectContaining({ id: "btn_1" }));
    expect(dispatchReplyMock).not.toHaveBeenCalled();
  });
});

import {
  ComponentType,
  type GuildMemberFlags,
  InteractionResponseType,
  InteractionType,
  MessageFlags,
} from "discord-api-types/v10";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { Container, TextDisplay } from "./components.message.js";
import {
  AutocompleteInteraction,
  BaseComponentInteraction,
  ModalInteraction,
  createInteraction,
  type RawInteraction,
} from "./interactions.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalInteractionPayload,
  createInternalModalInteractionPayload,
  createInternalTestClient,
} from "./test-builders.test-support.js";

const identity = { id: "interaction1", token: "token1" };
const callbackRoute = "/interactions/interaction1/token1/callback";
const originalRoute = "/webhooks/app1/token1/messages/%40original";
const v2Payload = {
  components: [{ type: 17, components: [{ type: 10, content: "done" }] }],
  flags: MessageFlags.IsComponentsV2,
};

function messageCallback(content: string) {
  return { body: { type: InteractionResponseType.ChannelMessageWithSource, data: { content } } };
}

function interactionFixture(
  overrides: Parameters<typeof attachRestMock>[1] = {},
  raw = createInternalInteractionPayload(identity),
) {
  const client = createInternalTestClient();
  const rest = attachRestMock(client, overrides);
  return {
    interaction: createInteraction(client, raw),
    post: rest.post,
    patch: rest.patch,
    delete: rest.delete,
  };
}

function pendingCallback() {
  const firstResponse = createDeferred<void>();
  const post = vi
    .fn()
    .mockImplementationOnce(() => firstResponse.promise)
    .mockResolvedValue(undefined);
  return { firstResponse, post };
}

describe("BaseInteraction", () => {
  it.each([
    { first: "accepted", operation: "reply" },
    { first: "rejected", operation: "reply" },
    { first: "accepted", operation: "followUp" },
  ] as const)("serializes $operation after the first callback is $first", async (testCase) => {
    const { firstResponse, post } = pendingCallback();
    const { interaction } = interactionFixture({ post });

    const first = interaction.reply("first");
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    const second = interaction[testCase.operation]("second");
    const callsBeforeAcceptance = post.mock.calls.length;
    expect(interaction).toMatchObject({ responseState: "unacknowledged", acknowledged: false });
    const settled = Promise.allSettled([first, second]);
    if (testCase.first === "accepted") {
      firstResponse.resolve();
    } else {
      firstResponse.reject(new Error("Discord rejected the first callback"));
    }

    const [firstResult, secondResult] = await settled;
    expect(callsBeforeAcceptance).toBe(1);
    expect(firstResult.status).toBe(testCase.first === "accepted" ? "fulfilled" : "rejected");
    expect(secondResult.status).toBe("fulfilled");
    expect(post).toHaveBeenNthCalledWith(1, callbackRoute, messageCallback("first"));
    if (testCase.first === "accepted") {
      expect(post).toHaveBeenNthCalledWith(
        2,
        "/webhooks/app1/token1",
        { body: { content: "second" } },
        undefined,
      );
    } else {
      expect(post).toHaveBeenNthCalledWith(2, callbackRoute, messageCallback("second"));
    }
    expect(interaction.responseState).toBe("replied");
  });

  it.each([
    { kind: "component", operation: "update" },
    { kind: "component", operation: "show-modal" },
    { kind: "component", operation: "launch-activity" },
    { kind: "autocomplete", operation: "autocomplete" },
  ] as const)(
    "rejects a second initial $kind $operation without calling Discord",
    async (testCase) => {
      const raw =
        testCase.kind === "component"
          ? createInternalComponentInteractionPayload(identity)
          : createInternalInteractionPayload({
              ...identity,
              type: InteractionType.ApplicationCommandAutocomplete,
            });
      const { interaction, post } = interactionFixture({}, raw);
      const first =
        testCase.kind === "autocomplete" && interaction instanceof AutocompleteInteraction
          ? interaction.respond([{ name: "First", value: "first" }])
          : interaction.reply("first");
      const next = () => {
        if (interaction instanceof AutocompleteInteraction) {
          return interaction.respond([{ name: "Second", value: "second" }]);
        }
        if (!(interaction instanceof BaseComponentInteraction)) {
          throw new Error("expected a component interaction");
        }
        switch (testCase.operation) {
          case "update":
            return interaction.update("second");
          case "show-modal":
            return interaction.showModal({ serialize: () => ({ title: "Choose" }) });
          case "launch-activity":
            return interaction.launchActivity();
          default:
            throw new Error("expected an initial interaction callback");
        }
      };

      const [firstResult, secondResult] = await Promise.allSettled([first, next()]);
      expect(firstResult.status).toBe("fulfilled");
      expect(secondResult.status).toBe("rejected");
      if (secondResult.status === "rejected") {
        expect(secondResult.reason).toMatchObject({
          message: expect.stringMatching(/already.*acknowledg/i),
        });
      }
      expect(post).toHaveBeenCalledOnce();
      expect(interaction.acknowledged).toBe(true);
    },
  );

  it("waits for the initial response before fetching the original reply", async () => {
    const firstResponse = createDeferred<void>();
    const post = vi.fn(() => firstResponse.promise);
    const get = vi.fn(async () => ({ id: "message1" }));
    const { interaction } = interactionFixture({ get, post });

    const initial = interaction.reply("first");
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    const fetched = interaction.fetchReply();
    const fetchesBeforeAcceptance = get.mock.calls.length;
    firstResponse.resolve();

    await expect(Promise.all([initial, fetched])).resolves.toEqual([undefined, { id: "message1" }]);
    expect(fetchesBeforeAcceptance).toBe(0);
    expect(get).toHaveBeenCalledWith(originalRoute);
  });

  it("keeps response transactions independent for different interactions", async () => {
    const { firstResponse, post } = pendingCallback();
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const firstInteraction = createInteraction(client, createInternalInteractionPayload(identity));
    const secondInteraction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction2", token: "token2" }),
    );

    const first = firstInteraction.reply("first");
    await vi.waitFor(() => expect(post).toHaveBeenCalledOnce());
    await secondInteraction.reply("second");
    expect(firstInteraction.responseState).toBe("unacknowledged");
    expect(secondInteraction.responseState).toBe("replied");
    firstResponse.resolve();
    await first;

    expect(post).toHaveBeenNthCalledWith(
      2,
      "/interactions/interaction2/token2/callback",
      messageCallback("second"),
    );
  });

  it("edits the original interaction response after defer", async () => {
    const { interaction, post, patch } = interactionFixture();

    await interaction.defer({ ephemeral: true });
    await interaction.reply({ content: "done", ephemeral: true });

    expect(post).toHaveBeenNthCalledWith(1, callbackRoute, {
      body: {
        type: InteractionResponseType.DeferredChannelMessageWithSource,
        data: { flags: 64 },
      },
    });
    expect(patch).toHaveBeenCalledWith(originalRoute, { body: { content: "done", flags: 64 } });
  });

  it("deletes the original interaction response after defer", async () => {
    const { interaction, delete: del } = interactionFixture();

    await interaction.defer();
    expect(interaction.responseState).toBe("deferred");
    await interaction.deleteReply();

    expect(del).toHaveBeenCalledWith(originalRoute);
    expect(interaction.responseState).toBe("replied");
  });

  it.each(["follow-up", "deferred edit"] as const)(
    "uses with_components for Components V2 %s",
    async (mode) => {
      const { interaction, post, patch } = interactionFixture();
      if (mode === "follow-up") {
        await interaction.reply("first");
      } else {
        await interaction.defer();
      }
      await interaction.reply({ components: [new Container([new TextDisplay("done")])] });
      const args = [{ body: v2Payload }, { with_components: true }];
      if (mode === "follow-up") {
        expect(post).toHaveBeenNthCalledWith(2, "/webhooks/app1/token1", ...args);
      } else {
        expect(patch).toHaveBeenCalledWith(originalRoute, ...args);
      }
    },
  );

  it("rejects malformed interaction payloads at the boundary", () => {
    expect(() =>
      createInteraction(createInternalTestClient(), {
        id: "interaction1",
        type: 3,
      } as unknown as RawInteraction),
    ).toThrow(/Invalid Discord interaction payload/);
  });

  it("preserves guild member user identity fields", () => {
    const { interaction } = interactionFixture(
      {},
      createInternalInteractionPayload({
        ...identity,
        type: InteractionType.ApplicationCommand,
        guild_id: "guild1",
        member: {
          roles: [],
          permissions: "0",
          flags: 0 as GuildMemberFlags,
          joined_at: "2026-01-01T00:00:00.000Z",
          deaf: false,
          mute: false,
          user: {
            id: "user1",
            username: "alice",
            global_name: "Alice Cooper",
            discriminator: "1234",
            avatar: null,
          },
        },
      }),
    );

    expect(interaction.user).toMatchObject({
      id: "user1",
      username: "alice",
      globalName: "Alice Cooper",
      discriminator: "1234",
    });
  });
});

describe("ModalInteraction", () => {
  it("reads submitted fields from Components V2 label wrappers", () => {
    const field = { type: ComponentType.TextInput, custom_id: "title", value: "Hello" };
    const { interaction } = interactionFixture(
      {},
      createInternalModalInteractionPayload({
        ...identity,
        data: { components: [{ type: ComponentType.Label, component: field }] },
      }),
    );

    expect(interaction).toBeInstanceOf(ModalInteraction);
    expect((interaction as ModalInteraction).fields.getText("title")).toBe("Hello");
  });

  it("edits the original modal source message after acknowledge", async () => {
    const { interaction, post, patch } = interactionFixture(
      {},
      createInternalModalInteractionPayload(identity),
    );

    await (interaction as ModalInteraction).acknowledge();
    await interaction.reply({ content: "cleared", components: [] });

    expect(post).toHaveBeenCalledExactlyOnceWith(callbackRoute, {
      body: { type: InteractionResponseType.DeferredMessageUpdate },
    });
    expect(patch).toHaveBeenCalledWith(originalRoute, {
      body: { content: "cleared", components: [] },
    });
  });
});

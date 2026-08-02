// Discord callback lifecycle tests prove acknowledgement and transport ownership.
import { InteractionResponseType, InteractionType } from "discord-api-types/v10";
import { describe, expect, it, vi } from "vitest";
import { createInteraction } from "./interactions.js";
import { RequestClient } from "./rest.js";
import {
  attachRestMock,
  createInternalComponentInteractionPayload,
  createInternalInteractionPayload,
  createInternalModalInteractionPayload,
  createInternalTestClient,
  createJsonResponse,
} from "./test-builders.test-support.js";

describe("Discord interaction callback lifecycle", () => {
  it("keeps failed slash-command defers unacknowledged so a visible reply can retry the callback", async () => {
    const callbackError = new Error("Discord callback transport unavailable");
    const post = vi.fn().mockRejectedValueOnce(callbackError).mockResolvedValueOnce(undefined);
    const patch = vi.fn();
    const client = createInternalTestClient();
    attachRestMock(client, { patch, post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.defer()).rejects.toBe(callbackError);
    expect(interaction.acknowledged).toBe(false);
    expect(interaction.responseState).toBe("unacknowledged");

    await interaction.reply({ content: "Recovered visible reply" });

    expect(post).toHaveBeenNthCalledWith(2, "/interactions/interaction1/token1/callback", {
      body: {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: "Recovered visible reply" },
      },
    });
    expect(patch).not.toHaveBeenCalled();
    expect(interaction.responseState).toBe("replied");
  });

  it("retries a failed initial reply through the interaction callback", async () => {
    const callbackError = new Error("Discord callback transport unavailable");
    const post = vi.fn().mockRejectedValueOnce(callbackError).mockResolvedValueOnce(undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.reply({ content: "First attempt" })).rejects.toBe(callbackError);
    expect(interaction.responseState).toBe("unacknowledged");

    await interaction.reply({ content: "Recovered visible reply" });

    expect(post).toHaveBeenNthCalledWith(2, "/interactions/interaction1/token1/callback", {
      body: {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: "Recovered visible reply" },
      },
    });
    expect(interaction.responseState).toBe("replied");
  });

  it.each(["dropped callback response", "HTTP 500"] as const)(
    "reconciles an accepted defer after %s and Discord's duplicate callback response",
    async (failureMode) => {
      const transportError = new Error("Discord callback response connection lost");
      const fetch = vi
        .fn()
        .mockImplementationOnce(async () => {
          if (failureMode === "HTTP 500") {
            return createJsonResponse({ message: "Discord upstream failed" }, { status: 500 });
          }
          throw transportError;
        })
        .mockResolvedValueOnce(
          createJsonResponse(
            { message: "Interaction has already been acknowledged", code: 40060 },
            { status: 400 },
          ),
        )
        .mockResolvedValueOnce(createJsonResponse({ id: "recovered-message" }));
      const client = createInternalTestClient();
      client.rest = new RequestClient("test-token", {
        baseUrl: "http://localhost",
        fetch,
        queueRequests: false,
      });
      const interaction = createInteraction(
        client,
        createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
      );

      if (failureMode === "HTTP 500") {
        await expect(interaction.defer()).rejects.toMatchObject({ status: 500 });
      } else {
        await expect(interaction.defer()).rejects.toBe(transportError);
      }
      expect(interaction.responseState).toBe("unacknowledged");

      await expect(interaction.reply({ content: "Recovered visible reply" })).resolves.toEqual({
        id: "recovered-message",
      });

      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[1]?.[0]).toBe(
        "http://localhost/v10/interactions/interaction1/token1/callback",
      );
      expect(fetch.mock.calls[2]?.[0]).toBe(
        "http://localhost/v10/webhooks/app1/token1/messages/%40original",
      );
      expect(fetch.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: "PATCH" }));
      expect(interaction.responseState).toBe("replied");
    },
  );

  it("reconciles an accepted initial response into a follow-up after its response is lost", async () => {
    const transportError = new Error("Discord callback response connection lost");
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(
        createJsonResponse(
          { message: "Interaction has already been acknowledged", code: 40060 },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(createJsonResponse({ id: "followup-message" }));
    const client = createInternalTestClient();
    client.rest = new RequestClient("test-token", {
      baseUrl: "http://localhost",
      fetch,
      queueRequests: false,
    });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.reply({ content: "Initial visible reply" })).rejects.toBe(
      transportError,
    );
    expect(interaction.responseState).toBe("unacknowledged");

    await expect(interaction.reply({ content: "Recovered visible follow-up" })).resolves.toEqual({
      id: "followup-message",
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]?.[0]).toBe("http://localhost/v10/webhooks/app1/token1");
    expect(fetch.mock.calls[2]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(interaction.responseState).toBe("replied");
  });

  it("does not treat definitive duplicate-callback errors as local acknowledgement evidence", async () => {
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        createJsonResponse(
          { message: "Interaction has already been acknowledged", code: 40060 },
          { status: 400 },
        ),
      );
    const client = createInternalTestClient();
    client.rest = new RequestClient("test-token", {
      baseUrl: "http://localhost",
      fetch,
      queueRequests: false,
    });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.defer()).rejects.toMatchObject({ discordCode: 40060 });
    await expect(interaction.reply({ content: "No local acknowledgement" })).rejects.toMatchObject({
      discordCode: 40060,
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(interaction.responseState).toBe("unacknowledged");
  });

  it("never attributes externally acknowledged interactions to later ambiguous local callbacks", async () => {
    const transportError = new Error("Later callback response connection lost");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse(
          { message: "Interaction has already been acknowledged", code: 40060 },
          { status: 400 },
        ),
      )
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(
        createJsonResponse(
          { message: "Interaction has already been acknowledged", code: 40060 },
          { status: 400 },
        ),
      );
    const client = createInternalTestClient();
    client.rest = new RequestClient("test-token", {
      baseUrl: "http://localhost",
      fetch,
      queueRequests: false,
    });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.defer()).rejects.toMatchObject({ discordCode: 40060 });
    await expect(interaction.reply({ content: "Unknown owner" })).rejects.toBe(transportError);
    await expect(interaction.reply({ content: "Still unknown owner" })).rejects.toMatchObject({
      discordCode: 40060,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, request]) => request?.method === "POST")).toBe(true);
    expect(interaction.responseState).toBe("unacknowledged");
  });

  it("does not reconcile callback ownership from a server error carrying a duplicate code", async () => {
    const transportError = new Error("Deferred callback response connection lost");
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(
        createJsonResponse(
          { message: "Upstream returned a misleading duplicate code", code: 40060 },
          { status: 500 },
        ),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          { message: "Interaction has already been acknowledged", code: 40060 },
          { status: 400 },
        ),
      );
    const client = createInternalTestClient();
    client.rest = new RequestClient("test-token", {
      baseUrl: "http://localhost",
      fetch,
      queueRequests: false,
    });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.defer()).rejects.toBe(transportError);
    await expect(interaction.reply({ content: "Server error" })).rejects.toMatchObject({
      status: 500,
      discordCode: 40060,
    });
    await expect(
      interaction.reply({ content: "Conflicting callback owner" }),
    ).rejects.toMatchObject({ status: 400, discordCode: 40060 });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, request]) => request?.method === "POST")).toBe(true);
    expect(interaction.responseState).toBe("unacknowledged");
  });

  it("does not guess which differing ambiguous callback Discord actually accepted", async () => {
    const firstTransportError = new Error("Deferred callback response connection lost");
    const secondTransportError = new Error("Initial reply response connection lost");
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(firstTransportError)
      .mockRejectedValueOnce(secondTransportError)
      .mockResolvedValueOnce(
        createJsonResponse(
          { message: "Interaction has already been acknowledged", code: 40060 },
          { status: 400 },
        ),
      );
    const client = createInternalTestClient();
    client.rest = new RequestClient("test-token", {
      baseUrl: "http://localhost",
      fetch,
      queueRequests: false,
    });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.defer()).rejects.toBe(firstTransportError);
    await expect(interaction.reply({ content: "Possibly accepted reply" })).rejects.toBe(
      secondTransportError,
    );
    await expect(interaction.reply({ content: "Ambiguous owner" })).rejects.toMatchObject({
      discordCode: 40060,
    });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, request]) => request?.method === "POST")).toBe(true);
    expect(interaction.responseState).toBe("unacknowledged");
  });

  it("reconciles repeated ambiguous callbacks when their response type stayed unique", async () => {
    const firstTransportError = new Error("First deferred callback response lost");
    const secondTransportError = new Error("Second deferred callback response lost");
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(firstTransportError)
      .mockRejectedValueOnce(secondTransportError)
      .mockResolvedValueOnce(
        createJsonResponse(
          { message: "Interaction has already been acknowledged", code: 40060 },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(createJsonResponse({ id: "recovered-message" }));
    const client = createInternalTestClient();
    client.rest = new RequestClient("test-token", {
      baseUrl: "http://localhost",
      fetch,
      queueRequests: false,
    });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.defer()).rejects.toBe(firstTransportError);
    await expect(interaction.defer()).rejects.toBe(secondTransportError);
    await expect(interaction.reply({ content: "Safely recovered defer" })).resolves.toEqual({
      id: "recovered-message",
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ method: "PATCH" }));
    expect(interaction.responseState).toBe("replied");
  });

  it("preserves genuine ambiguous ownership across a definitive unrelated rejection", async () => {
    const transportError = new Error("Deferred callback response connection lost");
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(transportError)
      .mockResolvedValueOnce(
        createJsonResponse({ message: "Invalid callback payload", code: 50035 }, { status: 400 }),
      )
      .mockResolvedValueOnce(
        createJsonResponse(
          { message: "Interaction has already been acknowledged", code: 40060 },
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(createJsonResponse({ id: "recovered-message" }));
    const client = createInternalTestClient();
    client.rest = new RequestClient("test-token", {
      baseUrl: "http://localhost",
      fetch,
      queueRequests: false,
    });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.defer()).rejects.toBe(transportError);
    await expect(interaction.reply({ content: "Invalid callback" })).rejects.toMatchObject({
      discordCode: 50035,
    });
    await expect(interaction.reply({ content: "Recover original defer" })).resolves.toEqual({
      id: "recovered-message",
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]?.[1]).toEqual(expect.objectContaining({ method: "PATCH" }));
    expect(interaction.responseState).toBe("replied");
  });

  it("waits for an in-flight defer before choosing the visible reply route", async () => {
    let resolveCallback!: () => void;
    const pendingCallback = new Promise<void>((resolve) => {
      resolveCallback = resolve;
    });
    const post = vi.fn().mockReturnValueOnce(pendingCallback);
    const patch = vi.fn().mockResolvedValue(undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { patch, post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    const deferred = interaction.defer();
    const visibleReply = interaction.reply({ content: "Waited for Discord" });

    expect(post).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
    resolveCallback();

    await Promise.all([deferred, visibleReply]);

    expect(post).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith("/webhooks/app1/token1/messages/%40original", {
      body: { content: "Waited for Discord" },
    });
    expect(interaction.responseState).toBe("replied");
  });

  it("retries an in-flight failed defer before posting the visible reply", async () => {
    let rejectCallback!: (error: Error) => void;
    const pendingCallback = new Promise<void>((_resolve, reject) => {
      rejectCallback = reject;
    });
    const callbackError = new Error("Discord callback transport unavailable");
    const post = vi.fn().mockReturnValueOnce(pendingCallback).mockResolvedValueOnce(undefined);
    const patch = vi.fn();
    const client = createInternalTestClient();
    attachRestMock(client, { patch, post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    const deferred = interaction.defer();
    const visibleReply = interaction.reply({ content: "Recovered visible reply" });

    expect(post).toHaveBeenCalledTimes(1);
    rejectCallback(callbackError);

    await expect(deferred).rejects.toBe(callbackError);
    await visibleReply;

    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenNthCalledWith(2, "/interactions/interaction1/token1/callback", {
      body: {
        type: InteractionResponseType.ChannelMessageWithSource,
        data: { content: "Recovered visible reply" },
      },
    });
    expect(patch).not.toHaveBeenCalled();
    expect(interaction.responseState).toBe("replied");
  });

  it.each([
    {
      label: "a second command defer",
      create: createInternalInteractionPayload,
      first: (interaction: ReturnType<typeof createInteraction>) => interaction.defer(),
      second: (interaction: ReturnType<typeof createInteraction>) => interaction.defer(),
      state: "deferred",
    },
    {
      label: "a modal after a component defer",
      create: createInternalComponentInteractionPayload,
      first: (interaction: ReturnType<typeof createInteraction>) => interaction.defer(),
      second: (interaction: ReturnType<typeof createInteraction>) =>
        (interaction as import("./interactions.js").BaseComponentInteraction).showModal({
          serialize: () => ({ custom_id: "modal1", title: "Duplicate form", components: [] }),
        }),
      state: "deferred",
    },
  ])(
    "rejects $label after an in-flight callback succeeds",
    async ({ create, first, second, state }) => {
      let resolveCallback!: () => void;
      const pendingCallback = new Promise<void>((resolve) => {
        resolveCallback = resolve;
      });
      const post = vi.fn().mockReturnValueOnce(pendingCallback);
      const client = createInternalTestClient();
      attachRestMock(client, { post });
      const interaction = createInteraction(
        client,
        create({ id: "interaction1", token: "token1" }),
      );

      const accepted = first(interaction);
      const duplicate = second(interaction);
      const rejectedDuplicate = expect(duplicate).rejects.toThrow(
        "Discord interaction already acknowledged",
      );

      expect(post).toHaveBeenCalledTimes(1);
      resolveCallback();

      await accepted;
      await rejectedDuplicate;

      expect(post).toHaveBeenCalledTimes(1);
      expect(interaction.responseState).toBe(state);
    },
  );

  it("rejects later direct callbacks after Discord already acknowledged the interaction", async () => {
    const post = vi.fn().mockResolvedValue(undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await interaction.defer();

    await expect(interaction.defer()).rejects.toThrow("Discord interaction already acknowledged");
    expect(post).toHaveBeenCalledTimes(1);
    expect(interaction.responseState).toBe("deferred");
  });

  it.each([
    {
      label: "component acknowledgement",
      type: InteractionResponseType.DeferredMessageUpdate,
      callback: (interaction: ReturnType<typeof createInteraction>) => interaction.acknowledge(),
      state: "deferred-update",
    },
    {
      label: "component update",
      type: InteractionResponseType.UpdateMessage,
      callback: (interaction: ReturnType<typeof createInteraction>) =>
        (interaction as import("./interactions.js").BaseComponentInteraction).update({
          content: "Updated visible reply",
        }),
      state: "replied",
    },
    {
      label: "modal presentation",
      type: InteractionResponseType.Modal,
      callback: (interaction: ReturnType<typeof createInteraction>) =>
        (interaction as import("./interactions.js").BaseComponentInteraction).showModal({
          serialize: () => ({ custom_id: "modal1", title: "Retry form", components: [] }),
        }),
      state: "replied",
    },
  ])("keeps failed $label callbacks retryable", async ({ callback, state, type }) => {
    const callbackError = new Error("Discord callback transport unavailable");
    const post = vi.fn().mockRejectedValueOnce(callbackError).mockResolvedValueOnce(undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalComponentInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(callback(interaction)).rejects.toBe(callbackError);
    expect(interaction.acknowledged).toBe(false);
    expect(interaction.responseState).toBe("unacknowledged");

    await callback(interaction);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[1]?.body).toEqual(expect.objectContaining({ type }));
    expect(interaction.responseState).toBe(state);
  });

  it("retries failed modal-submit acknowledgements through the same callback", async () => {
    const callbackError = new Error("Discord callback transport unavailable");
    const post = vi.fn().mockRejectedValueOnce(callbackError).mockResolvedValueOnce(undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalModalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.acknowledge()).rejects.toBe(callbackError);
    expect(interaction.responseState).toBe("unacknowledged");

    await interaction.acknowledge();

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[1]?.body).toEqual({
      type: InteractionResponseType.DeferredMessageUpdate,
    });
    expect(interaction.responseState).toBe("deferred-update");
  });

  it("retries failed autocomplete responses through the same callback", async () => {
    const callbackError = new Error("Discord callback transport unavailable");
    const post = vi.fn().mockRejectedValueOnce(callbackError).mockResolvedValueOnce(undefined);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({
        id: "interaction1",
        token: "token1",
        type: InteractionType.ApplicationCommandAutocomplete,
      }),
    );

    await expect(
      (interaction as import("./interactions.js").AutocompleteInteraction).respond([
        { name: "retry", value: "retry" },
      ]),
    ).rejects.toBe(callbackError);
    expect(interaction.responseState).toBe("unacknowledged");

    await (interaction as import("./interactions.js").AutocompleteInteraction).respond([
      { name: "retry", value: "retry" },
    ]);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[1]?.body).toEqual({
      type: InteractionResponseType.ApplicationCommandAutocompleteResult,
      data: { choices: [{ name: "retry", value: "retry" }] },
    });
    expect(interaction.responseState).toBe("replied");
  });

  it("preserves the actual successful callback response", async () => {
    const callbackResponse = { resource: { message: { id: "message1" } } };
    const post = vi.fn().mockResolvedValue(callbackResponse);
    const client = createInternalTestClient();
    attachRestMock(client, { post });
    const interaction = createInteraction(
      client,
      createInternalInteractionPayload({ id: "interaction1", token: "token1" }),
    );

    await expect(interaction.reply({ content: "Visible reply" })).resolves.toBe(callbackResponse);
    expect(interaction.acknowledged).toBe(true);
    expect(interaction.responseState).toBe("replied");
  });
});

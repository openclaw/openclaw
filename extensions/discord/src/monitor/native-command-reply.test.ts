import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { discordComponentRegistryState } from "../components-registry-state.js";
import { resolveDiscordComponentEntryWithPersistence } from "../components-registry.js";
import { clearDiscordComponentEntriesForTest } from "../components-registry.test-support.js";
import { parseDiscordComponentCustomId } from "../components.js";
import { Button, Container, Row, type MessagePayload } from "../internal/discord.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import {
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
  settleDiscordInteractionWithoutVisibleReply,
} from "./native-command-reply.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/web-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/web-media")>()),
  loadWebMedia: loadWebMediaMock,
}));

function createInteraction() {
  return {
    reply: vi.fn<(payload: MessagePayload) => Promise<unknown>>().mockResolvedValue({ ok: true }),
    followUp: vi
      .fn<(payload: MessagePayload) => Promise<unknown>>()
      .mockResolvedValue({ ok: true }),
  };
}

const componentRoute = {
  accountId: "work",
  agentId: "assistant",
  sessionKey: "agent:assistant:discord:direct:owner",
};

function deliver(
  params: Omit<
    Parameters<typeof deliverDiscordInteractionReply>[0],
    "textLimit" | "preferFollowUp" | "chunkMode"
  > & { preferFollowUp?: boolean },
) {
  return deliverDiscordInteractionReply({
    textLimit: 2000,
    preferFollowUp: false,
    chunkMode: "length",
    ...params,
  });
}

function presentation(buttons: [label: string, command: string][], text?: string) {
  return {
    blocks: [
      ...(text ? [{ type: "text" as const, text }] : []),
      {
        type: "buttons" as const,
        buttons: buttons.map(([label, command]) => ({
          label,
          action: { type: "command" as const, command },
        })),
      },
    ],
  };
}

async function expectUnregistered(ids: string[]) {
  for (const id of ids) {
    expect(await resolveDiscordComponentEntryWithPersistence({ id, consume: false })).toBeNull();
  }
}

beforeEach(() => {
  loadWebMediaMock.mockReset();
  clearDiscordComponentEntriesForTest();
});

afterEach(() => clearDiscordComponentEntriesForTest());

it.each([
  [false, false],
  [true, false],
  [false, true],
])(
  "registers buttons after native acceptance (follow-up=%s, expired=%s)",
  async (preferFollowUp, expires) => {
    const interaction = createInteraction();
    const started = createDeferred<void>();
    const accepted = createDeferred<unknown>();
    const sender = preferFollowUp ? interaction.followUp : interaction.reply;
    sender.mockImplementation(() => {
      started.resolve();
      return accepted.promise;
    });
    const choices: [string, string][] = [
      ["All models", "/login choice token 0"],
      ["Keep restrictions", "/login choice token 1"],
    ];
    const delivery = deliver({
      interaction: interaction as never,
      payload: {
        text: "Choose model access: /login choice token 0 or /login choice token 1",
        presentationTextMode: "fallback",
        presentation: presentation(choices, "Credentials saved. Choose model access."),
      },
      componentRoute,
      preferFollowUp,
      responseEphemeral: true,
    });
    const outcome = delivery.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    await started.promise;
    const message = sender.mock.calls[0]?.[0];
    assert(message && typeof message !== "string");
    expect(message).not.toHaveProperty("content");
    expect(message.ephemeral).toBe(true);
    const container = message.components?.[0];
    assert(container instanceof Container);
    const buttons = container.components
      .flatMap((part) => (part instanceof Row ? part.components : []))
      .filter((part): part is Button => part instanceof Button);
    expect(buttons.map((button) => button.label)).toEqual(["All models", "Keep restrictions"]);
    const ids = buttons.map((button) => {
      const parsed = parseDiscordComponentCustomId(button.customId);
      assert(parsed);
      return parsed.componentId;
    });
    await expectUnregistered(ids);
    if (expires) {
      accepted.reject({ discordCode: 10062 });
    } else {
      accepted.resolve(preferFollowUp ? { id: "native-message" } : undefined);
    }
    const result = await outcome;
    if (expires) {
      expect(result).toEqual({ error: expect.any(PlatformMessageNotDispatchedError) });
      await expectUnregistered(ids);
      return;
    }
    expect(result).toEqual({ value: true });
    const entries = await Promise.all(
      ids.map((id) => resolveDiscordComponentEntryWithPersistence({ id, consume: false })),
    );
    expect(entries.map((entry) => [entry?.label, entry?.callbackData])).toEqual([
      ["All models", "/login choice token 0"],
      ["Keep restrictions", "/login choice token 1"],
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        ...componentRoute,
        callbackDataKind: "command",
      });
      expect(entry?.messageId).toBe(preferFollowUp ? "native-message" : undefined);
    }
  },
);

it.each([false, true])(
  "waits for native button persistence without changing delivery on failure=%s",
  async (fail) => {
    const started = createDeferred<void>();
    const registered = createDeferred<void>();
    discordComponentRegistryState.persistentComponentStore = {
      register: async () => {
        started.resolve();
        await registered.promise;
      },
      lookup: async () => undefined,
      consume: async () => undefined,
      delete: async () => false,
    };
    const interaction = createInteraction();
    let completed = false;
    const delivery = deliver({
      interaction: interaction as never,
      payload: { presentation: presentation([["Choose", "/help"]]) },
      componentRoute,
    }).then((value) => {
      completed = true;
      return value;
    });
    try {
      await started.promise;
      await setImmediate();
      expect(interaction.reply).toHaveBeenCalledOnce();
      expect(completed).toBe(false);
      if (fail) {
        registered.reject(new Error("synthetic persistence unavailable"));
      } else {
        registered.resolve();
      }
      expect(await delivery).toBe(true);
      expect(discordComponentRegistryState.persistentRegistryDisabled).toBe(fail);
    } finally {
      registered.resolve();
      await delivery;
    }
  },
);

it("preserves native attachments and embeds with shared presentation", async () => {
  const interaction = createInteraction();
  const onDelivered = vi.fn(async () => {});
  const embeds = [{ title: "Status" }];
  loadWebMediaMock.mockResolvedValue({
    buffer: Buffer.from("image"),
    fileName: "status.png",
    contentType: "image/png",
  });

  await deliver({
    interaction: interaction as never,
    payload: {
      text: "x".repeat(2_100),
      presentationTextMode: "fallback",
      presentation: presentation([["Continue", "/status"]], "Status details"),
      mediaUrls: ["file:///tmp/status.png"],
      channelData: { discord: { embeds } },
    },
    onDelivered,
  });

  expect(interaction.reply).toHaveBeenCalledWith({
    content: "x".repeat(2_000),
    embeds,
    files: [{ name: "status.png", data: Buffer.from("image"), contentType: "image/png" }],
  });
  expect(interaction.followUp).toHaveBeenCalledWith({ content: "x".repeat(100) });
  expect(onDelivered).toHaveBeenCalledExactlyOnceWith(
    ["x".repeat(2_000), "Status", "x".repeat(100)].join("\n"),
  );
});

it("omits legacy content and embeds from native Components V2 replies", async () => {
  const interaction = createInteraction();
  const onDelivered = vi.fn(async () => {});
  const components = [
    {
      type: 17,
      components: [
        { type: 10, content: "Choose" },
        {
          type: 9,
          components: [{ type: 10, content: "Actions" }],
          accessory: { type: 2, style: 1, label: "Read", custom_id: "private-action-id" },
        },
      ],
    },
  ];

  await deliver({
    interaction: interaction as never,
    payload: {
      text: "legacy fallback",
      channelData: { discord: { components, embeds: [{ title: "legacy embed" }] } },
    },
    onDelivered,
  });

  expect(interaction.reply).toHaveBeenCalledWith({ components });
  expect(interaction.followUp).not.toHaveBeenCalled();
  expect(onDelivered).toHaveBeenCalledExactlyOnceWith("Choose\nActions\nRead");
});

it("sends singular WebP media after blank plural URLs across a real multipart request", async () => {
  const loopback = await createDiscordLoopbackRest();
  loadWebMediaMock.mockResolvedValue({
    buffer: Buffer.from("webp"),
    fileName: "sticker.webp",
    contentType: "image/webp",
    kind: "image",
  });
  const interaction = {
    reply: vi.fn(async (data: unknown) =>
      loopback.rest.post("/interactions/123/token/callback", { body: { type: 4, data } }),
    ),
    followUp: vi.fn(),
  };

  try {
    const payload = { text: "sticker", mediaUrls: ["   "], mediaUrl: "file:///tmp/sticker.webp" };
    expect(hasRenderableReplyPayload(payload)).toBe(true);

    await deliver({ interaction: interaction as never, payload });

    expect(loadWebMediaMock).toHaveBeenCalledWith("file:///tmp/sticker.webp", {
      localRoots: undefined,
    });
    const upload = loopback.requests.find((request) => request.method === "POST");
    expect(upload).toMatchObject({
      path: expect.stringContaining("/interactions/123/token/callback"),
      contentType: expect.stringMatching(/^multipart\/form-data; boundary=/),
    });
    expect(upload?.body).toContain('name="files[0]"; filename="sticker.webp"');
    expect(upload?.body).toContain("Content-Type: image/webp");
  } finally {
    await loopback.close();
  }
});
it.each([
  ["deferred", 1],
  ["deferred-update", 0],
] as const)("settles %s without deleting component messages", async (responseState, calls) => {
  const interaction = { responseState, deleteReply: vi.fn().mockResolvedValue(undefined) };
  await settleDiscordInteractionWithoutVisibleReply(interaction as never);
  expect(interaction.deleteReply).toHaveBeenCalledTimes(calls);
});

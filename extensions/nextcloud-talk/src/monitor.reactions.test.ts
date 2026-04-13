import { describe, expect, it, vi } from "vitest";
import {
  createSignedLikeReactionRequest,
  createSignedUndoLikeReactionRequest,
} from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";
import type { NextcloudTalkInboundReaction } from "./types.js";

describe("createNextcloudTalkWebhookServer reaction dispatch", () => {
  it("decodes a Like activity and forwards the reaction with action=added", async () => {
    const captured: NextcloudTalkInboundReaction[] = [];
    const harness = await startWebhookServer({
      path: "/nextcloud-react-like",
      onMessage: vi.fn(),
      onReaction: async (reaction) => {
        captured.push(reaction);
      },
    });

    const { body, headers } = createSignedLikeReactionRequest({
      actorId: "bob",
      actorName: "Bob",
      emoji: "👍",
      messageId: "42",
      roomToken: "room-abc",
    });

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      action: "added",
      emoji: "👍",
      messageId: "42",
      roomToken: "room-abc",
      senderId: "bob",
      senderName: "Bob",
    });
  });

  it("decodes an Undo of Like activity and forwards the reaction with action=removed", async () => {
    const captured: NextcloudTalkInboundReaction[] = [];
    const harness = await startWebhookServer({
      path: "/nextcloud-react-undo",
      onMessage: vi.fn(),
      onReaction: async (reaction) => {
        captured.push(reaction);
      },
    });

    const { body, headers } = createSignedUndoLikeReactionRequest({
      actorId: "bob",
      actorName: "Bob",
      emoji: "👍",
      messageId: "42",
      roomToken: "room-abc",
    });

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers,
      body,
    });

    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      action: "removed",
      emoji: "👍",
      messageId: "42",
      roomToken: "room-abc",
      senderId: "bob",
    });
  });

  it("does not invoke onMessage when the activity is a reaction", async () => {
    const onMessage = vi.fn(async () => {});
    const onReaction = vi.fn(async () => {});
    const harness = await startWebhookServer({
      path: "/nextcloud-react-routing",
      onMessage,
      onReaction,
    });

    const { body, headers } = createSignedLikeReactionRequest();
    await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(onReaction).toHaveBeenCalledTimes(1);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("acknowledges replayed reactions without invoking onReaction", async () => {
    const onReaction = vi.fn(async () => {});
    const seen = new Set<string>();
    const shouldProcessReaction = vi.fn(async (reaction: NextcloudTalkInboundReaction) => {
      const key = `${reaction.roomToken}:${reaction.messageId}:${reaction.emoji}:${reaction.senderId}:${reaction.action}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    const harness = await startWebhookServer({
      path: "/nextcloud-react-replay",
      onMessage: vi.fn(),
      shouldProcessReaction,
      onReaction,
    });

    const { body, headers } = createSignedLikeReactionRequest();
    const first = await fetch(harness.webhookUrl, { method: "POST", headers, body });
    const second = await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(shouldProcessReaction).toHaveBeenCalledTimes(2);
    expect(onReaction).toHaveBeenCalledTimes(1);
  });

  it("answers 200 when a reaction arrives but no onReaction handler is configured", async () => {
    const harness = await startWebhookServer({
      path: "/nextcloud-react-no-handler",
      onMessage: vi.fn(),
    });

    const { body, headers } = createSignedLikeReactionRequest();
    const response = await fetch(harness.webhookUrl, { method: "POST", headers, body });

    expect(response.status).toBe(200);
  });

  it("rejects a malformed Undo payload (non-Like inner object)", async () => {
    const payload = {
      type: "Undo",
      actor: { type: "Person", id: "bob", name: "Bob" },
      // Inner object is not a Like — should fail schema validation.
      object: {
        type: "Note",
        id: "msg-1",
        name: "hello",
        content: "hi",
        mediaType: "text/plain",
      },
      target: { type: "Collection", id: "room-1", name: "Room 1" },
    };
    const body = JSON.stringify(payload);
    const { random, signature } = generateNextcloudTalkSignature({
      body,
      secret: "nextcloud-secret", // pragma: allowlist secret
    });
    const harness = await startWebhookServer({
      path: "/nextcloud-react-undo-bad",
      onMessage: vi.fn(),
      onReaction: vi.fn(),
    });

    const response = await fetch(harness.webhookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nextcloud-talk-random": random,
        "x-nextcloud-talk-signature": signature,
        "x-nextcloud-talk-backend": "https://nextcloud.example",
      },
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid payload format" });
  });
});

import { generateNextcloudTalkSignature } from "./signature.js";

function signPayload(payload: Record<string, unknown>, backend?: string) {
  const body = JSON.stringify(payload);
  const { random, signature } = generateNextcloudTalkSignature({
    body,
    secret: "nextcloud-secret", // pragma: allowlist secret
  });
  return {
    body,
    headers: {
      "content-type": "application/json",
      "x-nextcloud-talk-random": random,
      "x-nextcloud-talk-signature": signature,
      "x-nextcloud-talk-backend": backend ?? "https://nextcloud.example",
    },
  };
}

export function createSignedCreateMessageRequest(params?: { backend?: string }) {
  return signPayload(
    {
      type: "Create",
      actor: { type: "Person", id: "alice", name: "Alice" },
      object: {
        type: "Note",
        id: "msg-1",
        name: "hello",
        content: "hello",
        mediaType: "text/plain",
      },
      target: { type: "Collection", id: "room-1", name: "Room 1" },
    },
    params?.backend,
  );
}

export function createSignedLikeReactionRequest(params?: {
  backend?: string;
  actorId?: string;
  actorName?: string;
  emoji?: string;
  messageId?: string;
  roomToken?: string;
}) {
  return signPayload(
    {
      type: "Like",
      actor: {
        type: "Person",
        id: params?.actorId ?? "bob",
        name: params?.actorName ?? "Bob",
      },
      object: {
        type: "Note",
        id: params?.messageId ?? "msg-1",
        name: "reaction",
        content: params?.emoji ?? "👍",
        mediaType: "text/plain",
      },
      target: {
        type: "Collection",
        id: params?.roomToken ?? "room-1",
        name: "Room 1",
      },
    },
    params?.backend,
  );
}

export function createSignedUndoLikeReactionRequest(params?: {
  backend?: string;
  actorId?: string;
  actorName?: string;
  emoji?: string;
  messageId?: string;
  roomToken?: string;
}) {
  const likeInner = {
    type: "Like",
    actor: {
      type: "Person",
      id: params?.actorId ?? "bob",
      name: params?.actorName ?? "Bob",
    },
    object: {
      type: "Note",
      id: params?.messageId ?? "msg-1",
      name: "reaction",
      content: params?.emoji ?? "👍",
      mediaType: "text/plain",
    },
    target: {
      type: "Collection",
      id: params?.roomToken ?? "room-1",
      name: "Room 1",
    },
  };
  return signPayload(
    {
      type: "Undo",
      actor: likeInner.actor,
      object: likeInner,
      target: likeInner.target,
    },
    params?.backend,
  );
}

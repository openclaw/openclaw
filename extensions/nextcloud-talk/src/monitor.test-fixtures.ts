// Nextcloud Talk plugin module implements monitor fixtures behavior.
import { generateNextcloudTalkSignature } from "./signature.js";

export function createSignedCreateMessageRequest(params?: { backend?: string }) {
  const payload = {
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
  };
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
      "x-nextcloud-talk-backend": params?.backend ?? "https://nextcloud.example",
    },
  };
}

/** Create a signed webhook request with a non-Note object type (e.g. file share). */
export function createSignedNonNoteMessageRequest(params?: { backend?: string }) {
  const payload = {
    type: "Create",
    actor: { type: "Person", id: "alice", name: "Alice" },
    object: {
      type: "Document",
      id: "file-1",
      name: "document.pdf",
      content: "application/pdf",
      mediaType: "application/pdf",
    },
    target: { type: "Collection", id: "room-1", name: "Room 1" },
  };
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
      "x-nextcloud-talk-backend": params?.backend ?? "https://nextcloud.example",
    },
  };
}

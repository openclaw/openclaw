// Process-global bridge for the web-chat Mercure topic.
//
// The web frontend picks an opaque per-session Mercure topic and sends it in the
// chat message; only the rabbitmq-consumer plugin sees it (chatMsg.topic). The
// completion notifier must deliver proactive messages to that exact topic, so the
// consumer records uid -> topic here and the notifier reads it. Shared via
// Symbol.for (a process-wide contract) because the plugin boundary forbids a
// cross-extension import.
const SYMBOL = Symbol.for("openclaw.chat.mercureTopicByUid");

function topicMap(): Map<string, string> {
  const g = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
  let map = g[SYMBOL];
  if (!map) {
    map = new Map<string, string>();
    g[SYMBOL] = map;
  }
  return map;
}

export function getChatMercureTopic(uid: string): string | undefined {
  return topicMap().get(uid);
}

export function setChatMercureTopic(uid: string, topic: string): void {
  topicMap().set(uid, topic);
}

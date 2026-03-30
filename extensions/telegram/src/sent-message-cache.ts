/**
 * In-memory cache of sent message IDs per chat.
 * Used to identify bot's own messages for reaction filtering ("own" mode).
 */

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Keep sent-message tracking shared across bundled chunks so Telegram reaction
 * filters see the same sent-message history regardless of which chunk recorded it.
 */
const TELEGRAM_SENT_MESSAGES_KEY = Symbol.for("openclaw.telegramSentMessages");

let sentMessages: Map<string, Map<string, number>> | undefined;

function getSentMessages(): Map<string, Map<string, number>> {
	if (!sentMessages) {
		const globalStore = globalThis as Record<PropertyKey, unknown>;
		sentMessages =
			(globalStore[TELEGRAM_SENT_MESSAGES_KEY] as
				| Map<string, Map<string, number>>
				| undefined) ?? new Map<string, Map<string, number>>();
		globalStore[TELEGRAM_SENT_MESSAGES_KEY] = sentMessages;
	}
	return sentMessages;
}

function cleanupExpired(
	scopeKey: string,
	entry: Map<string, number>,
	now: number,
): void {
	for (const [id, timestamp] of entry) {
		if (now - timestamp > TTL_MS) {
			entry.delete(id);
		}
	}
	if (entry.size === 0) {
		getSentMessages().delete(scopeKey);
	}
}

/**
 * Record a message ID as sent by the bot.
 */
export function recordSentMessage(
	chatId: number | string,
	messageId: number,
): void {
	const scopeKey = String(chatId);
	const idKey = String(messageId);
	const now = Date.now();
	const store = getSentMessages();
	let entry = store.get(scopeKey);
	if (!entry) {
		entry = new Map<string, number>();
		store.set(scopeKey, entry);
	}
	entry.set(idKey, now);
	if (entry.size > 100) {
		cleanupExpired(scopeKey, entry, now);
	}
}

/**
 * Check if a message was sent by the bot.
 */
export function wasSentByBot(
	chatId: number | string,
	messageId: number,
): boolean {
	const scopeKey = String(chatId);
	const idKey = String(messageId);
	const entry = getSentMessages().get(scopeKey);
	if (!entry) {
		return false;
	}
	cleanupExpired(scopeKey, entry, Date.now());
	return entry.has(idKey);
}

/**
 * Clear all cached entries (for testing).
 */
export function clearSentMessageCache(): void {
	getSentMessages().clear();
}

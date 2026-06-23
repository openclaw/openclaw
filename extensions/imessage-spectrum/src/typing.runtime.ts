const TYPING_THROTTLE_MS = 4_000;

const lastTypingBySpaceId = new Map<string, number>();

export function shouldSendSpectrumTyping(spaceId: string, now: number = Date.now()): boolean {
  const last = lastTypingBySpaceId.get(spaceId) ?? 0;
  if (now - last < TYPING_THROTTLE_MS) {
    return false;
  }
  lastTypingBySpaceId.set(spaceId, now);
  return true;
}

export async function sendSpectrumTyping(params: {
  spaceId: string;
  ensureApp: (force?: boolean) => Promise<unknown>;
  getSpace: (spaceId: string) => Promise<unknown>;
}): Promise<void> {
  if (!shouldSendSpectrumTyping(params.spaceId)) {
    return;
  }
  await params.ensureApp();
  const space = await params.getSpace(params.spaceId);
  if (typeof (space as { startTyping?: () => Promise<void> })?.startTyping === "function") {
    await (space as { startTyping: () => Promise<void> }).startTyping();
  }
}

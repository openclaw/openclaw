import { readLatestNemoClawDigestCache } from "./latest-digest-cache.js";
import { formatSlackDigestNotification } from "./slack-digest.js";

function normalizeArgs(value: string | undefined): string {
  return value?.trim().toLowerCase() || "";
}

export async function handleNemoClawCommand(args: string | undefined): Promise<{ text: string }> {
  const normalized = normalizeArgs(args);
  if (!normalized || normalized === "digest") {
    const latest = await readLatestNemoClawDigestCache();
    const text = formatSlackDigestNotification(latest ?? undefined);
    if (text) {
      return { text };
    }
    return { text: "No notification_digest_summary available." };
  }
  return { text: "Usage: /nemoclaw digest" };
}

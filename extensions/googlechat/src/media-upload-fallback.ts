// Under Google Chat *app* (bot) authentication the granted scope is chat.bot (see auth.ts
// CHAT_SCOPE), which is NOT authorized for the attachment upload endpoint. Google's OAuth
// layer rejects the upload with a 403 whose body says "Request had insufficient authentication
// scopes" (reason ACCESS_TOKEN_SCOPE_INSUFFICIENT). The media itself is reachable at a public
// URL, so rather than silently dropping it (the prior behavior, which lost the message) we fall
// back to delivering the URL as a text link.
//
// Keep this narrow on BOTH axes so a link never masks a failure it can't fix:
//   - only this *scope* denial qualifies — a bare 403, quota (RESOURCE_EXHAUSTED), not-a-member
//     or any other PERMISSION_DENIED upload error still surfaces (a text link wouldn't deliver
//     to a space the bot can't post to, or fix a quota problem);
//   - only remote http(s) media qualifies — a local file has no public URL to fall back to.
// #89430

export function isAuthScopeUploadFailure(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err ?? "");
  if (!message) {
    return false;
  }
  // Match Google's documented OAuth scope-denial signals specifically, NOT a bare 403 or a
  // generic PERMISSION_DENIED, so non-scope upload denials are not misclassified as scope
  // failures and silently degraded to a link.
  return (
    /insufficient authentication scopes?/i.test(message) ||
    /ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(message)
  );
}

export function isRemoteHttpMediaUrl(mediaUrl: string | null | undefined): mediaUrl is string {
  return typeof mediaUrl === "string" && /^https?:\/\//i.test(mediaUrl);
}

export function buildMediaLinkFallbackText(
  text: string | null | undefined,
  mediaUrl: string,
): string {
  const trimmed = (text ?? "").trim();
  return trimmed.length > 0 ? `${trimmed}\n${mediaUrl}` : mediaUrl;
}

import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/auto-reply/reply/inbound-media.ts
function hasNormalizedStringEntry(values) {
	return Array.isArray(values) && values.some((value) => normalizeOptionalString(value));
}
function hasInboundMedia(ctx) {
	return Boolean(ctx.StickerMediaIncluded || ctx.Sticker || normalizeOptionalString(ctx.MediaPath) || normalizeOptionalString(ctx.MediaUrl) || hasNormalizedStringEntry(ctx.MediaPaths) || hasNormalizedStringEntry(ctx.MediaUrls) || Array.isArray(ctx.MediaTypes) && ctx.MediaTypes.length > 0);
}
//#endregion
export { hasInboundMedia as t };

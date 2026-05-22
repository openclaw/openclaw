import { h as MarkdownConfigSchema, o as DmPolicySchema } from "../../zod-schema.core-C-ZXJ5Xx.js";
import { t as AllowFromListSchema } from "../../config-schema-BmvPUIYK.js";
import { r as buildSecretInputSchema } from "../../secret-input-DlpywVD3.js";
import "../../status-helpers-BpxzCz5l.js";
import "../../direct-dm-access-CD1UG-91.js";
import "../../channel-plugin-common-6lb5RnKU.js";
import "../../channel-config-primitives-DO6QJ-Wa.js";
import { t as zod_exports } from "../../zod-Ct0CvXmO.js";
//#region extensions/nostr/src/config-schema.ts
/**
* Validates https:// URLs only (no javascript:, data:, file:, etc.)
*/
const safeUrlSchema = zod_exports.z.string().url().refine((url) => {
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
}, { message: "URL must use https:// protocol" });
/**
* NIP-01 profile metadata schema
* https://github.com/nostr-protocol/nips/blob/master/01.md
*/
const NostrProfileSchema = zod_exports.z.object({
	/** Username (NIP-01: name) - max 256 chars */
	name: zod_exports.z.string().max(256).optional(),
	/** Display name (NIP-01: display_name) - max 256 chars */
	displayName: zod_exports.z.string().max(256).optional(),
	/** Bio/description (NIP-01: about) - max 2000 chars */
	about: zod_exports.z.string().max(2e3).optional(),
	/** Profile picture URL (must be https) */
	picture: safeUrlSchema.optional(),
	/** Banner image URL (must be https) */
	banner: safeUrlSchema.optional(),
	/** Website URL (must be https) */
	website: safeUrlSchema.optional(),
	/** NIP-05 identifier (e.g., "user@example.com") */
	nip05: zod_exports.z.string().optional(),
	/** Lightning address (LUD-16) */
	lud16: zod_exports.z.string().optional()
});
/**
* Zod schema for channels.nostr.* configuration
*/
const NostrConfigSchema = zod_exports.z.object({
	/** Account name (optional display name) */
	name: zod_exports.z.string().optional(),
	/** Optional default account id for routing/account selection. */
	defaultAccount: zod_exports.z.string().optional(),
	/** Whether this channel is enabled */
	enabled: zod_exports.z.boolean().optional(),
	/** Markdown formatting overrides (tables). */
	markdown: MarkdownConfigSchema,
	/** Private key in hex or nsec bech32 format */
	privateKey: buildSecretInputSchema().optional(),
	/** WebSocket relay URLs to connect to */
	relays: zod_exports.z.array(zod_exports.z.string()).optional(),
	/** DM access policy: pairing, allowlist, open, or disabled */
	dmPolicy: DmPolicySchema.optional(),
	/** Allowed sender pubkeys (npub or hex format) */
	allowFrom: AllowFromListSchema,
	/** Profile metadata (NIP-01 kind:0 content) */
	profile: NostrProfileSchema.optional()
});
//#endregion
export { NostrProfileSchema as n, NostrConfigSchema as t };

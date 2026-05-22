import { o as hasConfiguredSecretInput } from "./types.secrets-CyuYZNvB.js";
import { l as ToolPolicySchema } from "./zod-schema.agent-runtime-BCC1nYgp.js";
import { h as MarkdownConfigSchema, l as GroupPolicySchema, o as DmPolicySchema } from "./zod-schema.core-CPi3jzrG.js";
import { n as buildCatchallMultiAccountChannelSchema, r as buildChannelConfigSchema, t as AllowFromListSchema } from "./config-schema-Cv6_wz1q.js";
import { r as buildSecretInputSchema } from "./secret-input-CBwDj35T.js";
import "./channel-config-schema-Dl3Cey7p.js";
import { t as zod_exports } from "./zod-CFS1lR7l.js";
import "./secret-input-Bg88Zfkr.js";
//#region extensions/bluebubbles/src/config-ui-hints.ts
const bluebubblesChannelConfigUiHints = {
	"": {
		label: "BlueBubbles",
		help: "BlueBubbles channel provider configuration used for Apple messaging bridge integrations. Keep DM policy aligned with your trusted sender model in shared deployments."
	},
	dmPolicy: {
		label: "BlueBubbles DM Policy",
		help: "Direct message access control (\"pairing\" recommended). \"open\" requires channels.bluebubbles.allowFrom=[\"*\"]."
	}
};
//#endregion
//#region extensions/bluebubbles/src/config-schema.ts
const bluebubblesActionSchema = zod_exports.z.object({
	reactions: zod_exports.z.boolean().default(true),
	edit: zod_exports.z.boolean().default(true),
	unsend: zod_exports.z.boolean().default(true),
	reply: zod_exports.z.boolean().default(true),
	sendWithEffect: zod_exports.z.boolean().default(true),
	renameGroup: zod_exports.z.boolean().default(true),
	setGroupIcon: zod_exports.z.boolean().default(true),
	addParticipant: zod_exports.z.boolean().default(true),
	removeParticipant: zod_exports.z.boolean().default(true),
	leaveGroup: zod_exports.z.boolean().default(true),
	sendAttachment: zod_exports.z.boolean().default(true)
}).optional();
const bluebubblesGroupConfigSchema = zod_exports.z.object({
	requireMention: zod_exports.z.boolean().optional(),
	tools: ToolPolicySchema,
	/**
	* Free-form directive appended to the system prompt for every turn that
	* handles a message in this group. Use it for per-group persona tweaks or
	* behavioral rules (reply-threading, tapback conventions, etc.).
	*/
	systemPrompt: zod_exports.z.string().optional()
});
const bluebubblesNetworkSchema = zod_exports.z.object({ 
/** Dangerous opt-in for same-host or trusted private/internal BlueBubbles deployments. */
dangerouslyAllowPrivateNetwork: zod_exports.z.boolean().optional() }).strict().optional();
const bluebubblesCatchupSchema = zod_exports.z.object({
	/** Replay messages delivered while the gateway was unreachable. Defaults to on. */
	enabled: zod_exports.z.boolean().optional(),
	/** Hard ceiling on lookback window. Clamped to [1, 720] minutes. */
	maxAgeMinutes: zod_exports.z.number().int().positive().optional(),
	/** Upper bound on messages replayed in a single startup pass. Clamped to [1, 500]. */
	perRunLimit: zod_exports.z.number().int().positive().optional(),
	/** First-run lookback used when no cursor has been persisted yet. Clamped to [1, 720]. */
	firstRunLookbackMinutes: zod_exports.z.number().int().positive().optional(),
	/**
	* Consecutive-failure ceiling per message GUID. After this many failed
	* processMessage attempts against the same GUID, catchup logs a WARN
	* and skips the message on subsequent sweeps (letting the cursor
	* advance past a permanently malformed payload). Defaults to 10.
	* Clamped to [1, 1000].
	*/
	maxFailureRetries: zod_exports.z.number().int().positive().optional()
}).strict().optional();
const BlueBubblesChannelConfigSchema = buildChannelConfigSchema(buildCatchallMultiAccountChannelSchema(zod_exports.z.object({
	name: zod_exports.z.string().optional(),
	enabled: zod_exports.z.boolean().optional(),
	markdown: MarkdownConfigSchema,
	actions: bluebubblesActionSchema,
	serverUrl: zod_exports.z.string().optional(),
	password: buildSecretInputSchema().optional(),
	webhookPath: zod_exports.z.string().optional(),
	dmPolicy: DmPolicySchema.optional(),
	allowFrom: AllowFromListSchema,
	groupAllowFrom: AllowFromListSchema,
	groupPolicy: GroupPolicySchema.optional(),
	enrichGroupParticipantsFromContacts: zod_exports.z.boolean().optional().default(true),
	historyLimit: zod_exports.z.number().int().min(0).optional(),
	dmHistoryLimit: zod_exports.z.number().int().min(0).optional(),
	textChunkLimit: zod_exports.z.number().int().positive().optional(),
	sendTimeoutMs: zod_exports.z.number().int().positive().optional(),
	chunkMode: zod_exports.z.enum(["length", "newline"]).optional(),
	mediaMaxMb: zod_exports.z.number().int().positive().optional(),
	mediaLocalRoots: zod_exports.z.array(zod_exports.z.string()).optional(),
	sendReadReceipts: zod_exports.z.boolean().optional(),
	network: bluebubblesNetworkSchema,
	catchup: bluebubblesCatchupSchema,
	blockStreaming: zod_exports.z.boolean().optional(),
	/**
	* When an inbound reply lands without `replyToBody`/`replyToSender` and the
	* in-memory reply cache misses (e.g., multi-instance deployments sharing
	* one BlueBubbles account, after process restarts, or after long-lived
	* cache eviction), opt in to fetching the original message from the
	* BlueBubbles HTTP API as a best-effort fallback. Off by default.
	*
	* Left as `.optional()` rather than `.optional().default(false)` so that a
	* channel-level `channels.bluebubbles.replyContextApiFallback: true` still
	* propagates to accounts that omit the field. With a hard per-account
	* default, the merge would clobber the channel value with `false` and
	* operators would have to duplicate the flag under every `accounts.<id>`.
	* (PR #71820 review)
	*/
	replyContextApiFallback: zod_exports.z.boolean().optional(),
	groups: zod_exports.z.object({}).catchall(bluebubblesGroupConfigSchema).optional(),
	coalesceSameSenderDms: zod_exports.z.boolean().optional()
}).superRefine((value, ctx) => {
	const serverUrl = value.serverUrl?.trim() ?? "";
	const passwordConfigured = hasConfiguredSecretInput(value.password);
	if (serverUrl && !passwordConfigured) ctx.addIssue({
		code: zod_exports.z.ZodIssueCode.custom,
		path: ["password"],
		message: "password is required when serverUrl is configured"
	});
})).safeExtend({ actions: bluebubblesActionSchema }), { uiHints: bluebubblesChannelConfigUiHints });
//#endregion
export { BlueBubblesChannelConfigSchema as t };

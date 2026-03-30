import {
	BlockStreamingCoalesceSchema,
	DmPolicySchema,
	GroupPolicySchema,
	MarkdownConfigSchema,
	requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-primitives";
import { z } from "openclaw/plugin-sdk/zod";
import { buildSecretInputSchema } from "./secret-input.js";

function requireMattermostOpenAllowFrom(params: {
	policy?: string;
	allowFrom?: Array<string | number>;
	ctx: z.RefinementCtx;
}) {
	requireOpenAllowFrom({
		policy: params.policy,
		allowFrom: params.allowFrom,
		ctx: params.ctx,
		path: ["allowFrom"],
		message:
			'channels.mattermost.dmPolicy="open" requires channels.mattermost.allowFrom to include "*"',
	});
}

const DmChannelRetrySchema = z
	.object({
		/** Maximum number of retry attempts for DM channel creation (default: 3) */
		maxRetries: z.number().int().min(0).max(10).optional(),
		/** Initial delay in milliseconds before first retry (default: 1000) */
		initialDelayMs: z.number().int().min(100).max(60000).optional(),
		/** Maximum delay in milliseconds between retries (default: 10000) */
		maxDelayMs: z.number().int().min(1000).max(60000).optional(),
		/** Timeout for each individual DM channel creation request in milliseconds (default: 30000) */
		timeoutMs: z.number().int().min(5000).max(120000).optional(),
	})
	.strict()
	.refine(
		(data) => {
			if (data.initialDelayMs !== undefined && data.maxDelayMs !== undefined) {
				return data.initialDelayMs <= data.maxDelayMs;
			}
			return true;
		},
		{
			message: "initialDelayMs must be less than or equal to maxDelayMs",
			path: ["initialDelayMs"],
		},
	)
	.optional();

const MattermostSlashCommandsSchema = z
	.object({
		/** Enable native slash commands. "auto" resolves to false (opt-in). */
		native: z.union([z.boolean(), z.literal("auto")]).optional(),
		/** Also register skill-based commands. */
		nativeSkills: z.union([z.boolean(), z.literal("auto")]).optional(),
		/** Path for the callback endpoint on the gateway HTTP server. */
		callbackPath: z.string().optional(),
		/** Explicit callback URL (e.g. behind reverse proxy). */
		callbackUrl: z.string().optional(),
	})
	.strict()
	.optional();

const MattermostAccountSchemaBase = z
	.object({
		name: z.string().optional(),
		capabilities: z.array(z.string()).optional(),
		dangerouslyAllowNameMatching: z.boolean().optional(),
		markdown: MarkdownConfigSchema,
		enabled: z.boolean().optional(),
		configWrites: z.boolean().optional(),
		botToken: buildSecretInputSchema().optional(),
		baseUrl: z.string().optional(),
		chatmode: z.enum(["oncall", "onmessage", "onchar"]).optional(),
		oncharPrefixes: z.array(z.string()).optional(),
		requireMention: z.boolean().optional(),
		dmPolicy: DmPolicySchema.optional().default("pairing"),
		allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
		groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
		groupPolicy: GroupPolicySchema.optional().default("allowlist"),
		textChunkLimit: z.number().int().positive().optional(),
		chunkMode: z.enum(["length", "newline"]).optional(),
		blockStreaming: z.boolean().optional(),
		blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
		replyToMode: z.enum(["off", "first", "all"]).optional(),
		responsePrefix: z.string().optional(),
		actions: z
			.object({
				reactions: z.boolean().optional(),
			})
			.optional(),
		commands: MattermostSlashCommandsSchema,
		interactions: z
			.object({
				callbackBaseUrl: z.string().optional(),
				allowedSourceIps: z.array(z.string()).optional(),
			})
			.optional(),
		/** Allow fetching from private/internal IP addresses (e.g. localhost). Required for self-hosted Mattermost on LAN/VPN. */
		allowPrivateNetwork: z.boolean().optional(),
		/** Retry configuration for DM channel creation */
		dmChannelRetry: DmChannelRetrySchema,
	})
	.strict();

const MattermostAccountSchema = MattermostAccountSchemaBase.superRefine(
	(value, ctx) => {
		requireMattermostOpenAllowFrom({
			policy: value.dmPolicy,
			allowFrom: value.allowFrom,
			ctx,
		});
	},
);

export const MattermostConfigSchema = MattermostAccountSchemaBase.extend({
	accounts: z.record(z.string(), MattermostAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
	requireMattermostOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
	});
});

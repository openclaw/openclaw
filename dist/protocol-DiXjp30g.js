import { n as ENV_SECRET_REF_ID_RE } from "./types.secrets-DwPik3M8.js";
import { i as SINGLE_VALUE_FILE_REF_ID, n as FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN, r as SECRET_PROVIDER_ALIAS_PATTERN, t as EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN } from "./ref-contract-D_h_G00C.js";
import { n as GATEWAY_CLIENT_IDS, r as GATEWAY_CLIENT_MODES } from "./client-info-BVWE_ra1.js";
import { t as INPUT_PROVENANCE_KIND_VALUES } from "./input-provenance-CmqYxlZ2.js";
import { r as MAX_PLUGIN_APPROVAL_TIMEOUT_MS } from "./plugin-approvals-BAd_Vwt-.js";
import AjvPkg from "ajv";
import { Type } from "typebox";
//#region src/agents/internal-event-contract.ts
const AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION = "task_completion";
const AGENT_INTERNAL_EVENT_SOURCES = [
	"subagent",
	"cron",
	"image_generation",
	"video_generation",
	"music_generation"
];
const AGENT_INTERNAL_EVENT_STATUSES = [
	"ok",
	"timeout",
	"error",
	"unknown"
];
function parseSessionLabel(raw) {
	if (typeof raw !== "string") return {
		ok: false,
		error: "invalid label: must be a string"
	};
	const trimmed = raw.trim();
	if (!trimmed) return {
		ok: false,
		error: "invalid label: empty"
	};
	if (trimmed.length > 512) return {
		ok: false,
		error: `invalid label: too long (max 512)`
	};
	return {
		ok: true,
		label: trimmed
	};
}
//#endregion
//#region src/gateway/protocol/schema/primitives.ts
const NonEmptyString = Type.String({ minLength: 1 });
const ChatSendSessionKeyString = Type.String({
	minLength: 1,
	maxLength: 512
});
const SessionLabelString = Type.String({
	minLength: 1,
	maxLength: 512
});
const InputProvenanceSchema = Type.Object({
	kind: Type.String({ enum: [...INPUT_PROVENANCE_KIND_VALUES] }),
	originSessionId: Type.Optional(Type.String()),
	sourceSessionKey: Type.Optional(Type.String()),
	sourceChannel: Type.Optional(Type.String()),
	sourceTool: Type.Optional(Type.String())
}, { additionalProperties: false });
const GatewayClientIdSchema = Type.Enum(GATEWAY_CLIENT_IDS);
const GatewayClientModeSchema = Type.Enum(GATEWAY_CLIENT_MODES);
Type.Union([
	Type.Literal("env"),
	Type.Literal("file"),
	Type.Literal("exec")
]);
const SecretProviderAliasString = Type.String({ pattern: SECRET_PROVIDER_ALIAS_PATTERN.source });
const EnvSecretRefSchema = Type.Object({
	source: Type.Literal("env"),
	provider: SecretProviderAliasString,
	id: Type.String({ pattern: ENV_SECRET_REF_ID_RE.source })
}, { additionalProperties: false });
const FileSecretRefIdSchema = Type.Unsafe({
	type: "string",
	anyOf: [{ const: SINGLE_VALUE_FILE_REF_ID }, { allOf: [{ pattern: "^/" }, { not: { pattern: FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN } }] }]
});
const FileSecretRefSchema = Type.Object({
	source: Type.Literal("file"),
	provider: SecretProviderAliasString,
	id: FileSecretRefIdSchema
}, { additionalProperties: false });
const ExecSecretRefSchema = Type.Object({
	source: Type.Literal("exec"),
	provider: SecretProviderAliasString,
	id: Type.String({ pattern: EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN })
}, { additionalProperties: false });
const SecretRefSchema = Type.Union([
	EnvSecretRefSchema,
	FileSecretRefSchema,
	ExecSecretRefSchema
]);
const SecretInputSchema = Type.Union([Type.String(), SecretRefSchema]);
//#endregion
//#region src/gateway/protocol/schema/agent.ts
const AgentGeneratedAttachmentSchema = Type.Object({
	type: Type.Optional(Type.String({ enum: [
		"image",
		"audio",
		"video",
		"file"
	] })),
	path: Type.Optional(Type.String()),
	url: Type.Optional(Type.String()),
	mediaUrl: Type.Optional(Type.String()),
	filePath: Type.Optional(Type.String()),
	mimeType: Type.Optional(Type.String()),
	name: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentInternalEventSchema = Type.Object({
	type: Type.Literal(AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION),
	source: Type.String({ enum: [...AGENT_INTERNAL_EVENT_SOURCES] }),
	childSessionKey: Type.String(),
	childSessionId: Type.Optional(Type.String()),
	announceType: Type.String(),
	taskLabel: Type.String(),
	status: Type.String({ enum: [...AGENT_INTERNAL_EVENT_STATUSES] }),
	statusLabel: Type.String(),
	result: Type.String(),
	attachments: Type.Optional(Type.Array(AgentGeneratedAttachmentSchema)),
	mediaUrls: Type.Optional(Type.Array(Type.String())),
	statsLine: Type.Optional(Type.String()),
	replyInstruction: Type.String()
}, { additionalProperties: false });
const AgentEventSchema = Type.Object({
	runId: NonEmptyString,
	seq: Type.Integer({ minimum: 0 }),
	stream: NonEmptyString,
	ts: Type.Integer({ minimum: 0 }),
	spawnedBy: Type.Optional(NonEmptyString),
	isHeartbeat: Type.Optional(Type.Boolean()),
	data: Type.Record(Type.String(), Type.Unknown())
}, { additionalProperties: false });
const MessageActionToolContextSchema = Type.Object({
	currentChannelId: Type.Optional(Type.String()),
	currentGraphChannelId: Type.Optional(Type.String()),
	currentChannelProvider: Type.Optional(Type.String()),
	currentThreadTs: Type.Optional(Type.String()),
	currentMessageId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
	replyToMode: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("first"),
		Type.Literal("all"),
		Type.Literal("batched")
	])),
	hasRepliedRef: Type.Optional(Type.Object({ value: Type.Boolean() }, { additionalProperties: false })),
	skipCrossContextDecoration: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const MessageActionParamsSchema = Type.Object({
	channel: NonEmptyString,
	action: NonEmptyString,
	params: Type.Record(Type.String(), Type.Unknown()),
	accountId: Type.Optional(Type.String()),
	requesterSenderId: Type.Optional(Type.String()),
	senderIsOwner: Type.Optional(Type.Boolean()),
	sessionKey: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	inboundTurnKind: Type.Optional(Type.String({ enum: ["user_request", "room_event"] })),
	agentId: Type.Optional(Type.String()),
	toolContext: Type.Optional(MessageActionToolContextSchema),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const SendParamsSchema = Type.Object({
	to: NonEmptyString,
	message: Type.Optional(Type.String()),
	mediaUrl: Type.Optional(Type.String()),
	mediaUrls: Type.Optional(Type.Array(Type.String())),
	asVoice: Type.Optional(Type.Boolean()),
	gifPlayback: Type.Optional(Type.Boolean()),
	channel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	/** Optional agent id for per-agent media root resolution on gateway sends. */
	agentId: Type.Optional(Type.String()),
	/** Reply target message id for native quoted/threaded sends where supported. */
	replyToId: Type.Optional(Type.String()),
	/** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
	threadId: Type.Optional(Type.String()),
	/** Force document-style media sends where supported. */
	forceDocument: Type.Optional(Type.Boolean()),
	/** Send silently (no notification) where supported. */
	silent: Type.Optional(Type.Boolean()),
	/** Channel-specific parse mode for formatted text. */
	parseMode: Type.Optional(Type.Literal("HTML")),
	/** Optional session key for mirroring delivered output back into the transcript. */
	sessionKey: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const PollParamsSchema = Type.Object({
	to: NonEmptyString,
	question: NonEmptyString,
	options: Type.Array(NonEmptyString, {
		minItems: 2,
		maxItems: 12
	}),
	maxSelections: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 12
	})),
	/** Poll duration in seconds (channel-specific limits may apply). */
	durationSeconds: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 604800
	})),
	durationHours: Type.Optional(Type.Integer({ minimum: 1 })),
	/** Send silently (no notification) where supported. */
	silent: Type.Optional(Type.Boolean()),
	/** Poll anonymity where supported (e.g. Telegram polls default to anonymous). */
	isAnonymous: Type.Optional(Type.Boolean()),
	/** Thread id (channel-specific meaning, e.g. Telegram forum topic id). */
	threadId: Type.Optional(Type.String()),
	channel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const AgentParamsSchema = Type.Object({
	message: NonEmptyString,
	agentId: Type.Optional(NonEmptyString),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	to: Type.Optional(Type.String()),
	replyTo: Type.Optional(Type.String()),
	sessionId: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	thinking: Type.Optional(Type.String()),
	deliver: Type.Optional(Type.Boolean()),
	attachments: Type.Optional(Type.Array(Type.Unknown())),
	channel: Type.Optional(Type.String()),
	replyChannel: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	replyAccountId: Type.Optional(Type.String()),
	threadId: Type.Optional(Type.String()),
	groupId: Type.Optional(Type.String()),
	groupChannel: Type.Optional(Type.String()),
	groupSpace: Type.Optional(Type.String()),
	timeout: Type.Optional(Type.Integer({ minimum: 0 })),
	bestEffortDeliver: Type.Optional(Type.Boolean()),
	lane: Type.Optional(Type.String()),
	cleanupBundleMcpOnRunEnd: Type.Optional(Type.Boolean()),
	modelRun: Type.Optional(Type.Boolean()),
	promptMode: Type.Optional(Type.Union([
		Type.Literal("full"),
		Type.Literal("minimal"),
		Type.Literal("none")
	])),
	extraSystemPrompt: Type.Optional(Type.String()),
	bootstrapContextMode: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("lightweight")])),
	bootstrapContextRunKind: Type.Optional(Type.Union([
		Type.Literal("default"),
		Type.Literal("heartbeat"),
		Type.Literal("cron")
	])),
	acpTurnSource: Type.Optional(Type.Literal("manual_spawn")),
	internalRuntimeHandoffId: Type.Optional(NonEmptyString),
	internalEvents: Type.Optional(Type.Array(AgentInternalEventSchema)),
	inputProvenance: Type.Optional(InputProvenanceSchema),
	sourceReplyDeliveryMode: Type.Optional(Type.Union([Type.Literal("automatic"), Type.Literal("message_tool_only")])),
	voiceWakeTrigger: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString,
	label: Type.Optional(SessionLabelString)
}, { additionalProperties: false });
const AgentIdentityParamsSchema = Type.Object({
	agentId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentIdentityResultSchema = Type.Object({
	agentId: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	avatar: Type.Optional(NonEmptyString),
	avatarSource: Type.Optional(NonEmptyString),
	avatarStatus: Type.Optional(Type.String({ enum: [
		"none",
		"local",
		"remote",
		"data"
	] })),
	avatarReason: Type.Optional(NonEmptyString),
	emoji: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const AgentWaitParamsSchema = Type.Object({
	runId: NonEmptyString,
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const WakeParamsSchema = Type.Object({
	mode: Type.Union([Type.Literal("now"), Type.Literal("next-heartbeat")]),
	text: NonEmptyString,
	sessionKey: Type.Optional(NonEmptyString)
}, { additionalProperties: true });
//#endregion
//#region src/gateway/protocol/schema/agents-models-skills.ts
const ModelChoiceSchema = Type.Object({
	id: NonEmptyString,
	name: NonEmptyString,
	provider: NonEmptyString,
	alias: Type.Optional(NonEmptyString),
	contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
	reasoning: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const AgentSummarySchema = Type.Object({
	id: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	identity: Type.Optional(Type.Object({
		name: Type.Optional(NonEmptyString),
		theme: Type.Optional(NonEmptyString),
		emoji: Type.Optional(NonEmptyString),
		avatar: Type.Optional(NonEmptyString),
		avatarUrl: Type.Optional(NonEmptyString)
	}, { additionalProperties: false })),
	workspace: Type.Optional(NonEmptyString),
	model: Type.Optional(Type.Object({
		primary: Type.Optional(NonEmptyString),
		fallbacks: Type.Optional(Type.Array(NonEmptyString))
	}, { additionalProperties: false })),
	agentRuntime: Type.Optional(Type.Object({
		id: NonEmptyString,
		fallback: Type.Optional(Type.Union([Type.Literal("pi"), Type.Literal("none")])),
		source: Type.Union([
			Type.Literal("env"),
			Type.Literal("agent"),
			Type.Literal("defaults"),
			Type.Literal("model"),
			Type.Literal("provider"),
			Type.Literal("implicit")
		])
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const AgentsListParamsSchema = Type.Object({}, { additionalProperties: false });
const AgentsListResultSchema = Type.Object({
	defaultId: NonEmptyString,
	mainKey: NonEmptyString,
	scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
	agents: Type.Array(AgentSummarySchema)
}, { additionalProperties: false });
const AgentsCreateParamsSchema = Type.Object({
	name: NonEmptyString,
	workspace: NonEmptyString,
	model: Type.Optional(NonEmptyString),
	emoji: Type.Optional(Type.String()),
	avatar: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsCreateResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	name: NonEmptyString,
	workspace: NonEmptyString,
	model: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const AgentsUpdateParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: Type.Optional(NonEmptyString),
	workspace: Type.Optional(NonEmptyString),
	model: Type.Optional(NonEmptyString),
	emoji: Type.Optional(Type.String()),
	avatar: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsUpdateResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString
}, { additionalProperties: false });
const AgentsDeleteParamsSchema = Type.Object({
	agentId: NonEmptyString,
	deleteFiles: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const AgentsDeleteResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	removedBindings: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const AgentsFileEntrySchema = Type.Object({
	name: NonEmptyString,
	path: NonEmptyString,
	missing: Type.Boolean(),
	size: Type.Optional(Type.Integer({ minimum: 0 })),
	updatedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	content: Type.Optional(Type.String())
}, { additionalProperties: false });
const AgentsFilesListParamsSchema = Type.Object({ agentId: NonEmptyString }, { additionalProperties: false });
const AgentsFilesListResultSchema = Type.Object({
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	files: Type.Array(AgentsFileEntrySchema)
}, { additionalProperties: false });
const AgentsFilesGetParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: NonEmptyString
}, { additionalProperties: false });
const AgentsFilesGetResultSchema = Type.Object({
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	file: AgentsFileEntrySchema
}, { additionalProperties: false });
const AgentsFilesSetParamsSchema = Type.Object({
	agentId: NonEmptyString,
	name: NonEmptyString,
	content: Type.String()
}, { additionalProperties: false });
const AgentsFilesSetResultSchema = Type.Object({
	ok: Type.Literal(true),
	agentId: NonEmptyString,
	workspace: NonEmptyString,
	file: AgentsFileEntrySchema
}, { additionalProperties: false });
const ModelsListParamsSchema = Type.Object({ view: Type.Optional(Type.Union([
	Type.Literal("default"),
	Type.Literal("configured"),
	Type.Literal("all")
])) }, { additionalProperties: false });
const ModelsListResultSchema = Type.Object({ models: Type.Array(ModelChoiceSchema) }, { additionalProperties: false });
const SkillsStatusParamsSchema = Type.Object({ agentId: Type.Optional(NonEmptyString) }, { additionalProperties: false });
const SkillsBinsParamsSchema = Type.Object({}, { additionalProperties: false });
const SkillsBinsResultSchema = Type.Object({ bins: Type.Array(NonEmptyString) }, { additionalProperties: false });
const Sha256String = Type.String({
	minLength: 64,
	maxLength: 64,
	pattern: "^[a-fA-F0-9]{64}$"
});
const SkillUploadIdempotencyKeyString = Type.String({
	minLength: 1,
	maxLength: 2048
});
const SkillUploadDataBase64String = Type.String({
	minLength: 1,
	maxLength: 5592408
});
const SkillsUploadBeginParamsSchema = Type.Object({
	kind: Type.Literal("skill-archive"),
	slug: NonEmptyString,
	sizeBytes: Type.Integer({ minimum: 1 }),
	sha256: Type.Optional(Sha256String),
	force: Type.Optional(Type.Boolean()),
	idempotencyKey: Type.Optional(SkillUploadIdempotencyKeyString)
}, { additionalProperties: false });
const SkillsUploadChunkParamsSchema = Type.Object({
	uploadId: NonEmptyString,
	offset: Type.Integer({ minimum: 0 }),
	dataBase64: SkillUploadDataBase64String
}, { additionalProperties: false });
const SkillsUploadCommitParamsSchema = Type.Object({
	uploadId: NonEmptyString,
	sha256: Type.Optional(Sha256String)
}, { additionalProperties: false });
const SkillsInstallParamsSchema = Type.Union([
	Type.Object({
		name: NonEmptyString,
		installId: NonEmptyString,
		dangerouslyForceUnsafeInstall: Type.Optional(Type.Boolean()),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1e3 }))
	}, { additionalProperties: false }),
	Type.Object({
		source: Type.Literal("clawhub"),
		slug: NonEmptyString,
		version: Type.Optional(NonEmptyString),
		force: Type.Optional(Type.Boolean()),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1e3 }))
	}, { additionalProperties: false }),
	Type.Object({
		source: Type.Literal("upload"),
		uploadId: NonEmptyString,
		slug: NonEmptyString,
		force: Type.Optional(Type.Boolean()),
		sha256: Type.Optional(Sha256String),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1e3 }))
	}, { additionalProperties: false })
]);
const SkillsUpdateParamsSchema = Type.Union([Type.Object({
	skillKey: NonEmptyString,
	enabled: Type.Optional(Type.Boolean()),
	apiKey: Type.Optional(Type.String()),
	env: Type.Optional(Type.Record(NonEmptyString, Type.String()))
}, { additionalProperties: false }), Type.Object({
	source: Type.Literal("clawhub"),
	slug: Type.Optional(NonEmptyString),
	all: Type.Optional(Type.Boolean())
}, { additionalProperties: false })]);
const SkillsSearchParamsSchema = Type.Object({
	query: Type.Optional(NonEmptyString),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 100
	}))
}, { additionalProperties: false });
const SkillsSearchResultSchema = Type.Object({ results: Type.Array(Type.Object({
	score: Type.Number(),
	slug: NonEmptyString,
	displayName: NonEmptyString,
	summary: Type.Optional(Type.String()),
	version: Type.Optional(NonEmptyString),
	updatedAt: Type.Optional(Type.Integer())
}, { additionalProperties: false })) }, { additionalProperties: false });
const SkillsDetailParamsSchema = Type.Object({ slug: NonEmptyString }, { additionalProperties: false });
const SkillsDetailResultSchema = Type.Object({
	skill: Type.Union([Type.Object({
		slug: NonEmptyString,
		displayName: NonEmptyString,
		summary: Type.Optional(Type.String()),
		tags: Type.Optional(Type.Record(NonEmptyString, Type.String())),
		createdAt: Type.Integer(),
		updatedAt: Type.Integer()
	}, { additionalProperties: false }), Type.Null()]),
	latestVersion: Type.Optional(Type.Union([Type.Object({
		version: NonEmptyString,
		createdAt: Type.Integer(),
		changelog: Type.Optional(Type.String())
	}, { additionalProperties: false }), Type.Null()])),
	metadata: Type.Optional(Type.Union([Type.Object({
		os: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
		systems: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()]))
	}, { additionalProperties: false }), Type.Null()])),
	owner: Type.Optional(Type.Union([Type.Object({
		handle: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
		displayName: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
		image: Type.Optional(Type.Union([Type.String(), Type.Null()]))
	}, { additionalProperties: false }), Type.Null()]))
}, { additionalProperties: false });
const ToolsCatalogParamsSchema = Type.Object({
	agentId: Type.Optional(NonEmptyString),
	includePlugins: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ToolsEffectiveParamsSchema = Type.Object({
	agentId: Type.Optional(NonEmptyString),
	sessionKey: NonEmptyString
}, { additionalProperties: false });
const ToolsInvokeParamsSchema = Type.Object({
	name: NonEmptyString,
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	sessionKey: Type.Optional(NonEmptyString),
	agentId: Type.Optional(NonEmptyString),
	confirm: Type.Optional(Type.Boolean()),
	idempotencyKey: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ToolCatalogProfileSchema = Type.Object({
	id: Type.Union([
		Type.Literal("minimal"),
		Type.Literal("coding"),
		Type.Literal("messaging"),
		Type.Literal("full")
	]),
	label: NonEmptyString
}, { additionalProperties: false });
const ToolCatalogEntrySchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	description: Type.String(),
	source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
	pluginId: Type.Optional(NonEmptyString),
	optional: Type.Optional(Type.Boolean()),
	risk: Type.Optional(Type.Union([
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high")
	])),
	tags: Type.Optional(Type.Array(NonEmptyString)),
	defaultProfiles: Type.Array(Type.Union([
		Type.Literal("minimal"),
		Type.Literal("coding"),
		Type.Literal("messaging"),
		Type.Literal("full")
	]))
}, { additionalProperties: false });
const ToolCatalogGroupSchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	source: Type.Union([Type.Literal("core"), Type.Literal("plugin")]),
	pluginId: Type.Optional(NonEmptyString),
	tools: Type.Array(ToolCatalogEntrySchema)
}, { additionalProperties: false });
const ToolsCatalogResultSchema = Type.Object({
	agentId: NonEmptyString,
	profiles: Type.Array(ToolCatalogProfileSchema),
	groups: Type.Array(ToolCatalogGroupSchema)
}, { additionalProperties: false });
const ToolsEffectiveEntrySchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	description: Type.String(),
	rawDescription: Type.String(),
	source: Type.Union([
		Type.Literal("core"),
		Type.Literal("plugin"),
		Type.Literal("channel")
	]),
	pluginId: Type.Optional(NonEmptyString),
	channelId: Type.Optional(NonEmptyString),
	risk: Type.Optional(Type.Union([
		Type.Literal("low"),
		Type.Literal("medium"),
		Type.Literal("high")
	])),
	tags: Type.Optional(Type.Array(NonEmptyString))
}, { additionalProperties: false });
const ToolsEffectiveGroupSchema = Type.Object({
	id: Type.Union([
		Type.Literal("core"),
		Type.Literal("plugin"),
		Type.Literal("channel")
	]),
	label: NonEmptyString,
	source: Type.Union([
		Type.Literal("core"),
		Type.Literal("plugin"),
		Type.Literal("channel")
	]),
	tools: Type.Array(ToolsEffectiveEntrySchema)
}, { additionalProperties: false });
const ToolsEffectiveResultSchema = Type.Object({
	agentId: NonEmptyString,
	profile: NonEmptyString,
	groups: Type.Array(ToolsEffectiveGroupSchema)
}, { additionalProperties: false });
const ToolsInvokeErrorSchema = Type.Object({
	code: NonEmptyString,
	message: NonEmptyString,
	details: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const ToolsInvokeResultSchema = Type.Object({
	ok: Type.Boolean(),
	toolName: NonEmptyString,
	output: Type.Optional(Type.Unknown()),
	requiresApproval: Type.Optional(Type.Boolean()),
	approvalId: Type.Optional(NonEmptyString),
	source: Type.Optional(Type.Union([
		Type.Literal("core"),
		Type.Literal("plugin"),
		Type.Literal("mcp"),
		Type.Literal("channel"),
		Type.String()
	])),
	error: Type.Optional(ToolsInvokeErrorSchema)
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/artifacts.ts
const ArtifactQueryParamsProperties = {
	sessionKey: Type.Optional(NonEmptyString),
	runId: Type.Optional(NonEmptyString),
	taskId: Type.Optional(NonEmptyString),
	agentId: Type.Optional(NonEmptyString)
};
const ArtifactQueryParamsSchema = Type.Object(ArtifactQueryParamsProperties, { additionalProperties: false });
const ArtifactGetParamsSchema = Type.Object({
	...ArtifactQueryParamsProperties,
	artifactId: NonEmptyString
}, { additionalProperties: false });
const ArtifactSummarySchema = Type.Object({
	id: NonEmptyString,
	type: NonEmptyString,
	title: NonEmptyString,
	mimeType: Type.Optional(NonEmptyString),
	sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
	sessionKey: Type.Optional(NonEmptyString),
	runId: Type.Optional(NonEmptyString),
	taskId: Type.Optional(NonEmptyString),
	messageSeq: Type.Optional(Type.Integer({ minimum: 1 })),
	source: Type.Optional(NonEmptyString),
	download: Type.Object({ mode: Type.Union([
		Type.Literal("bytes"),
		Type.Literal("url"),
		Type.Literal("unsupported")
	]) }, { additionalProperties: false })
}, { additionalProperties: false });
const ArtifactsListParamsSchema = ArtifactQueryParamsSchema;
const ArtifactsListResultSchema = Type.Object({ artifacts: Type.Array(ArtifactSummarySchema) }, { additionalProperties: false });
const ArtifactsGetParamsSchema = ArtifactGetParamsSchema;
const ArtifactsGetResultSchema = Type.Object({ artifact: ArtifactSummarySchema }, { additionalProperties: false });
const ArtifactsDownloadParamsSchema = ArtifactGetParamsSchema;
const ArtifactsDownloadResultSchema = Type.Object({
	artifact: ArtifactSummarySchema,
	encoding: Type.Optional(Type.Literal("base64")),
	data: Type.Optional(Type.String()),
	url: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/channels.ts
const TalkModeParamsSchema = Type.Object({
	enabled: Type.Boolean(),
	phase: Type.Optional(Type.String())
}, { additionalProperties: false });
const TalkConfigParamsSchema = Type.Object({ includeSecrets: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
const TalkSpeakParamsSchema = Type.Object({
	text: NonEmptyString,
	voiceId: Type.Optional(Type.String()),
	modelId: Type.Optional(Type.String()),
	outputFormat: Type.Optional(Type.String()),
	speed: Type.Optional(Type.Number()),
	rateWpm: Type.Optional(Type.Integer({ minimum: 1 })),
	stability: Type.Optional(Type.Number()),
	similarity: Type.Optional(Type.Number()),
	style: Type.Optional(Type.Number()),
	speakerBoost: Type.Optional(Type.Boolean()),
	seed: Type.Optional(Type.Integer({ minimum: 0 })),
	normalize: Type.Optional(Type.String()),
	language: Type.Optional(Type.String()),
	latencyTier: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const TalkModeSchema = Type.Union([
	Type.Literal("realtime"),
	Type.Literal("stt-tts"),
	Type.Literal("transcription")
]);
const TalkTransportSchema = Type.Union([
	Type.Literal("webrtc"),
	Type.Literal("provider-websocket"),
	Type.Literal("gateway-relay"),
	Type.Literal("managed-room")
]);
const TalkBrainSchema = Type.Union([
	Type.Literal("agent-consult"),
	Type.Literal("direct-tools"),
	Type.Literal("none")
]);
const TalkEventTypeSchema = Type.Union([
	Type.Literal("session.started"),
	Type.Literal("session.ready"),
	Type.Literal("session.closed"),
	Type.Literal("session.error"),
	Type.Literal("session.replaced"),
	Type.Literal("turn.started"),
	Type.Literal("turn.ended"),
	Type.Literal("turn.cancelled"),
	Type.Literal("capture.started"),
	Type.Literal("capture.stopped"),
	Type.Literal("capture.cancelled"),
	Type.Literal("capture.once"),
	Type.Literal("input.audio.delta"),
	Type.Literal("input.audio.committed"),
	Type.Literal("transcript.delta"),
	Type.Literal("transcript.done"),
	Type.Literal("output.text.delta"),
	Type.Literal("output.text.done"),
	Type.Literal("output.audio.started"),
	Type.Literal("output.audio.delta"),
	Type.Literal("output.audio.done"),
	Type.Literal("tool.call"),
	Type.Literal("tool.progress"),
	Type.Literal("tool.result"),
	Type.Literal("tool.error"),
	Type.Literal("usage.metrics"),
	Type.Literal("latency.metrics"),
	Type.Literal("health.changed")
]);
const TURN_SCOPED_TALK_EVENT_TYPES = [
	"turn.started",
	"turn.ended",
	"turn.cancelled",
	"input.audio.delta",
	"input.audio.committed",
	"transcript.delta",
	"transcript.done",
	"output.text.delta",
	"output.text.done",
	"output.audio.started",
	"output.audio.delta",
	"output.audio.done",
	"tool.call",
	"tool.progress",
	"tool.result",
	"tool.error"
];
const CAPTURE_SCOPED_TALK_EVENT_TYPES = [
	"capture.started",
	"capture.stopped",
	"capture.cancelled",
	"capture.once"
];
function requireJsonSchemaProperties(properties) {
	const conditionalRequirementKey = ["th", "en"].join("");
	return Object.fromEntries([[conditionalRequirementKey, { required: properties }]]);
}
const TalkEventSchema = Type.Object({
	id: NonEmptyString,
	type: TalkEventTypeSchema,
	sessionId: NonEmptyString,
	turnId: Type.Optional(Type.String()),
	captureId: Type.Optional(Type.String()),
	seq: Type.Integer({ minimum: 1 }),
	timestamp: NonEmptyString,
	mode: TalkModeSchema,
	transport: TalkTransportSchema,
	brain: TalkBrainSchema,
	provider: Type.Optional(Type.String()),
	final: Type.Optional(Type.Boolean()),
	callId: Type.Optional(Type.String()),
	itemId: Type.Optional(Type.String()),
	parentId: Type.Optional(Type.String()),
	payload: Type.Unknown()
}, {
	additionalProperties: false,
	allOf: [{
		if: {
			properties: { type: { enum: TURN_SCOPED_TALK_EVENT_TYPES } },
			required: ["type"]
		},
		...requireJsonSchemaProperties(["turnId"])
	}, {
		if: {
			properties: { type: { enum: CAPTURE_SCOPED_TALK_EVENT_TYPES } },
			required: ["type"]
		},
		...requireJsonSchemaProperties(["captureId"])
	}]
});
const TalkClientCreateParamsSchema = Type.Object({
	sessionKey: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	voice: Type.Optional(Type.String()),
	vadThreshold: Type.Optional(Type.Number()),
	silenceDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
	prefixPaddingMs: Type.Optional(Type.Integer({ minimum: 0 })),
	reasoningEffort: Type.Optional(Type.String()),
	mode: Type.Optional(TalkModeSchema),
	transport: Type.Optional(TalkTransportSchema),
	brain: Type.Optional(TalkBrainSchema)
}, { additionalProperties: false });
const TalkClientToolCallParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	callId: NonEmptyString,
	name: NonEmptyString,
	args: Type.Optional(Type.Unknown()),
	relaySessionId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const TalkClientToolCallResultSchema = Type.Object({
	runId: NonEmptyString,
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const TalkSessionJoinParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	token: NonEmptyString
}, { additionalProperties: false });
const TalkSessionCreateParamsSchema = Type.Object({
	sessionKey: Type.Optional(Type.String()),
	spawnedBy: Type.Optional(NonEmptyString),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	voice: Type.Optional(Type.String()),
	vadThreshold: Type.Optional(Type.Number()),
	silenceDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
	prefixPaddingMs: Type.Optional(Type.Integer({ minimum: 0 })),
	reasoningEffort: Type.Optional(Type.String()),
	mode: Type.Optional(TalkModeSchema),
	transport: Type.Optional(TalkTransportSchema),
	brain: Type.Optional(TalkBrainSchema),
	ttlMs: Type.Optional(Type.Integer({
		minimum: 1e3,
		maximum: 36e5
	}))
}, { additionalProperties: false });
const TalkSessionAppendAudioParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	audioBase64: NonEmptyString,
	timestamp: Type.Optional(Type.Number())
}, { additionalProperties: false });
const TalkSessionTurnParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	turnId: Type.Optional(Type.String())
}, { additionalProperties: false });
const TalkSessionCancelTurnParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	turnId: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String())
}, { additionalProperties: false });
const TalkSessionCancelOutputParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	turnId: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String())
}, { additionalProperties: false });
const TalkSessionSubmitToolResultParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	callId: NonEmptyString,
	result: Type.Unknown(),
	options: Type.Optional(Type.Object({
		suppressResponse: Type.Optional(Type.Boolean()),
		willContinue: Type.Optional(Type.Boolean())
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const TalkSessionCloseParamsSchema = Type.Object({ sessionId: NonEmptyString }, { additionalProperties: false });
const TalkSessionManagedRoomStateSchema = Type.Object({
	activeClientId: Type.Optional(Type.String()),
	activeTurnId: Type.Optional(Type.String()),
	recentTalkEvents: Type.Array(TalkEventSchema)
}, { additionalProperties: false });
const TalkSessionManagedRoomRecordSchema = Type.Object({
	id: NonEmptyString,
	roomId: NonEmptyString,
	roomUrl: NonEmptyString,
	sessionKey: NonEmptyString,
	sessionId: Type.Optional(Type.String()),
	channel: Type.Optional(Type.String()),
	target: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	voice: Type.Optional(Type.String()),
	mode: TalkModeSchema,
	transport: TalkTransportSchema,
	brain: TalkBrainSchema,
	createdAt: Type.Number(),
	expiresAt: Type.Number(),
	room: TalkSessionManagedRoomStateSchema
}, { additionalProperties: false });
const TalkCatalogParamsSchema = Type.Object({}, { additionalProperties: false });
const TalkCatalogProviderSchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	configured: Type.Boolean(),
	models: Type.Optional(Type.Array(Type.String())),
	voices: Type.Optional(Type.Array(Type.String())),
	defaultModel: Type.Optional(Type.String()),
	modes: Type.Optional(Type.Array(TalkModeSchema)),
	transports: Type.Optional(Type.Array(TalkTransportSchema)),
	brains: Type.Optional(Type.Array(TalkBrainSchema)),
	inputAudioFormats: Type.Optional(Type.Array(Type.Object({
		encoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
		sampleRateHz: Type.Integer({ minimum: 1 }),
		channels: Type.Integer({ minimum: 1 })
	}, { additionalProperties: false }))),
	outputAudioFormats: Type.Optional(Type.Array(Type.Object({
		encoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
		sampleRateHz: Type.Integer({ minimum: 1 }),
		channels: Type.Integer({ minimum: 1 })
	}, { additionalProperties: false }))),
	supportsBrowserSession: Type.Optional(Type.Boolean()),
	supportsBargeIn: Type.Optional(Type.Boolean()),
	supportsToolCalls: Type.Optional(Type.Boolean()),
	supportsVideoFrames: Type.Optional(Type.Boolean()),
	supportsSessionResumption: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const TalkCatalogProviderGroupSchema = Type.Object({
	activeProvider: Type.Optional(Type.String()),
	providers: Type.Array(TalkCatalogProviderSchema)
}, { additionalProperties: false });
const TalkCatalogResultSchema = Type.Object({
	modes: Type.Array(TalkModeSchema),
	transports: Type.Array(TalkTransportSchema),
	brains: Type.Array(TalkBrainSchema),
	speech: TalkCatalogProviderGroupSchema,
	transcription: TalkCatalogProviderGroupSchema,
	realtime: TalkCatalogProviderGroupSchema
}, { additionalProperties: false });
const BrowserRealtimeAudioContractSchema = Type.Object({
	inputEncoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
	inputSampleRateHz: Type.Integer({ minimum: 1 }),
	outputEncoding: Type.Union([Type.Literal("pcm16"), Type.Literal("g711_ulaw")]),
	outputSampleRateHz: Type.Integer({ minimum: 1 })
}, { additionalProperties: false });
const TalkSessionCreateResultSchema = Type.Object({
	sessionId: NonEmptyString,
	provider: Type.Optional(Type.String()),
	mode: TalkModeSchema,
	transport: TalkTransportSchema,
	brain: TalkBrainSchema,
	relaySessionId: Type.Optional(NonEmptyString),
	transcriptionSessionId: Type.Optional(NonEmptyString),
	handoffId: Type.Optional(NonEmptyString),
	roomId: Type.Optional(NonEmptyString),
	roomUrl: Type.Optional(NonEmptyString),
	token: Type.Optional(NonEmptyString),
	audio: Type.Optional(Type.Unknown()),
	model: Type.Optional(Type.String()),
	voice: Type.Optional(Type.String()),
	expiresAt: Type.Optional(Type.Number())
}, { additionalProperties: false });
const TalkSessionTurnResultSchema = Type.Object({
	ok: Type.Boolean(),
	turnId: Type.Optional(Type.String()),
	events: Type.Optional(Type.Array(TalkEventSchema))
}, { additionalProperties: false });
const TalkSessionJoinResultSchema = TalkSessionManagedRoomRecordSchema;
const TalkSessionOkResultSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
const BrowserRealtimeWebRtcSdpSessionSchema = Type.Object({
	provider: NonEmptyString,
	transport: Type.Literal("webrtc"),
	clientSecret: NonEmptyString,
	offerUrl: Type.Optional(Type.String()),
	offerHeaders: Type.Optional(Type.Record(Type.String(), Type.String())),
	model: Type.Optional(Type.String()),
	voice: Type.Optional(Type.String()),
	expiresAt: Type.Optional(Type.Number())
}, { additionalProperties: false });
const BrowserRealtimeJsonPcmWebSocketSessionSchema = Type.Object({
	provider: NonEmptyString,
	transport: Type.Literal("provider-websocket"),
	protocol: NonEmptyString,
	clientSecret: NonEmptyString,
	websocketUrl: NonEmptyString,
	audio: BrowserRealtimeAudioContractSchema,
	initialMessage: Type.Optional(Type.Unknown()),
	model: Type.Optional(Type.String()),
	voice: Type.Optional(Type.String()),
	expiresAt: Type.Optional(Type.Number())
}, { additionalProperties: false });
const BrowserRealtimeGatewayRelaySessionSchema = Type.Object({
	provider: NonEmptyString,
	transport: Type.Literal("gateway-relay"),
	relaySessionId: NonEmptyString,
	audio: BrowserRealtimeAudioContractSchema,
	model: Type.Optional(Type.String()),
	voice: Type.Optional(Type.String()),
	expiresAt: Type.Optional(Type.Number())
}, { additionalProperties: false });
const BrowserRealtimeManagedRoomSessionSchema = Type.Object({
	provider: NonEmptyString,
	transport: Type.Literal("managed-room"),
	roomUrl: NonEmptyString,
	token: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	voice: Type.Optional(Type.String()),
	expiresAt: Type.Optional(Type.Number())
}, { additionalProperties: false });
const TalkClientCreateResultSchema = Type.Union([
	BrowserRealtimeWebRtcSdpSessionSchema,
	BrowserRealtimeJsonPcmWebSocketSessionSchema,
	BrowserRealtimeGatewayRelaySessionSchema,
	BrowserRealtimeManagedRoomSessionSchema
]);
const talkProviderFieldSchemas = { apiKey: Type.Optional(SecretInputSchema) };
const TalkProviderConfigSchema = Type.Object(talkProviderFieldSchemas, { additionalProperties: true });
const TalkRealtimeConfigSchema = Type.Object({
	provider: Type.Optional(Type.String()),
	providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
	model: Type.Optional(Type.String()),
	voice: Type.Optional(Type.String()),
	instructions: Type.Optional(Type.String()),
	mode: Type.Optional(TalkModeSchema),
	transport: Type.Optional(TalkTransportSchema),
	brain: Type.Optional(TalkBrainSchema)
}, { additionalProperties: false });
const ResolvedTalkConfigSchema = Type.Object({
	provider: Type.String(),
	config: TalkProviderConfigSchema
}, { additionalProperties: false });
const TalkConfigSchema = Type.Object({
	provider: Type.Optional(Type.String()),
	providers: Type.Optional(Type.Record(Type.String(), TalkProviderConfigSchema)),
	realtime: Type.Optional(TalkRealtimeConfigSchema),
	resolved: Type.Optional(ResolvedTalkConfigSchema),
	consultThinkingLevel: Type.Optional(Type.String()),
	consultFastMode: Type.Optional(Type.Boolean()),
	speechLocale: Type.Optional(Type.String()),
	interruptOnSpeech: Type.Optional(Type.Boolean()),
	silenceTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const TalkConfigResultSchema = Type.Object({ config: Type.Object({
	talk: Type.Optional(TalkConfigSchema),
	session: Type.Optional(Type.Object({ mainKey: Type.Optional(Type.String()) }, { additionalProperties: false })),
	ui: Type.Optional(Type.Object({ seamColor: Type.Optional(Type.String()) }, { additionalProperties: false }))
}, { additionalProperties: false }) }, { additionalProperties: false });
const TalkSpeakResultSchema = Type.Object({
	audioBase64: NonEmptyString,
	provider: NonEmptyString,
	outputFormat: Type.Optional(Type.String()),
	voiceCompatible: Type.Optional(Type.Boolean()),
	mimeType: Type.Optional(Type.String()),
	fileExtension: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChannelsStatusParamsSchema = Type.Object({
	probe: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	channel: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ChannelAccountSnapshotSchema = Type.Object({
	accountId: NonEmptyString,
	name: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	configured: Type.Optional(Type.Boolean()),
	linked: Type.Optional(Type.Boolean()),
	running: Type.Optional(Type.Boolean()),
	connected: Type.Optional(Type.Boolean()),
	reconnectAttempts: Type.Optional(Type.Integer({ minimum: 0 })),
	lastConnectedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastError: Type.Optional(Type.String()),
	healthState: Type.Optional(Type.String()),
	lastStartAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastStopAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastInboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastOutboundAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastTransportActivityAt: Type.Optional(Type.Integer({ minimum: 0 })),
	busy: Type.Optional(Type.Boolean()),
	activeRuns: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunActivityAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastProbeAt: Type.Optional(Type.Integer({ minimum: 0 })),
	mode: Type.Optional(Type.String()),
	dmPolicy: Type.Optional(Type.String()),
	allowFrom: Type.Optional(Type.Array(Type.String())),
	tokenSource: Type.Optional(Type.String()),
	botTokenSource: Type.Optional(Type.String()),
	appTokenSource: Type.Optional(Type.String()),
	baseUrl: Type.Optional(Type.String()),
	allowUnmentionedGroups: Type.Optional(Type.Boolean()),
	cliPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	dbPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	port: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
	probe: Type.Optional(Type.Unknown()),
	audit: Type.Optional(Type.Unknown()),
	application: Type.Optional(Type.Unknown())
}, { additionalProperties: true });
const ChannelUiMetaSchema = Type.Object({
	id: NonEmptyString,
	label: NonEmptyString,
	detailLabel: NonEmptyString,
	systemImage: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChannelEventLoopHealthSchema = Type.Object({
	degraded: Type.Boolean(),
	reasons: Type.Array(Type.Union([
		Type.Literal("event_loop_delay"),
		Type.Literal("event_loop_utilization"),
		Type.Literal("cpu")
	])),
	intervalMs: Type.Integer({ minimum: 0 }),
	delayP99Ms: Type.Number({ minimum: 0 }),
	delayMaxMs: Type.Number({ minimum: 0 }),
	utilization: Type.Number({ minimum: 0 }),
	cpuCoreRatio: Type.Number({ minimum: 0 })
}, { additionalProperties: false });
const ChannelsStatusResultSchema = Type.Object({
	ts: Type.Integer({ minimum: 0 }),
	channelOrder: Type.Array(NonEmptyString),
	channelLabels: Type.Record(NonEmptyString, NonEmptyString),
	channelDetailLabels: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
	channelSystemImages: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
	channelMeta: Type.Optional(Type.Array(ChannelUiMetaSchema)),
	channels: Type.Record(NonEmptyString, Type.Unknown()),
	channelAccounts: Type.Record(NonEmptyString, Type.Array(ChannelAccountSnapshotSchema)),
	channelDefaultAccountId: Type.Record(NonEmptyString, NonEmptyString),
	eventLoop: Type.Optional(ChannelEventLoopHealthSchema),
	partial: Type.Optional(Type.Boolean()),
	warnings: Type.Optional(Type.Array(Type.String()))
}, { additionalProperties: false });
const ChannelsLogoutParamsSchema = Type.Object({
	channel: NonEmptyString,
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChannelsStopParamsSchema = Type.Object({
	channel: NonEmptyString,
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChannelsStartParamsSchema = Type.Object({
	channel: NonEmptyString,
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const WebLoginStartParamsSchema = Type.Object({
	force: Type.Optional(Type.Boolean()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	verbose: Type.Optional(Type.Boolean()),
	accountId: Type.Optional(Type.String())
}, { additionalProperties: false });
const QrDataUrlSchema = Type.String({
	maxLength: 16384,
	pattern: "^data:image/png;base64,"
});
const WebLoginWaitParamsSchema = Type.Object({
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	accountId: Type.Optional(Type.String()),
	currentQrDataUrl: Type.Optional(QrDataUrlSchema)
}, { additionalProperties: false });
const COMMAND_DESCRIPTION_MAX_LENGTH = 2e3;
const BoundedNonEmptyString = (maxLength) => Type.String({
	minLength: 1,
	maxLength
});
const CommandSourceSchema = Type.Union([
	Type.Literal("native"),
	Type.Literal("skill"),
	Type.Literal("plugin")
]);
const CommandScopeSchema = Type.Union([
	Type.Literal("text"),
	Type.Literal("native"),
	Type.Literal("both")
]);
const CommandCategorySchema = Type.Union([
	Type.Literal("session"),
	Type.Literal("options"),
	Type.Literal("status"),
	Type.Literal("management"),
	Type.Literal("media"),
	Type.Literal("tools"),
	Type.Literal("docks")
]);
const CommandArgChoiceSchema = Type.Object({
	value: Type.String({ maxLength: 200 }),
	label: Type.String({ maxLength: 200 })
}, { additionalProperties: false });
const CommandArgSchema = Type.Object({
	name: BoundedNonEmptyString(200),
	description: Type.String({ maxLength: 500 }),
	type: Type.Union([
		Type.Literal("string"),
		Type.Literal("number"),
		Type.Literal("boolean")
	]),
	required: Type.Optional(Type.Boolean()),
	choices: Type.Optional(Type.Array(CommandArgChoiceSchema, { maxItems: 50 })),
	dynamic: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const CommandEntrySchema = Type.Object({
	name: BoundedNonEmptyString(200),
	nativeName: Type.Optional(BoundedNonEmptyString(200)),
	textAliases: Type.Optional(Type.Array(BoundedNonEmptyString(200), { maxItems: 20 })),
	description: Type.String({ maxLength: COMMAND_DESCRIPTION_MAX_LENGTH }),
	category: Type.Optional(CommandCategorySchema),
	source: CommandSourceSchema,
	scope: CommandScopeSchema,
	acceptsArgs: Type.Boolean(),
	args: Type.Optional(Type.Array(CommandArgSchema, { maxItems: 20 }))
}, { additionalProperties: false });
const CommandsListParamsSchema = Type.Object({
	agentId: Type.Optional(NonEmptyString),
	provider: Type.Optional(NonEmptyString),
	scope: Type.Optional(CommandScopeSchema),
	includeArgs: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const CommandsListResultSchema = Type.Object({ commands: Type.Array(CommandEntrySchema, { maxItems: 500 }) }, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/config.ts
const ConfigSchemaLookupPathString = Type.String({
	minLength: 1,
	maxLength: 1024,
	pattern: "^[A-Za-z0-9_./\\[\\]\\-*]+$"
});
const ConfigDeliveryContextSchema = Type.Object({
	channel: Type.Optional(Type.String()),
	to: Type.Optional(Type.String()),
	accountId: Type.Optional(Type.String()),
	threadId: Type.Optional(Type.Union([Type.String(), Type.Number()]))
}, { additionalProperties: false });
const ConfigGetParamsSchema = Type.Object({}, { additionalProperties: false });
const ConfigSetParamsSchema = Type.Object({
	raw: NonEmptyString,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ConfigApplyLikeParamsSchema = Type.Object({
	raw: NonEmptyString,
	baseHash: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(Type.String()),
	deliveryContext: Type.Optional(ConfigDeliveryContextSchema),
	note: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ConfigApplyParamsSchema = ConfigApplyLikeParamsSchema;
const ConfigPatchParamsSchema = ConfigApplyLikeParamsSchema;
const ConfigSchemaParamsSchema = Type.Object({}, { additionalProperties: false });
const ConfigSchemaLookupParamsSchema = Type.Object({ path: ConfigSchemaLookupPathString }, { additionalProperties: false });
const UpdateStatusParamsSchema = Type.Object({}, { additionalProperties: false });
const UpdateRunParamsSchema = Type.Object({
	sessionKey: Type.Optional(Type.String()),
	deliveryContext: Type.Optional(ConfigDeliveryContextSchema),
	note: Type.Optional(Type.String()),
	continuationMessage: Type.Optional(Type.String()),
	restartDelayMs: Type.Optional(Type.Integer({ minimum: 0 })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const ConfigUiHintSchema = Type.Object({
	label: Type.Optional(Type.String()),
	help: Type.Optional(Type.String()),
	tags: Type.Optional(Type.Array(Type.String())),
	group: Type.Optional(Type.String()),
	order: Type.Optional(Type.Integer()),
	advanced: Type.Optional(Type.Boolean()),
	sensitive: Type.Optional(Type.Boolean()),
	placeholder: Type.Optional(Type.String()),
	itemTemplate: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const ConfigSchemaResponseSchema = Type.Object({
	schema: Type.Unknown(),
	uiHints: Type.Record(Type.String(), ConfigUiHintSchema),
	version: NonEmptyString,
	generatedAt: NonEmptyString
}, { additionalProperties: false });
const ConfigSchemaLookupChildSchema = Type.Object({
	key: NonEmptyString,
	path: NonEmptyString,
	type: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
	required: Type.Boolean(),
	hasChildren: Type.Boolean(),
	reloadKind: Type.Optional(Type.Union([
		Type.Literal("restart"),
		Type.Literal("hot"),
		Type.Literal("none")
	])),
	hint: Type.Optional(ConfigUiHintSchema),
	hintPath: Type.Optional(Type.String())
}, { additionalProperties: false });
const ConfigSchemaLookupResultSchema = Type.Object({
	path: NonEmptyString,
	schema: Type.Unknown(),
	reloadKind: Type.Optional(Type.Union([
		Type.Literal("restart"),
		Type.Literal("hot"),
		Type.Literal("none")
	])),
	hint: Type.Optional(ConfigUiHintSchema),
	hintPath: Type.Optional(Type.String()),
	children: Type.Array(ConfigSchemaLookupChildSchema)
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/cron.ts
function cronAgentTurnPayloadSchema(params) {
	return Type.Object({
		kind: Type.Literal("agentTurn"),
		message: params.message,
		model: Type.Optional(Type.String()),
		fallbacks: Type.Optional(Type.Array(Type.String())),
		thinking: Type.Optional(Type.String()),
		timeoutSeconds: Type.Optional(Type.Number({ minimum: 0 })),
		allowUnsafeExternalContent: Type.Optional(Type.Boolean()),
		lightContext: Type.Optional(Type.Boolean()),
		toolsAllow: Type.Optional(params.toolsAllow)
	}, { additionalProperties: false });
}
const CronSessionTargetSchema = Type.Union([
	Type.Literal("main"),
	Type.Literal("isolated"),
	Type.Literal("current"),
	Type.String({ pattern: "^session:.+" })
]);
const CronWakeModeSchema = Type.Union([Type.Literal("next-heartbeat"), Type.Literal("now")]);
function cronRunStatusSchema(options = {}) {
	return Type.Union([
		Type.Literal("ok"),
		Type.Literal("error"),
		Type.Literal("skipped")
	], options);
}
const CronRunStatusSchema = cronRunStatusSchema();
const DeprecatedCronRunStatusSchema = cronRunStatusSchema({
	deprecated: true,
	description: "Deprecated alias for lastRunStatus."
});
const CronSortDirSchema = Type.Union([Type.Literal("asc"), Type.Literal("desc")]);
const CronJobsEnabledFilterSchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("enabled"),
	Type.Literal("disabled")
]);
const CronJobsSortBySchema = Type.Union([
	Type.Literal("nextRunAtMs"),
	Type.Literal("updatedAtMs"),
	Type.Literal("name")
]);
const CronRunsStatusFilterSchema = Type.Union([
	Type.Literal("all"),
	Type.Literal("ok"),
	Type.Literal("error"),
	Type.Literal("skipped")
]);
const CronRunsStatusValueSchema = Type.Union([
	Type.Literal("ok"),
	Type.Literal("error"),
	Type.Literal("skipped")
]);
const CronDeliveryStatusSchema = Type.Union([
	Type.Literal("delivered"),
	Type.Literal("not-delivered"),
	Type.Literal("unknown"),
	Type.Literal("not-requested")
]);
const CronFailoverReasonSchema = Type.Union([
	Type.Literal("auth"),
	Type.Literal("format"),
	Type.Literal("rate_limit"),
	Type.Literal("billing"),
	Type.Literal("server_error"),
	Type.Literal("timeout"),
	Type.Literal("model_not_found"),
	Type.Literal("empty_response"),
	Type.Literal("no_error_details"),
	Type.Literal("unclassified"),
	Type.Literal("unknown")
]);
const CronRunDiagnosticSeveritySchema = Type.Union([
	Type.Literal("info"),
	Type.Literal("warn"),
	Type.Literal("error")
]);
const CronRunDiagnosticSourceSchema = Type.Union([
	Type.Literal("cron-preflight"),
	Type.Literal("cron-setup"),
	Type.Literal("model-preflight"),
	Type.Literal("agent-run"),
	Type.Literal("tool"),
	Type.Literal("exec"),
	Type.Literal("delivery")
]);
const CronRunDiagnosticSchema = Type.Object({
	ts: Type.Integer({ minimum: 0 }),
	source: CronRunDiagnosticSourceSchema,
	severity: CronRunDiagnosticSeveritySchema,
	message: Type.String(),
	toolName: Type.Optional(Type.String()),
	exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	truncated: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const CronRunDiagnosticsSchema = Type.Object({
	summary: Type.Optional(Type.String()),
	entries: Type.Array(CronRunDiagnosticSchema)
}, { additionalProperties: false });
const CronCommonOptionalFields = {
	agentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	sessionKey: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	description: Type.Optional(Type.String()),
	enabled: Type.Optional(Type.Boolean()),
	deleteAfterRun: Type.Optional(Type.Boolean())
};
function cronIdOrJobIdParams(extraFields) {
	return Type.Union([Type.Object({
		id: NonEmptyString,
		...extraFields
	}, { additionalProperties: false }), Type.Object({
		jobId: NonEmptyString,
		...extraFields
	}, { additionalProperties: false })]);
}
const CronRunLogJobIdSchema = Type.String({
	minLength: 1,
	pattern: "^[^/\\\\]+$"
});
const CronScheduleSchema = Type.Union([
	Type.Object({
		kind: Type.Literal("at"),
		at: NonEmptyString
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("every"),
		everyMs: Type.Integer({ minimum: 1 }),
		anchorMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false }),
	Type.Object({
		kind: Type.Literal("cron"),
		expr: NonEmptyString,
		tz: Type.Optional(Type.String()),
		staggerMs: Type.Optional(Type.Integer({ minimum: 0 }))
	}, { additionalProperties: false })
]);
const CronPayloadSchema = Type.Union([Type.Object({
	kind: Type.Literal("systemEvent"),
	text: NonEmptyString
}, { additionalProperties: false }), cronAgentTurnPayloadSchema({
	message: NonEmptyString,
	toolsAllow: Type.Array(Type.String())
})]);
const CronPayloadPatchSchema = Type.Union([Type.Object({
	kind: Type.Literal("systemEvent"),
	text: Type.Optional(NonEmptyString)
}, { additionalProperties: false }), cronAgentTurnPayloadSchema({
	message: Type.Optional(NonEmptyString),
	toolsAllow: Type.Union([Type.Array(Type.String()), Type.Null()])
})]);
const CronFailureAlertSchema = Type.Object({
	after: Type.Optional(Type.Integer({ minimum: 1 })),
	channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
	to: Type.Optional(Type.String()),
	cooldownMs: Type.Optional(Type.Integer({ minimum: 0 })),
	includeSkipped: Type.Optional(Type.Boolean()),
	mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")])),
	accountId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const CronFailureDestinationSchema = Type.Object({
	channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
	to: Type.Optional(Type.String()),
	accountId: Type.Optional(NonEmptyString),
	mode: Type.Optional(Type.Union([Type.Literal("announce"), Type.Literal("webhook")]))
}, { additionalProperties: false });
const CronDeliverySharedProperties = {
	channel: Type.Optional(Type.Union([Type.Literal("last"), NonEmptyString])),
	threadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
	accountId: Type.Optional(NonEmptyString),
	bestEffort: Type.Optional(Type.Boolean()),
	failureDestination: Type.Optional(CronFailureDestinationSchema)
};
const CronDeliveryNoopSchema = Type.Object({
	mode: Type.Literal("none"),
	...CronDeliverySharedProperties,
	to: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronDeliveryAnnounceSchema = Type.Object({
	mode: Type.Literal("announce"),
	...CronDeliverySharedProperties,
	to: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronDeliveryWebhookSchema = Type.Object({
	mode: Type.Literal("webhook"),
	...CronDeliverySharedProperties,
	to: NonEmptyString
}, { additionalProperties: false });
const CronDeliverySchema = Type.Union([
	CronDeliveryNoopSchema,
	CronDeliveryAnnounceSchema,
	CronDeliveryWebhookSchema
]);
const CronDeliveryPatchSchema = Type.Object({
	mode: Type.Optional(Type.Union([
		Type.Literal("none"),
		Type.Literal("announce"),
		Type.Literal("webhook")
	])),
	...CronDeliverySharedProperties,
	to: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronFailureNotificationDeliverySchema = Type.Object({
	delivered: Type.Optional(Type.Boolean()),
	status: CronDeliveryStatusSchema,
	error: Type.Optional(Type.String())
}, { additionalProperties: false });
const CronJobStateSchema = Type.Object({
	nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunStatus: Type.Optional(CronRunStatusSchema),
	lastStatus: Type.Optional(DeprecatedCronRunStatusSchema),
	lastError: Type.Optional(Type.String()),
	lastDiagnostics: Type.Optional(CronRunDiagnosticsSchema),
	lastDiagnosticSummary: Type.Optional(Type.String()),
	lastErrorReason: Type.Optional(CronFailoverReasonSchema),
	lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 })),
	consecutiveSkipped: Type.Optional(Type.Integer({ minimum: 0 })),
	lastDelivered: Type.Optional(Type.Boolean()),
	lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	lastDeliveryError: Type.Optional(Type.String()),
	lastFailureNotificationDelivered: Type.Optional(Type.Boolean()),
	lastFailureNotificationDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	lastFailureNotificationDeliveryError: Type.Optional(Type.String()),
	lastFailureAlertAtMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const CronJobStatePatchSchema = Type.Object({
	nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	runningAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	lastRunStatus: Type.Optional(CronRunStatusSchema),
	lastStatus: Type.Optional(DeprecatedCronRunStatusSchema),
	lastError: Type.Optional(Type.String()),
	lastErrorReason: Type.Optional(CronFailoverReasonSchema),
	lastDurationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	consecutiveErrors: Type.Optional(Type.Integer({ minimum: 0 })),
	consecutiveSkipped: Type.Optional(Type.Integer({ minimum: 0 })),
	lastDelivered: Type.Optional(Type.Boolean()),
	lastDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	lastDeliveryError: Type.Optional(Type.String()),
	lastFailureNotificationDelivered: Type.Optional(Type.Boolean()),
	lastFailureNotificationDeliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	lastFailureNotificationDeliveryError: Type.Optional(Type.String()),
	lastFailureAlertAtMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const CronJobSchema = Type.Object({
	id: NonEmptyString,
	agentId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(NonEmptyString),
	name: NonEmptyString,
	description: Type.Optional(Type.String()),
	enabled: Type.Boolean(),
	deleteAfterRun: Type.Optional(Type.Boolean()),
	createdAtMs: Type.Integer({ minimum: 0 }),
	updatedAtMs: Type.Integer({ minimum: 0 }),
	schedule: CronScheduleSchema,
	sessionTarget: CronSessionTargetSchema,
	wakeMode: CronWakeModeSchema,
	payload: CronPayloadSchema,
	delivery: Type.Optional(CronDeliverySchema),
	failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
	state: CronJobStateSchema
}, { additionalProperties: false });
const CronListParamsSchema = Type.Object({
	includeDisabled: Type.Optional(Type.Boolean()),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 200
	})),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	query: Type.Optional(Type.String()),
	enabled: Type.Optional(CronJobsEnabledFilterSchema),
	sortBy: Type.Optional(CronJobsSortBySchema),
	sortDir: Type.Optional(CronSortDirSchema),
	agentId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const CronStatusParamsSchema = Type.Object({}, { additionalProperties: false });
const CronGetParamsSchema = cronIdOrJobIdParams({});
const CronAddParamsSchema = Type.Object({
	name: NonEmptyString,
	...CronCommonOptionalFields,
	schedule: CronScheduleSchema,
	sessionTarget: CronSessionTargetSchema,
	wakeMode: CronWakeModeSchema,
	payload: CronPayloadSchema,
	delivery: Type.Optional(CronDeliverySchema),
	failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema]))
}, { additionalProperties: false });
const CronUpdateParamsSchema = cronIdOrJobIdParams({ patch: Type.Object({
	name: Type.Optional(NonEmptyString),
	...CronCommonOptionalFields,
	schedule: Type.Optional(CronScheduleSchema),
	sessionTarget: Type.Optional(CronSessionTargetSchema),
	wakeMode: Type.Optional(CronWakeModeSchema),
	payload: Type.Optional(CronPayloadPatchSchema),
	delivery: Type.Optional(CronDeliveryPatchSchema),
	failureAlert: Type.Optional(Type.Union([Type.Literal(false), CronFailureAlertSchema])),
	state: Type.Optional(CronJobStatePatchSchema)
}, { additionalProperties: false }) });
const CronRemoveParamsSchema = cronIdOrJobIdParams({});
const CronRunParamsSchema = cronIdOrJobIdParams({ mode: Type.Optional(Type.Union([Type.Literal("due"), Type.Literal("force")])) });
const CronRunsParamsSchema = Type.Object({
	scope: Type.Optional(Type.Union([Type.Literal("job"), Type.Literal("all")])),
	id: Type.Optional(CronRunLogJobIdSchema),
	jobId: Type.Optional(CronRunLogJobIdSchema),
	runId: Type.Optional(NonEmptyString),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 200
	})),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	statuses: Type.Optional(Type.Array(CronRunsStatusValueSchema, {
		minItems: 1,
		maxItems: 3
	})),
	status: Type.Optional(CronRunsStatusFilterSchema),
	deliveryStatuses: Type.Optional(Type.Array(CronDeliveryStatusSchema, {
		minItems: 1,
		maxItems: 4
	})),
	deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	query: Type.Optional(Type.String()),
	sortDir: Type.Optional(CronSortDirSchema)
}, { additionalProperties: false });
const CronRunLogEntrySchema = Type.Object({
	ts: Type.Integer({ minimum: 0 }),
	jobId: NonEmptyString,
	action: Type.Literal("finished"),
	status: Type.Optional(CronRunStatusSchema),
	error: Type.Optional(Type.String()),
	summary: Type.Optional(Type.String()),
	diagnostics: Type.Optional(CronRunDiagnosticsSchema),
	delivered: Type.Optional(Type.Boolean()),
	deliveryStatus: Type.Optional(CronDeliveryStatusSchema),
	deliveryError: Type.Optional(Type.String()),
	failureNotificationDelivery: Type.Optional(CronFailureNotificationDeliverySchema),
	sessionId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(NonEmptyString),
	runId: Type.Optional(NonEmptyString),
	runAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
	nextRunAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	model: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	usage: Type.Optional(Type.Object({
		input_tokens: Type.Optional(Type.Number()),
		output_tokens: Type.Optional(Type.Number()),
		total_tokens: Type.Optional(Type.Number()),
		cache_read_tokens: Type.Optional(Type.Number()),
		cache_write_tokens: Type.Optional(Type.Number())
	}, { additionalProperties: false })),
	jobName: Type.Optional(Type.String())
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/error-codes.ts
const ErrorCodes = {
	NOT_LINKED: "NOT_LINKED",
	NOT_PAIRED: "NOT_PAIRED",
	AGENT_TIMEOUT: "AGENT_TIMEOUT",
	INVALID_REQUEST: "INVALID_REQUEST",
	APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
	UNAVAILABLE: "UNAVAILABLE"
};
function errorShape(code, message, opts) {
	return {
		code,
		message,
		...opts
	};
}
//#endregion
//#region src/gateway/protocol/schema/environments.ts
const EnvironmentStatusSchema = Type.String({ enum: [
	"available",
	"unavailable",
	"starting",
	"stopping",
	"error"
] });
function createEnvironmentSummarySchema() {
	return Type.Object({
		id: NonEmptyString,
		type: NonEmptyString,
		label: Type.Optional(NonEmptyString),
		status: EnvironmentStatusSchema,
		capabilities: Type.Optional(Type.Array(NonEmptyString))
	}, { additionalProperties: false });
}
const EnvironmentSummarySchema = createEnvironmentSummarySchema();
const EnvironmentsListParamsSchema = Type.Object({}, { additionalProperties: false });
const EnvironmentsListResultSchema = Type.Object({ environments: Type.Array(EnvironmentSummarySchema) }, { additionalProperties: false });
const EnvironmentsStatusParamsSchema = Type.Object({ environmentId: NonEmptyString }, { additionalProperties: false });
const EnvironmentsStatusResultSchema = createEnvironmentSummarySchema();
//#endregion
//#region src/gateway/protocol/schema/exec-approvals.ts
const ExecApprovalsAllowlistEntrySchema = Type.Object({
	id: Type.Optional(NonEmptyString),
	pattern: Type.String(),
	source: Type.Optional(Type.Literal("allow-always")),
	commandText: Type.Optional(Type.String()),
	argPattern: Type.Optional(Type.String()),
	lastUsedAt: Type.Optional(Type.Integer({ minimum: 0 })),
	lastUsedCommand: Type.Optional(Type.String()),
	lastResolvedPath: Type.Optional(Type.String())
}, { additionalProperties: false });
const ExecApprovalsPolicyFields = {
	security: Type.Optional(Type.String()),
	ask: Type.Optional(Type.String()),
	askFallback: Type.Optional(Type.String()),
	autoAllowSkills: Type.Optional(Type.Boolean())
};
const ExecApprovalsDefaultsSchema = Type.Object(ExecApprovalsPolicyFields, { additionalProperties: false });
const ExecApprovalsAgentSchema = Type.Object({
	...ExecApprovalsPolicyFields,
	allowlist: Type.Optional(Type.Array(ExecApprovalsAllowlistEntrySchema))
}, { additionalProperties: false });
const ExecApprovalsFileSchema = Type.Object({
	version: Type.Literal(1),
	socket: Type.Optional(Type.Object({
		path: Type.Optional(Type.String()),
		token: Type.Optional(Type.String())
	}, { additionalProperties: false })),
	defaults: Type.Optional(ExecApprovalsDefaultsSchema),
	agents: Type.Optional(Type.Record(Type.String(), ExecApprovalsAgentSchema))
}, { additionalProperties: false });
const ExecApprovalsSnapshotSchema = Type.Object({
	path: NonEmptyString,
	exists: Type.Boolean(),
	hash: NonEmptyString,
	file: ExecApprovalsFileSchema
}, { additionalProperties: false });
const ExecApprovalsGetParamsSchema = Type.Object({}, { additionalProperties: false });
const ExecApprovalsSetParamsSchema = Type.Object({
	file: ExecApprovalsFileSchema,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ExecApprovalsNodeGetParamsSchema = Type.Object({ nodeId: NonEmptyString }, { additionalProperties: false });
const ExecApprovalsNodeSetParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	file: ExecApprovalsFileSchema,
	baseHash: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ExecApprovalGetParamsSchema = Type.Object({ id: NonEmptyString }, { additionalProperties: false });
const ExecApprovalRequestParamsSchema = Type.Object({
	id: Type.Optional(NonEmptyString),
	command: Type.Optional(NonEmptyString),
	commandArgv: Type.Optional(Type.Array(Type.String())),
	systemRunPlan: Type.Optional(Type.Object({
		argv: Type.Array(Type.String()),
		cwd: Type.Union([Type.String(), Type.Null()]),
		commandText: Type.String(),
		commandPreview: Type.Optional(Type.Union([Type.String(), Type.Null()])),
		agentId: Type.Union([Type.String(), Type.Null()]),
		sessionKey: Type.Union([Type.String(), Type.Null()]),
		mutableFileOperand: Type.Optional(Type.Union([Type.Object({
			argvIndex: Type.Integer({ minimum: 0 }),
			path: Type.String(),
			sha256: Type.String()
		}, { additionalProperties: false }), Type.Null()]))
	}, { additionalProperties: false })),
	env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
	cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	nodeId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	host: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	security: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	ask: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	warningText: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	commandSpans: Type.Optional(Type.Array(Type.Object({
		startIndex: Type.Integer({
			minimum: 0,
			description: "Inclusive UTF-16 code unit offset into command."
		}),
		endIndex: Type.Integer({
			minimum: 1,
			description: "Exclusive UTF-16 code unit offset into command; must be greater than startIndex and no greater than command.length."
		})
	}, { additionalProperties: false }))),
	agentId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	resolvedPath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	sessionKey: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceChannel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceTo: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceAccountId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	turnSourceThreadId: Type.Optional(Type.Union([
		Type.String(),
		Type.Number(),
		Type.Null()
	])),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
	twoPhase: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ExecApprovalResolveParamsSchema = Type.Object({
	id: NonEmptyString,
	decision: NonEmptyString
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/devices.ts
const DevicePairListParamsSchema = Type.Object({}, { additionalProperties: false });
const DevicePairApproveParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const DevicePairRejectParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const DevicePairRemoveParamsSchema = Type.Object({ deviceId: NonEmptyString }, { additionalProperties: false });
const DeviceTokenRotateParamsSchema = Type.Object({
	deviceId: NonEmptyString,
	role: NonEmptyString,
	scopes: Type.Optional(Type.Array(NonEmptyString))
}, { additionalProperties: false });
const DeviceTokenRevokeParamsSchema = Type.Object({
	deviceId: NonEmptyString,
	role: NonEmptyString
}, { additionalProperties: false });
const DevicePairRequestedEventSchema = Type.Object({
	requestId: NonEmptyString,
	deviceId: NonEmptyString,
	publicKey: NonEmptyString,
	displayName: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	clientId: Type.Optional(NonEmptyString),
	clientMode: Type.Optional(NonEmptyString),
	role: Type.Optional(NonEmptyString),
	roles: Type.Optional(Type.Array(NonEmptyString)),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	remoteIp: Type.Optional(NonEmptyString),
	silent: Type.Optional(Type.Boolean()),
	isRepair: Type.Optional(Type.Boolean()),
	ts: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const DevicePairResolvedEventSchema = Type.Object({
	requestId: NonEmptyString,
	deviceId: NonEmptyString,
	decision: NonEmptyString,
	ts: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/snapshot.ts
const PresenceEntrySchema = Type.Object({
	host: Type.Optional(NonEmptyString),
	ip: Type.Optional(NonEmptyString),
	version: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	modelIdentifier: Type.Optional(NonEmptyString),
	mode: Type.Optional(NonEmptyString),
	lastInputSeconds: Type.Optional(Type.Integer({ minimum: 0 })),
	reason: Type.Optional(NonEmptyString),
	tags: Type.Optional(Type.Array(NonEmptyString)),
	text: Type.Optional(Type.String()),
	ts: Type.Integer({ minimum: 0 }),
	deviceId: Type.Optional(NonEmptyString),
	roles: Type.Optional(Type.Array(NonEmptyString)),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	instanceId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const HealthSnapshotSchema = Type.Any();
const SessionDefaultsSchema = Type.Object({
	defaultAgentId: NonEmptyString,
	mainKey: NonEmptyString,
	mainSessionKey: NonEmptyString,
	scope: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const StateVersionSchema = Type.Object({
	presence: Type.Integer({ minimum: 0 }),
	health: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });
const SnapshotSchema = Type.Object({
	presence: Type.Array(PresenceEntrySchema),
	health: HealthSnapshotSchema,
	stateVersion: StateVersionSchema,
	uptimeMs: Type.Integer({ minimum: 0 }),
	configPath: Type.Optional(NonEmptyString),
	stateDir: Type.Optional(NonEmptyString),
	sessionDefaults: Type.Optional(SessionDefaultsSchema),
	authMode: Type.Optional(Type.Union([
		Type.Literal("none"),
		Type.Literal("token"),
		Type.Literal("password"),
		Type.Literal("trusted-proxy")
	])),
	updateAvailable: Type.Optional(Type.Object({
		currentVersion: NonEmptyString,
		latestVersion: NonEmptyString,
		channel: NonEmptyString
	}))
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/frames.ts
const TickEventSchema = Type.Object({ ts: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
const ShutdownEventSchema = Type.Object({
	reason: NonEmptyString,
	restartExpectedMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const ConnectParamsSchema = Type.Object({
	minProtocol: Type.Integer({ minimum: 1 }),
	maxProtocol: Type.Integer({ minimum: 1 }),
	client: Type.Object({
		id: GatewayClientIdSchema,
		displayName: Type.Optional(NonEmptyString),
		version: NonEmptyString,
		platform: NonEmptyString,
		deviceFamily: Type.Optional(NonEmptyString),
		modelIdentifier: Type.Optional(NonEmptyString),
		mode: GatewayClientModeSchema,
		instanceId: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }),
	caps: Type.Optional(Type.Array(NonEmptyString, { default: [] })),
	commands: Type.Optional(Type.Array(NonEmptyString)),
	permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
	pathEnv: Type.Optional(Type.String()),
	role: Type.Optional(NonEmptyString),
	scopes: Type.Optional(Type.Array(NonEmptyString)),
	device: Type.Optional(Type.Object({
		id: NonEmptyString,
		publicKey: NonEmptyString,
		signature: NonEmptyString,
		signedAt: Type.Integer({ minimum: 0 }),
		nonce: NonEmptyString
	}, { additionalProperties: false })),
	auth: Type.Optional(Type.Object({
		token: Type.Optional(Type.String()),
		bootstrapToken: Type.Optional(Type.String()),
		deviceToken: Type.Optional(Type.String()),
		password: Type.Optional(Type.String()),
		approvalRuntimeToken: Type.Optional(Type.String())
	}, { additionalProperties: false })),
	locale: Type.Optional(Type.String()),
	userAgent: Type.Optional(Type.String())
}, { additionalProperties: false });
const HelloOkSchema = Type.Object({
	type: Type.Literal("hello-ok"),
	protocol: Type.Integer({ minimum: 1 }),
	server: Type.Object({
		version: NonEmptyString,
		connId: NonEmptyString
	}, { additionalProperties: false }),
	features: Type.Object({
		methods: Type.Array(NonEmptyString),
		events: Type.Array(NonEmptyString)
	}, { additionalProperties: false }),
	snapshot: SnapshotSchema,
	pluginSurfaceUrls: Type.Optional(Type.Record(NonEmptyString, NonEmptyString)),
	auth: Type.Object({
		deviceToken: Type.Optional(NonEmptyString),
		role: NonEmptyString,
		scopes: Type.Array(NonEmptyString),
		issuedAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
		deviceTokens: Type.Optional(Type.Array(Type.Object({
			deviceToken: NonEmptyString,
			role: NonEmptyString,
			scopes: Type.Array(NonEmptyString),
			issuedAtMs: Type.Integer({ minimum: 0 })
		}, { additionalProperties: false })))
	}, { additionalProperties: false }),
	policy: Type.Object({
		maxPayload: Type.Integer({ minimum: 1 }),
		maxBufferedBytes: Type.Integer({ minimum: 1 }),
		tickIntervalMs: Type.Integer({ minimum: 1 })
	}, { additionalProperties: false })
}, { additionalProperties: false });
const ErrorShapeSchema = Type.Object({
	code: NonEmptyString,
	message: NonEmptyString,
	details: Type.Optional(Type.Unknown()),
	retryable: Type.Optional(Type.Boolean()),
	retryAfterMs: Type.Optional(Type.Integer({ minimum: 0 }))
}, { additionalProperties: false });
const RequestFrameSchema = Type.Object({
	type: Type.Literal("req"),
	id: NonEmptyString,
	method: NonEmptyString,
	params: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const ResponseFrameSchema = Type.Object({
	type: Type.Literal("res"),
	id: NonEmptyString,
	ok: Type.Boolean(),
	payload: Type.Optional(Type.Unknown()),
	error: Type.Optional(ErrorShapeSchema)
}, { additionalProperties: false });
const EventFrameSchema = Type.Object({
	type: Type.Literal("event"),
	event: NonEmptyString,
	payload: Type.Optional(Type.Unknown()),
	seq: Type.Optional(Type.Integer({ minimum: 0 })),
	stateVersion: Type.Optional(StateVersionSchema)
}, { additionalProperties: false });
const GatewayFrameSchema = Type.Union([
	RequestFrameSchema,
	ResponseFrameSchema,
	EventFrameSchema
], { discriminator: "type" });
//#endregion
//#region src/gateway/protocol/schema/logs-chat.ts
const LogsTailParamsSchema = Type.Object({
	cursor: Type.Optional(Type.Integer({ minimum: 0 })),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 5e3
	})),
	maxBytes: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 1e6
	}))
}, { additionalProperties: false });
const LogsTailResultSchema = Type.Object({
	file: NonEmptyString,
	cursor: Type.Integer({ minimum: 0 }),
	size: Type.Integer({ minimum: 0 }),
	lines: Type.Array(Type.String()),
	truncated: Type.Optional(Type.Boolean()),
	reset: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const ChatHistoryParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 1e3
	})),
	maxChars: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 5e5
	}))
}, { additionalProperties: false });
const ChatSendParamsSchema = Type.Object({
	sessionKey: ChatSendSessionKeyString,
	sessionId: Type.Optional(NonEmptyString),
	message: Type.String(),
	thinking: Type.Optional(Type.String()),
	fastMode: Type.Optional(Type.Boolean()),
	deliver: Type.Optional(Type.Boolean()),
	originatingChannel: Type.Optional(Type.String()),
	originatingTo: Type.Optional(Type.String()),
	originatingAccountId: Type.Optional(Type.String()),
	originatingThreadId: Type.Optional(Type.String()),
	attachments: Type.Optional(Type.Array(Type.Unknown())),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	systemInputProvenance: Type.Optional(InputProvenanceSchema),
	systemProvenanceReceipt: Type.Optional(Type.String()),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const ChatAbortParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	runId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const ChatInjectParamsSchema = Type.Object({
	sessionKey: NonEmptyString,
	message: NonEmptyString,
	label: Type.Optional(Type.String({ maxLength: 100 }))
}, { additionalProperties: false });
const ChatEventBaseSchema = {
	runId: NonEmptyString,
	sessionKey: NonEmptyString,
	spawnedBy: Type.Optional(NonEmptyString),
	seq: Type.Integer({ minimum: 0 })
};
const ChatEventErrorKindSchema = Type.Union([
	Type.Literal("refusal"),
	Type.Literal("timeout"),
	Type.Literal("rate_limit"),
	Type.Literal("context_length"),
	Type.Literal("unknown")
]);
const ChatDeltaEventSchema = Type.Object({
	...ChatEventBaseSchema,
	state: Type.Literal("delta"),
	message: Type.Optional(Type.Unknown()),
	deltaText: Type.String(),
	replace: Type.Optional(Type.Boolean()),
	usage: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const ChatFinalEventSchema = Type.Object({
	...ChatEventBaseSchema,
	state: Type.Literal("final"),
	message: Type.Optional(Type.Unknown()),
	usage: Type.Optional(Type.Unknown()),
	stopReason: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChatAbortedEventSchema = Type.Object({
	...ChatEventBaseSchema,
	state: Type.Literal("aborted"),
	message: Type.Optional(Type.Unknown()),
	stopReason: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChatErrorEventSchema = Type.Object({
	...ChatEventBaseSchema,
	state: Type.Literal("error"),
	message: Type.Optional(Type.Unknown()),
	errorMessage: Type.Optional(Type.String()),
	errorKind: Type.Optional(ChatEventErrorKindSchema),
	usage: Type.Optional(Type.Unknown()),
	stopReason: Type.Optional(Type.String())
}, { additionalProperties: false });
const ChatEventSchema = Type.Union([
	ChatDeltaEventSchema,
	ChatFinalEventSchema,
	ChatAbortedEventSchema,
	ChatErrorEventSchema
]);
//#endregion
//#region src/gateway/protocol/schema/nodes.ts
const NodePendingWorkTypeSchema = Type.String({ enum: ["status.request", "location.request"] });
const NodePendingWorkPrioritySchema = Type.String({ enum: ["normal", "high"] });
const NodePresenceAliveReasonSchema = Type.String({ enum: [
	"background",
	"silent_push",
	"bg_app_refresh",
	"significant_location",
	"manual",
	"connect"
] });
const NodePresenceAlivePayloadSchema = Type.Object({
	trigger: NodePresenceAliveReasonSchema,
	sentAtMs: Type.Optional(Type.Integer({ minimum: 0 })),
	displayName: Type.Optional(NonEmptyString),
	version: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	modelIdentifier: Type.Optional(NonEmptyString),
	pushTransport: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const NodeEventResultSchema = Type.Object({
	ok: Type.Boolean(),
	event: NonEmptyString,
	handled: Type.Boolean(),
	reason: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const NodePairRequestParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	displayName: Type.Optional(NonEmptyString),
	platform: Type.Optional(NonEmptyString),
	version: Type.Optional(NonEmptyString),
	coreVersion: Type.Optional(NonEmptyString),
	uiVersion: Type.Optional(NonEmptyString),
	deviceFamily: Type.Optional(NonEmptyString),
	modelIdentifier: Type.Optional(NonEmptyString),
	caps: Type.Optional(Type.Array(NonEmptyString)),
	commands: Type.Optional(Type.Array(NonEmptyString)),
	permissions: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
	remoteIp: Type.Optional(NonEmptyString),
	silent: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const NodePairListParamsSchema = Type.Object({}, { additionalProperties: false });
const NodePairApproveParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const NodePairRejectParamsSchema = Type.Object({ requestId: NonEmptyString }, { additionalProperties: false });
const NodePairRemoveParamsSchema = Type.Object({ nodeId: NonEmptyString }, { additionalProperties: false });
const NodePairVerifyParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	token: NonEmptyString
}, { additionalProperties: false });
const NodeRenameParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	displayName: NonEmptyString
}, { additionalProperties: false });
const NodeListParamsSchema = Type.Object({}, { additionalProperties: false });
const NodePendingAckParamsSchema = Type.Object({ ids: Type.Array(NonEmptyString, { minItems: 1 }) }, { additionalProperties: false });
const NodeDescribeParamsSchema = Type.Object({ nodeId: NonEmptyString }, { additionalProperties: false });
const NodeInvokeParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	command: NonEmptyString,
	params: Type.Optional(Type.Unknown()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: NonEmptyString
}, { additionalProperties: false });
const NodeInvokeResultParamsSchema = Type.Object({
	id: NonEmptyString,
	nodeId: NonEmptyString,
	ok: Type.Boolean(),
	payload: Type.Optional(Type.Unknown()),
	payloadJSON: Type.Optional(Type.String()),
	error: Type.Optional(Type.Object({
		code: Type.Optional(NonEmptyString),
		message: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const NodeEventParamsSchema = Type.Object({
	event: NonEmptyString,
	payload: Type.Optional(Type.Unknown()),
	payloadJSON: Type.Optional(Type.String())
}, { additionalProperties: false });
const NodePendingDrainParamsSchema = Type.Object({ maxItems: Type.Optional(Type.Integer({
	minimum: 1,
	maximum: 10
})) }, { additionalProperties: false });
const NodePendingDrainItemSchema = Type.Object({
	id: NonEmptyString,
	type: NodePendingWorkTypeSchema,
	priority: Type.String({ enum: [
		"default",
		"normal",
		"high"
	] }),
	createdAtMs: Type.Integer({ minimum: 0 }),
	expiresAtMs: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
	payload: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
}, { additionalProperties: false });
const NodePendingDrainResultSchema = Type.Object({
	nodeId: NonEmptyString,
	revision: Type.Integer({ minimum: 0 }),
	items: Type.Array(NodePendingDrainItemSchema),
	hasMore: Type.Boolean()
}, { additionalProperties: false });
const NodePendingEnqueueParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	type: NodePendingWorkTypeSchema,
	priority: Type.Optional(NodePendingWorkPrioritySchema),
	expiresInMs: Type.Optional(Type.Integer({
		minimum: 1e3,
		maximum: 864e5
	})),
	wake: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const NodePendingEnqueueResultSchema = Type.Object({
	nodeId: NonEmptyString,
	revision: Type.Integer({ minimum: 0 }),
	queued: NodePendingDrainItemSchema,
	wakeTriggered: Type.Boolean()
}, { additionalProperties: false });
const NodeInvokeRequestEventSchema = Type.Object({
	id: NonEmptyString,
	nodeId: NonEmptyString,
	command: NonEmptyString,
	paramsJSON: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/plugin-approvals.ts
const PluginApprovalRequestParamsSchema = Type.Object({
	pluginId: Type.Optional(NonEmptyString),
	title: Type.String({
		minLength: 1,
		maxLength: 80
	}),
	description: Type.String({
		minLength: 1,
		maxLength: 256
	}),
	severity: Type.Optional(Type.String({ enum: [
		"info",
		"warning",
		"critical"
	] })),
	toolName: Type.Optional(Type.String()),
	toolCallId: Type.Optional(Type.String()),
	allowedDecisions: Type.Optional(Type.Array(Type.String({ enum: [
		"allow-once",
		"allow-always",
		"deny"
	] }), {
		minItems: 1,
		maxItems: 3
	})),
	agentId: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	turnSourceChannel: Type.Optional(Type.String()),
	turnSourceTo: Type.Optional(Type.String()),
	turnSourceAccountId: Type.Optional(Type.String()),
	turnSourceThreadId: Type.Optional(Type.Union([Type.String(), Type.Number()])),
	timeoutMs: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: MAX_PLUGIN_APPROVAL_TIMEOUT_MS
	})),
	twoPhase: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const PluginApprovalResolveParamsSchema = Type.Object({
	id: NonEmptyString,
	decision: NonEmptyString
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/plugins.ts
const PluginJsonValueSchema = Type.Unknown();
const PluginControlUiDescriptorSchema = Type.Object({
	id: NonEmptyString,
	pluginId: NonEmptyString,
	pluginName: Type.Optional(NonEmptyString),
	surface: Type.Union([
		Type.Literal("session"),
		Type.Literal("tool"),
		Type.Literal("run"),
		Type.Literal("settings")
	]),
	label: NonEmptyString,
	description: Type.Optional(Type.String()),
	placement: Type.Optional(Type.String()),
	schema: Type.Optional(PluginJsonValueSchema),
	requiredScopes: Type.Optional(Type.Array(NonEmptyString))
}, { additionalProperties: false });
const PluginsUiDescriptorsParamsSchema = Type.Object({}, { additionalProperties: false });
const PluginsUiDescriptorsResultSchema = Type.Object({
	ok: Type.Literal(true),
	descriptors: Type.Array(PluginControlUiDescriptorSchema)
}, { additionalProperties: false });
const PluginsSessionActionParamsSchema = Type.Object({
	pluginId: NonEmptyString,
	actionId: NonEmptyString,
	sessionKey: Type.Optional(NonEmptyString),
	payload: Type.Optional(PluginJsonValueSchema)
}, { additionalProperties: false });
const PluginsSessionActionSuccessResultSchema = Type.Object({
	ok: Type.Literal(true),
	result: Type.Optional(PluginJsonValueSchema),
	continueAgent: Type.Optional(Type.Boolean()),
	reply: Type.Optional(PluginJsonValueSchema)
}, { additionalProperties: false });
const PluginsSessionActionFailureResultSchema = Type.Object({
	ok: Type.Literal(false),
	error: Type.String(),
	code: Type.Optional(Type.String()),
	details: Type.Optional(PluginJsonValueSchema)
}, { additionalProperties: false });
const PluginsSessionActionResultSchema = Type.Union([PluginsSessionActionSuccessResultSchema, PluginsSessionActionFailureResultSchema]);
//#endregion
//#region src/gateway/protocol/schema/push.ts
const ApnsEnvironmentSchema = Type.String({ enum: ["sandbox", "production"] });
const PushTestParamsSchema = Type.Object({
	nodeId: NonEmptyString,
	title: Type.Optional(Type.String()),
	body: Type.Optional(Type.String()),
	environment: Type.Optional(ApnsEnvironmentSchema)
}, { additionalProperties: false });
const PushTestResultSchema = Type.Object({
	ok: Type.Boolean(),
	status: Type.Integer(),
	apnsId: Type.Optional(Type.String()),
	reason: Type.Optional(Type.String()),
	tokenSuffix: Type.String(),
	topic: Type.String(),
	environment: ApnsEnvironmentSchema,
	transport: Type.String({ enum: ["direct", "relay"] })
}, { additionalProperties: false });
const WebPushKeysSchema = Type.Object({
	p256dh: Type.String({
		minLength: 1,
		maxLength: 512
	}),
	auth: Type.String({
		minLength: 1,
		maxLength: 512
	})
}, { additionalProperties: false });
const WebPushVapidPublicKeyParamsSchema = Type.Object({}, { additionalProperties: false });
const WebPushSubscribeParamsSchema = Type.Object({
	endpoint: Type.String({
		minLength: 1,
		maxLength: 2048,
		pattern: "^https://"
	}),
	keys: WebPushKeysSchema
}, { additionalProperties: false });
const WebPushUnsubscribeParamsSchema = Type.Object({ endpoint: Type.String({
	minLength: 1,
	maxLength: 2048,
	pattern: "^https://"
}) }, { additionalProperties: false });
const WebPushTestParamsSchema = Type.Object({
	title: Type.Optional(Type.String()),
	body: Type.Optional(Type.String())
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/secrets.ts
const SecretsReloadParamsSchema = Type.Object({}, { additionalProperties: false });
const SecretsResolveParamsSchema = Type.Object({
	commandName: NonEmptyString,
	targetIds: Type.Array(NonEmptyString),
	allowedPaths: Type.Optional(Type.Array(NonEmptyString)),
	forcedActivePaths: Type.Optional(Type.Array(NonEmptyString)),
	optionalActivePaths: Type.Optional(Type.Array(NonEmptyString)),
	providerOverrides: Type.Optional(Type.Object({
		webSearch: Type.Optional(NonEmptyString),
		webFetch: Type.Optional(NonEmptyString)
	}, { additionalProperties: false }))
}, { additionalProperties: false });
const SecretsResolveAssignmentSchema = Type.Object({
	path: Type.Optional(NonEmptyString),
	pathSegments: Type.Array(NonEmptyString),
	value: Type.Unknown()
}, { additionalProperties: false });
const SecretsResolveResultSchema = Type.Object({
	ok: Type.Optional(Type.Boolean()),
	assignments: Type.Optional(Type.Array(SecretsResolveAssignmentSchema)),
	diagnostics: Type.Optional(Type.Array(NonEmptyString)),
	inactiveRefPaths: Type.Optional(Type.Array(NonEmptyString))
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/sessions.ts
const SessionCompactionCheckpointReasonSchema = Type.Union([
	Type.Literal("manual"),
	Type.Literal("auto-threshold"),
	Type.Literal("overflow-retry"),
	Type.Literal("timeout-retry")
]);
const SessionOperationEventSchema = Type.Object({
	operationId: NonEmptyString,
	operation: Type.Literal("compact"),
	phase: Type.Union([Type.Literal("start"), Type.Literal("end")]),
	sessionKey: NonEmptyString,
	ts: Type.Integer({ minimum: 0 }),
	completed: Type.Optional(Type.Boolean()),
	reason: Type.Optional(Type.String())
}, { additionalProperties: false });
const SessionCompactionTranscriptReferenceSchema = Type.Object({
	sessionId: NonEmptyString,
	sessionFile: Type.Optional(NonEmptyString),
	leafId: Type.Optional(NonEmptyString),
	entryId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const SessionCompactionCheckpointSchema = Type.Object({
	checkpointId: NonEmptyString,
	sessionKey: NonEmptyString,
	sessionId: NonEmptyString,
	createdAt: Type.Integer({ minimum: 0 }),
	reason: SessionCompactionCheckpointReasonSchema,
	tokensBefore: Type.Optional(Type.Integer({ minimum: 0 })),
	tokensAfter: Type.Optional(Type.Integer({ minimum: 0 })),
	summary: Type.Optional(Type.String()),
	firstKeptEntryId: Type.Optional(NonEmptyString),
	preCompaction: SessionCompactionTranscriptReferenceSchema,
	postCompaction: SessionCompactionTranscriptReferenceSchema
}, { additionalProperties: false });
const SessionsListParamsSchema = Type.Object({
	/**
	* Maximum rows to return. Omitted Gateway RPC calls use a bounded default
	* to keep large session stores from monopolizing the event loop.
	*/
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	offset: Type.Optional(Type.Integer({ minimum: 0 })),
	activeMinutes: Type.Optional(Type.Integer({ minimum: 1 })),
	includeGlobal: Type.Optional(Type.Boolean()),
	includeUnknown: Type.Optional(Type.Boolean()),
	/**
	* Limit returned agent-scoped rows to agents currently present in config.
	* Broad disk discovery remains the default for recovery/ACP consumers.
	*/
	configuredAgentsOnly: Type.Optional(Type.Boolean()),
	/**
	* Read first 8KB of each session transcript to derive title from first user message.
	* Performs a file read per session - use `limit` to bound result set on large stores.
	*/
	includeDerivedTitles: Type.Optional(Type.Boolean()),
	/**
	* Read last 16KB of each session transcript to extract most recent message preview.
	* Performs a file read per session - use `limit` to bound result set on large stores.
	*/
	includeLastMessage: Type.Optional(Type.Boolean()),
	label: Type.Optional(SessionLabelString),
	spawnedBy: Type.Optional(NonEmptyString),
	agentId: Type.Optional(NonEmptyString),
	search: Type.Optional(Type.String())
}, { additionalProperties: false });
const SessionsCleanupParamsSchema = Type.Object({
	agent: Type.Optional(NonEmptyString),
	allAgents: Type.Optional(Type.Boolean()),
	enforce: Type.Optional(Type.Boolean()),
	activeKey: Type.Optional(NonEmptyString),
	fixMissing: Type.Optional(Type.Boolean()),
	fixDmScope: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsPreviewParamsSchema = Type.Object({
	keys: Type.Array(NonEmptyString, { minItems: 1 }),
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	maxChars: Type.Optional(Type.Integer({ minimum: 20 }))
}, { additionalProperties: false });
const SessionsDescribeParamsSchema = Type.Object({
	key: NonEmptyString,
	includeDerivedTitles: Type.Optional(Type.Boolean()),
	includeLastMessage: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsResolveParamsSchema = Type.Object({
	key: Type.Optional(NonEmptyString),
	sessionId: Type.Optional(NonEmptyString),
	label: Type.Optional(SessionLabelString),
	agentId: Type.Optional(NonEmptyString),
	spawnedBy: Type.Optional(NonEmptyString),
	includeGlobal: Type.Optional(Type.Boolean()),
	includeUnknown: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsCreateParamsSchema = Type.Object({
	key: Type.Optional(NonEmptyString),
	agentId: Type.Optional(NonEmptyString),
	label: Type.Optional(SessionLabelString),
	model: Type.Optional(NonEmptyString),
	parentSessionKey: Type.Optional(NonEmptyString),
	emitCommandHooks: Type.Optional(Type.Boolean()),
	task: Type.Optional(Type.String()),
	message: Type.Optional(Type.String())
}, { additionalProperties: false });
const SessionsSendParamsSchema = Type.Object({
	key: NonEmptyString,
	message: Type.String(),
	thinking: Type.Optional(Type.String()),
	attachments: Type.Optional(Type.Array(Type.Unknown())),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 0 })),
	idempotencyKey: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const SessionsMessagesSubscribeParamsSchema = Type.Object({ key: NonEmptyString }, { additionalProperties: false });
const SessionsMessagesUnsubscribeParamsSchema = Type.Object({ key: NonEmptyString }, { additionalProperties: false });
const SessionsAbortParamsSchema = Type.Object({
	key: Type.Optional(NonEmptyString),
	runId: Type.Optional(NonEmptyString),
	agentId: Type.Optional(NonEmptyString)
}, { additionalProperties: false });
const SessionsPatchParamsSchema = Type.Object({
	key: NonEmptyString,
	label: Type.Optional(Type.Union([SessionLabelString, Type.Null()])),
	thinkingLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	fastMode: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
	verboseLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	traceLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	reasoningLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	responseUsage: Type.Optional(Type.Union([
		Type.Literal("off"),
		Type.Literal("tokens"),
		Type.Literal("full"),
		Type.Literal("on"),
		Type.Null()
	])),
	elevatedLevel: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execHost: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execSecurity: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execAsk: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	execNode: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	spawnedBy: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	spawnedWorkspaceDir: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
	spawnDepth: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
	subagentRole: Type.Optional(Type.Union([
		Type.Literal("orchestrator"),
		Type.Literal("leaf"),
		Type.Null()
	])),
	subagentControlScope: Type.Optional(Type.Union([
		Type.Literal("children"),
		Type.Literal("none"),
		Type.Null()
	])),
	inheritedToolAllow: Type.Optional(Type.Union([Type.Array(NonEmptyString), Type.Null()])),
	inheritedToolDeny: Type.Optional(Type.Union([Type.Array(NonEmptyString), Type.Null()])),
	sendPolicy: Type.Optional(Type.Union([
		Type.Literal("allow"),
		Type.Literal("deny"),
		Type.Null()
	])),
	groupActivation: Type.Optional(Type.Union([
		Type.Literal("mention"),
		Type.Literal("always"),
		Type.Null()
	]))
}, { additionalProperties: false });
const SessionsPluginPatchParamsSchema = Type.Object({
	key: NonEmptyString,
	pluginId: NonEmptyString,
	namespace: NonEmptyString,
	value: Type.Optional(PluginJsonValueSchema),
	unset: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsPluginPatchResultSchema = Type.Object({
	ok: Type.Literal(true),
	key: NonEmptyString,
	value: Type.Optional(PluginJsonValueSchema)
}, { additionalProperties: false });
const SessionsResetParamsSchema = Type.Object({
	key: NonEmptyString,
	reason: Type.Optional(Type.Union([Type.Literal("new"), Type.Literal("reset")]))
}, { additionalProperties: false });
const SessionsDeleteParamsSchema = Type.Object({
	key: NonEmptyString,
	deleteTranscript: Type.Optional(Type.Boolean()),
	emitLifecycleHooks: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
const SessionsCompactParamsSchema = Type.Object({
	key: NonEmptyString,
	maxLines: Type.Optional(Type.Integer({ minimum: 1 }))
}, { additionalProperties: false });
const SessionsCompactionListParamsSchema = Type.Object({ key: NonEmptyString }, { additionalProperties: false });
const SessionsCompactionGetParamsSchema = Type.Object({
	key: NonEmptyString,
	checkpointId: NonEmptyString
}, { additionalProperties: false });
const SessionsCompactionBranchParamsSchema = Type.Object({
	key: NonEmptyString,
	checkpointId: NonEmptyString
}, { additionalProperties: false });
const SessionsCompactionRestoreParamsSchema = Type.Object({
	key: NonEmptyString,
	checkpointId: NonEmptyString
}, { additionalProperties: false });
const SessionsCompactionListResultSchema = Type.Object({
	ok: Type.Literal(true),
	key: NonEmptyString,
	checkpoints: Type.Array(SessionCompactionCheckpointSchema)
}, { additionalProperties: false });
const SessionsCompactionGetResultSchema = Type.Object({
	ok: Type.Literal(true),
	key: NonEmptyString,
	checkpoint: SessionCompactionCheckpointSchema
}, { additionalProperties: false });
const SessionsCompactionBranchResultSchema = Type.Object({
	ok: Type.Literal(true),
	sourceKey: NonEmptyString,
	key: NonEmptyString,
	sessionId: NonEmptyString,
	checkpoint: SessionCompactionCheckpointSchema,
	entry: Type.Object({
		sessionId: NonEmptyString,
		updatedAt: Type.Integer({ minimum: 0 })
	}, { additionalProperties: true })
}, { additionalProperties: false });
const SessionsCompactionRestoreResultSchema = Type.Object({
	ok: Type.Literal(true),
	key: NonEmptyString,
	sessionId: NonEmptyString,
	checkpoint: SessionCompactionCheckpointSchema,
	entry: Type.Object({
		sessionId: NonEmptyString,
		updatedAt: Type.Integer({ minimum: 0 })
	}, { additionalProperties: true })
}, { additionalProperties: false });
const SessionsUsageParamsSchema = Type.Object({
	/** Specific session key to analyze; if omitted returns sessions for the effective agent. */
	key: Type.Optional(NonEmptyString),
	/** Agent scope for list-style usage queries. */
	agentId: Type.Optional(NonEmptyString),
	/** Start date for range filter (YYYY-MM-DD). */
	startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	/** End date for range filter (YYYY-MM-DD). */
	endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
	/** How start/end dates should be interpreted. Defaults to UTC when omitted. */
	mode: Type.Optional(Type.Union([
		Type.Literal("utc"),
		Type.Literal("gateway"),
		Type.Literal("specific")
	])),
	/** Preset range for usage queries when explicit start/end dates are omitted. */
	range: Type.Optional(Type.Union([
		Type.Literal("7d"),
		Type.Literal("30d"),
		Type.Literal("90d"),
		Type.Literal("1y"),
		Type.Literal("all")
	])),
	/** Usage row grouping. `family` rolls up known rotated session ids for a logical key. */
	groupBy: Type.Optional(Type.Union([Type.Literal("instance"), Type.Literal("family")])),
	/** Backward-compatible alias for requesting family grouping. */
	includeHistorical: Type.Optional(Type.Boolean()),
	/** UTC offset to use when mode is `specific` (for example, UTC-4 or UTC+5:30). */
	utcOffset: Type.Optional(Type.String({ pattern: "^UTC[+-]\\d{1,2}(?::[0-5]\\d)?$" })),
	/** Maximum sessions to return (default 50). */
	limit: Type.Optional(Type.Integer({ minimum: 1 })),
	/** Include context weight breakdown (systemPromptReport). */
	includeContextWeight: Type.Optional(Type.Boolean())
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/tasks.ts
const TaskLedgerStatusSchema = Type.Union([
	Type.Literal("queued"),
	Type.Literal("running"),
	Type.Literal("completed"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("timed_out")
]);
const TimestampSchema = Type.Union([Type.String(), Type.Integer({ minimum: 0 })]);
const TaskSummarySchema = Type.Object({
	id: NonEmptyString,
	kind: Type.Optional(Type.String()),
	runtime: Type.Optional(Type.String()),
	status: TaskLedgerStatusSchema,
	title: Type.Optional(Type.String()),
	agentId: Type.Optional(Type.String()),
	sessionKey: Type.Optional(Type.String()),
	childSessionKey: Type.Optional(Type.String()),
	ownerKey: Type.Optional(Type.String()),
	runId: Type.Optional(Type.String()),
	taskId: Type.Optional(Type.String()),
	flowId: Type.Optional(Type.String()),
	parentTaskId: Type.Optional(Type.String()),
	sourceId: Type.Optional(Type.String()),
	createdAt: Type.Optional(TimestampSchema),
	updatedAt: Type.Optional(TimestampSchema),
	startedAt: Type.Optional(TimestampSchema),
	endedAt: Type.Optional(TimestampSchema),
	progressSummary: Type.Optional(Type.String()),
	terminalSummary: Type.Optional(Type.String()),
	error: Type.Optional(Type.String())
}, { additionalProperties: false });
const TasksListParamsSchema = Type.Object({
	status: Type.Optional(Type.Union([TaskLedgerStatusSchema, Type.Array(TaskLedgerStatusSchema)])),
	agentId: Type.Optional(NonEmptyString),
	sessionKey: Type.Optional(NonEmptyString),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 500
	})),
	cursor: Type.Optional(Type.String())
}, { additionalProperties: false });
const TasksListResultSchema = Type.Object({
	tasks: Type.Array(TaskSummarySchema),
	nextCursor: Type.Optional(Type.String())
}, { additionalProperties: false });
const TasksGetParamsSchema = Type.Object({ taskId: NonEmptyString }, { additionalProperties: false });
const TasksGetResultSchema = Type.Object({ task: TaskSummarySchema }, { additionalProperties: false });
const TasksCancelParamsSchema = Type.Object({
	taskId: NonEmptyString,
	reason: Type.Optional(Type.String())
}, { additionalProperties: false });
const TasksCancelResultSchema = Type.Object({
	found: Type.Boolean(),
	cancelled: Type.Boolean(),
	reason: Type.Optional(Type.String()),
	task: Type.Optional(TaskSummarySchema)
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/wizard.ts
const WizardRunStatusSchema = Type.Union([
	Type.Literal("running"),
	Type.Literal("done"),
	Type.Literal("cancelled"),
	Type.Literal("error")
]);
const WizardStartParamsSchema = Type.Object({
	mode: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
	workspace: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardAnswerSchema = Type.Object({
	stepId: NonEmptyString,
	value: Type.Optional(Type.Unknown())
}, { additionalProperties: false });
const WizardNextParamsSchema = Type.Object({
	sessionId: NonEmptyString,
	answer: Type.Optional(WizardAnswerSchema)
}, { additionalProperties: false });
const WizardSessionIdParamsSchema = Type.Object({ sessionId: NonEmptyString }, { additionalProperties: false });
const WizardCancelParamsSchema = WizardSessionIdParamsSchema;
const WizardStatusParamsSchema = WizardSessionIdParamsSchema;
const WizardStepOptionSchema = Type.Object({
	value: Type.Unknown(),
	label: NonEmptyString,
	hint: Type.Optional(Type.String())
}, { additionalProperties: false });
const WizardStepSchema = Type.Object({
	id: NonEmptyString,
	type: Type.Union([
		Type.Literal("note"),
		Type.Literal("select"),
		Type.Literal("text"),
		Type.Literal("confirm"),
		Type.Literal("multiselect"),
		Type.Literal("progress"),
		Type.Literal("action")
	]),
	title: Type.Optional(Type.String()),
	message: Type.Optional(Type.String()),
	format: Type.Optional(Type.Union([Type.Literal("plain")])),
	options: Type.Optional(Type.Array(WizardStepOptionSchema)),
	initialValue: Type.Optional(Type.Unknown()),
	placeholder: Type.Optional(Type.String()),
	sensitive: Type.Optional(Type.Boolean()),
	executor: Type.Optional(Type.Union([Type.Literal("gateway"), Type.Literal("client")]))
}, { additionalProperties: false });
const WizardResultFields = {
	done: Type.Boolean(),
	step: Type.Optional(WizardStepSchema),
	status: Type.Optional(WizardRunStatusSchema),
	error: Type.Optional(Type.String())
};
const WizardNextResultSchema = Type.Object(WizardResultFields, { additionalProperties: false });
const WizardStartResultSchema = Type.Object({
	sessionId: NonEmptyString,
	...WizardResultFields
}, { additionalProperties: false });
const WizardStatusResultSchema = Type.Object({
	status: WizardRunStatusSchema,
	error: Type.Optional(Type.String())
}, { additionalProperties: false });
//#endregion
//#region src/gateway/protocol/schema/protocol-schemas.ts
const ProtocolSchemas = {
	ConnectParams: ConnectParamsSchema,
	HelloOk: HelloOkSchema,
	RequestFrame: RequestFrameSchema,
	ResponseFrame: ResponseFrameSchema,
	EventFrame: EventFrameSchema,
	GatewayFrame: GatewayFrameSchema,
	PresenceEntry: PresenceEntrySchema,
	StateVersion: StateVersionSchema,
	Snapshot: SnapshotSchema,
	ErrorShape: ErrorShapeSchema,
	EnvironmentStatus: EnvironmentStatusSchema,
	EnvironmentSummary: EnvironmentSummarySchema,
	EnvironmentsListParams: EnvironmentsListParamsSchema,
	EnvironmentsListResult: EnvironmentsListResultSchema,
	EnvironmentsStatusParams: EnvironmentsStatusParamsSchema,
	EnvironmentsStatusResult: EnvironmentsStatusResultSchema,
	AgentEvent: AgentEventSchema,
	MessageActionParams: MessageActionParamsSchema,
	SendParams: SendParamsSchema,
	PollParams: PollParamsSchema,
	AgentParams: AgentParamsSchema,
	AgentIdentityParams: AgentIdentityParamsSchema,
	AgentIdentityResult: AgentIdentityResultSchema,
	AgentWaitParams: AgentWaitParamsSchema,
	WakeParams: WakeParamsSchema,
	NodePairRequestParams: NodePairRequestParamsSchema,
	NodePairListParams: NodePairListParamsSchema,
	NodePairApproveParams: NodePairApproveParamsSchema,
	NodePairRejectParams: NodePairRejectParamsSchema,
	NodePairRemoveParams: NodePairRemoveParamsSchema,
	NodePairVerifyParams: NodePairVerifyParamsSchema,
	NodeRenameParams: NodeRenameParamsSchema,
	NodeListParams: NodeListParamsSchema,
	NodePendingAckParams: NodePendingAckParamsSchema,
	NodeDescribeParams: NodeDescribeParamsSchema,
	NodeInvokeParams: NodeInvokeParamsSchema,
	NodeInvokeResultParams: NodeInvokeResultParamsSchema,
	NodeEventParams: NodeEventParamsSchema,
	NodeEventResult: NodeEventResultSchema,
	NodePresenceAlivePayload: NodePresenceAlivePayloadSchema,
	NodePresenceAliveReason: NodePresenceAliveReasonSchema,
	NodePendingDrainParams: NodePendingDrainParamsSchema,
	NodePendingDrainResult: NodePendingDrainResultSchema,
	NodePendingEnqueueParams: NodePendingEnqueueParamsSchema,
	NodePendingEnqueueResult: NodePendingEnqueueResultSchema,
	NodeInvokeRequestEvent: NodeInvokeRequestEventSchema,
	PushTestParams: PushTestParamsSchema,
	PushTestResult: PushTestResultSchema,
	SecretsReloadParams: SecretsReloadParamsSchema,
	SecretsResolveParams: SecretsResolveParamsSchema,
	SecretsResolveAssignment: SecretsResolveAssignmentSchema,
	SecretsResolveResult: SecretsResolveResultSchema,
	SessionsListParams: SessionsListParamsSchema,
	SessionsCleanupParams: SessionsCleanupParamsSchema,
	SessionsPreviewParams: SessionsPreviewParamsSchema,
	SessionsDescribeParams: SessionsDescribeParamsSchema,
	SessionsResolveParams: SessionsResolveParamsSchema,
	SessionCompactionCheckpoint: SessionCompactionCheckpointSchema,
	SessionOperationEvent: SessionOperationEventSchema,
	SessionsCompactionListParams: SessionsCompactionListParamsSchema,
	SessionsCompactionGetParams: SessionsCompactionGetParamsSchema,
	SessionsCompactionBranchParams: SessionsCompactionBranchParamsSchema,
	SessionsCompactionRestoreParams: SessionsCompactionRestoreParamsSchema,
	SessionsCompactionListResult: SessionsCompactionListResultSchema,
	SessionsCompactionGetResult: SessionsCompactionGetResultSchema,
	SessionsCompactionBranchResult: SessionsCompactionBranchResultSchema,
	SessionsCompactionRestoreResult: SessionsCompactionRestoreResultSchema,
	SessionsCreateParams: SessionsCreateParamsSchema,
	SessionsSendParams: SessionsSendParamsSchema,
	SessionsMessagesSubscribeParams: SessionsMessagesSubscribeParamsSchema,
	SessionsMessagesUnsubscribeParams: SessionsMessagesUnsubscribeParamsSchema,
	SessionsAbortParams: SessionsAbortParamsSchema,
	SessionsPatchParams: SessionsPatchParamsSchema,
	SessionsPluginPatchParams: SessionsPluginPatchParamsSchema,
	SessionsPluginPatchResult: SessionsPluginPatchResultSchema,
	SessionsResetParams: SessionsResetParamsSchema,
	SessionsDeleteParams: SessionsDeleteParamsSchema,
	SessionsCompactParams: SessionsCompactParamsSchema,
	SessionsUsageParams: SessionsUsageParamsSchema,
	TaskSummary: TaskSummarySchema,
	TasksListParams: TasksListParamsSchema,
	TasksListResult: TasksListResultSchema,
	TasksGetParams: TasksGetParamsSchema,
	TasksGetResult: TasksGetResultSchema,
	TasksCancelParams: TasksCancelParamsSchema,
	TasksCancelResult: TasksCancelResultSchema,
	ConfigGetParams: ConfigGetParamsSchema,
	ConfigSetParams: ConfigSetParamsSchema,
	ConfigApplyParams: ConfigApplyParamsSchema,
	ConfigPatchParams: ConfigPatchParamsSchema,
	ConfigSchemaParams: ConfigSchemaParamsSchema,
	ConfigSchemaLookupParams: ConfigSchemaLookupParamsSchema,
	ConfigSchemaResponse: ConfigSchemaResponseSchema,
	ConfigSchemaLookupResult: ConfigSchemaLookupResultSchema,
	WizardStartParams: WizardStartParamsSchema,
	WizardNextParams: WizardNextParamsSchema,
	WizardCancelParams: WizardCancelParamsSchema,
	WizardStatusParams: WizardStatusParamsSchema,
	WizardStep: WizardStepSchema,
	WizardNextResult: WizardNextResultSchema,
	WizardStartResult: WizardStartResultSchema,
	WizardStatusResult: WizardStatusResultSchema,
	TalkModeParams: TalkModeParamsSchema,
	TalkEvent: TalkEventSchema,
	TalkCatalogParams: TalkCatalogParamsSchema,
	TalkCatalogResult: TalkCatalogResultSchema,
	TalkClientCreateParams: TalkClientCreateParamsSchema,
	TalkClientCreateResult: TalkClientCreateResultSchema,
	TalkClientToolCallParams: TalkClientToolCallParamsSchema,
	TalkClientToolCallResult: TalkClientToolCallResultSchema,
	TalkConfigParams: TalkConfigParamsSchema,
	TalkConfigResult: TalkConfigResultSchema,
	TalkSessionAppendAudioParams: TalkSessionAppendAudioParamsSchema,
	TalkSessionCancelOutputParams: TalkSessionCancelOutputParamsSchema,
	TalkSessionCancelTurnParams: TalkSessionCancelTurnParamsSchema,
	TalkSessionCreateParams: TalkSessionCreateParamsSchema,
	TalkSessionCreateResult: TalkSessionCreateResultSchema,
	TalkSessionJoinParams: TalkSessionJoinParamsSchema,
	TalkSessionJoinResult: TalkSessionJoinResultSchema,
	TalkSessionTurnParams: TalkSessionTurnParamsSchema,
	TalkSessionTurnResult: TalkSessionTurnResultSchema,
	TalkSessionSubmitToolResultParams: TalkSessionSubmitToolResultParamsSchema,
	TalkSessionCloseParams: TalkSessionCloseParamsSchema,
	TalkSessionOkResult: TalkSessionOkResultSchema,
	TalkSpeakParams: TalkSpeakParamsSchema,
	TalkSpeakResult: TalkSpeakResultSchema,
	ChannelsStatusParams: ChannelsStatusParamsSchema,
	ChannelsStatusResult: ChannelsStatusResultSchema,
	ChannelsStartParams: ChannelsStartParamsSchema,
	ChannelsStopParams: ChannelsStopParamsSchema,
	ChannelsLogoutParams: ChannelsLogoutParamsSchema,
	WebLoginStartParams: WebLoginStartParamsSchema,
	WebLoginWaitParams: WebLoginWaitParamsSchema,
	AgentSummary: AgentSummarySchema,
	AgentsCreateParams: AgentsCreateParamsSchema,
	AgentsCreateResult: AgentsCreateResultSchema,
	AgentsUpdateParams: AgentsUpdateParamsSchema,
	AgentsUpdateResult: AgentsUpdateResultSchema,
	AgentsDeleteParams: AgentsDeleteParamsSchema,
	AgentsDeleteResult: AgentsDeleteResultSchema,
	AgentsFileEntry: AgentsFileEntrySchema,
	AgentsFilesListParams: AgentsFilesListParamsSchema,
	AgentsFilesListResult: AgentsFilesListResultSchema,
	AgentsFilesGetParams: AgentsFilesGetParamsSchema,
	AgentsFilesGetResult: AgentsFilesGetResultSchema,
	AgentsFilesSetParams: AgentsFilesSetParamsSchema,
	AgentsFilesSetResult: AgentsFilesSetResultSchema,
	ArtifactSummary: ArtifactSummarySchema,
	ArtifactsListParams: ArtifactsListParamsSchema,
	ArtifactsListResult: ArtifactsListResultSchema,
	ArtifactsGetParams: ArtifactsGetParamsSchema,
	ArtifactsGetResult: ArtifactsGetResultSchema,
	ArtifactsDownloadParams: ArtifactsDownloadParamsSchema,
	ArtifactsDownloadResult: ArtifactsDownloadResultSchema,
	AgentsListParams: AgentsListParamsSchema,
	AgentsListResult: AgentsListResultSchema,
	ModelChoice: ModelChoiceSchema,
	ModelsListParams: ModelsListParamsSchema,
	ModelsListResult: ModelsListResultSchema,
	CommandEntry: CommandEntrySchema,
	CommandsListParams: CommandsListParamsSchema,
	CommandsListResult: CommandsListResultSchema,
	SkillsStatusParams: SkillsStatusParamsSchema,
	ToolsCatalogParams: ToolsCatalogParamsSchema,
	ToolCatalogProfile: ToolCatalogProfileSchema,
	ToolCatalogEntry: ToolCatalogEntrySchema,
	ToolCatalogGroup: ToolCatalogGroupSchema,
	ToolsCatalogResult: ToolsCatalogResultSchema,
	ToolsEffectiveParams: ToolsEffectiveParamsSchema,
	ToolsEffectiveEntry: ToolsEffectiveEntrySchema,
	ToolsEffectiveGroup: ToolsEffectiveGroupSchema,
	ToolsEffectiveResult: ToolsEffectiveResultSchema,
	ToolsInvokeParams: ToolsInvokeParamsSchema,
	ToolsInvokeError: ToolsInvokeErrorSchema,
	ToolsInvokeResult: ToolsInvokeResultSchema,
	SkillsBinsParams: SkillsBinsParamsSchema,
	SkillsBinsResult: SkillsBinsResultSchema,
	SkillsSearchParams: SkillsSearchParamsSchema,
	SkillsSearchResult: SkillsSearchResultSchema,
	SkillsDetailParams: SkillsDetailParamsSchema,
	SkillsDetailResult: SkillsDetailResultSchema,
	SkillsUploadBeginParams: SkillsUploadBeginParamsSchema,
	SkillsUploadChunkParams: SkillsUploadChunkParamsSchema,
	SkillsUploadCommitParams: SkillsUploadCommitParamsSchema,
	SkillsInstallParams: SkillsInstallParamsSchema,
	SkillsUpdateParams: SkillsUpdateParamsSchema,
	CronJob: CronJobSchema,
	CronListParams: CronListParamsSchema,
	CronStatusParams: CronStatusParamsSchema,
	CronGetParams: CronGetParamsSchema,
	CronAddParams: CronAddParamsSchema,
	CronUpdateParams: CronUpdateParamsSchema,
	CronRemoveParams: CronRemoveParamsSchema,
	CronRunParams: CronRunParamsSchema,
	CronRunsParams: CronRunsParamsSchema,
	CronRunLogEntry: CronRunLogEntrySchema,
	LogsTailParams: LogsTailParamsSchema,
	LogsTailResult: LogsTailResultSchema,
	ExecApprovalsGetParams: ExecApprovalsGetParamsSchema,
	ExecApprovalsSetParams: ExecApprovalsSetParamsSchema,
	ExecApprovalsNodeGetParams: ExecApprovalsNodeGetParamsSchema,
	ExecApprovalsNodeSetParams: ExecApprovalsNodeSetParamsSchema,
	ExecApprovalsSnapshot: ExecApprovalsSnapshotSchema,
	ExecApprovalGetParams: ExecApprovalGetParamsSchema,
	ExecApprovalRequestParams: ExecApprovalRequestParamsSchema,
	ExecApprovalResolveParams: ExecApprovalResolveParamsSchema,
	PluginApprovalRequestParams: PluginApprovalRequestParamsSchema,
	PluginApprovalResolveParams: PluginApprovalResolveParamsSchema,
	PluginControlUiDescriptor: PluginControlUiDescriptorSchema,
	PluginsSessionActionFailureResult: PluginsSessionActionFailureResultSchema,
	PluginsSessionActionParams: PluginsSessionActionParamsSchema,
	PluginsSessionActionResult: PluginsSessionActionResultSchema,
	PluginsSessionActionSuccessResult: PluginsSessionActionSuccessResultSchema,
	PluginsUiDescriptorsParams: PluginsUiDescriptorsParamsSchema,
	PluginsUiDescriptorsResult: PluginsUiDescriptorsResultSchema,
	DevicePairListParams: DevicePairListParamsSchema,
	DevicePairApproveParams: DevicePairApproveParamsSchema,
	DevicePairRejectParams: DevicePairRejectParamsSchema,
	DevicePairRemoveParams: DevicePairRemoveParamsSchema,
	DeviceTokenRotateParams: DeviceTokenRotateParamsSchema,
	DeviceTokenRevokeParams: DeviceTokenRevokeParamsSchema,
	DevicePairRequestedEvent: DevicePairRequestedEventSchema,
	DevicePairResolvedEvent: DevicePairResolvedEventSchema,
	ChatHistoryParams: ChatHistoryParamsSchema,
	ChatSendParams: ChatSendParamsSchema,
	ChatAbortParams: ChatAbortParamsSchema,
	ChatInjectParams: ChatInjectParamsSchema,
	ChatDeltaEvent: ChatDeltaEventSchema,
	ChatFinalEvent: ChatFinalEventSchema,
	ChatAbortedEvent: ChatAbortedEventSchema,
	ChatErrorEvent: ChatErrorEventSchema,
	ChatEvent: ChatEventSchema,
	UpdateStatusParams: UpdateStatusParamsSchema,
	UpdateRunParams: UpdateRunParamsSchema,
	TickEvent: TickEventSchema,
	ShutdownEvent: ShutdownEventSchema
};
//#endregion
//#region src/gateway/protocol/index.ts
const AjvCtor = AjvPkg;
let ajv;
function getAjv() {
	ajv ??= new AjvCtor({
		allErrors: true,
		strict: false,
		removeAdditional: false
	});
	return ajv;
}
function lazyCompile(schema) {
	let compiled;
	const getCompiled = () => {
		compiled ??= getAjv().compile(schema);
		return compiled;
	};
	const validate = ((data, dataCxt) => {
		const current = getCompiled();
		const valid = current(data, dataCxt);
		validate.errors = current.errors;
		validate.evaluated = current.evaluated;
		return valid;
	});
	Object.defineProperties(validate, {
		errors: {
			configurable: true,
			enumerable: true,
			get: () => compiled?.errors ?? null,
			set: (errors) => {
				if (compiled) compiled.errors = errors ?? null;
			}
		},
		evaluated: {
			configurable: true,
			enumerable: true,
			get: () => compiled?.evaluated,
			set: (evaluated) => {
				if (compiled) compiled.evaluated = evaluated;
			}
		},
		schema: {
			configurable: true,
			enumerable: true,
			get: () => compiled?.schema ?? schema
		},
		schemaEnv: {
			configurable: true,
			enumerable: true,
			get: () => getCompiled().schemaEnv
		},
		source: {
			configurable: true,
			enumerable: true,
			get: () => compiled?.source
		}
	});
	return validate;
}
const validateCommandsListParams = lazyCompile(CommandsListParamsSchema);
const validateConnectParams = lazyCompile(ConnectParamsSchema);
const validateRequestFrame = lazyCompile(RequestFrameSchema);
const validateResponseFrame = lazyCompile(ResponseFrameSchema);
const validateEventFrame = lazyCompile(EventFrameSchema);
const validateMessageActionParams = lazyCompile(MessageActionParamsSchema);
const validateSendParams = lazyCompile(SendParamsSchema);
const validatePollParams = lazyCompile(PollParamsSchema);
const validateAgentParams = lazyCompile(AgentParamsSchema);
const validateAgentIdentityParams = lazyCompile(AgentIdentityParamsSchema);
const validateAgentWaitParams = lazyCompile(AgentWaitParamsSchema);
const validateWakeParams = lazyCompile(WakeParamsSchema);
const validateAgentsListParams = lazyCompile(AgentsListParamsSchema);
const validateAgentsCreateParams = lazyCompile(AgentsCreateParamsSchema);
const validateAgentsUpdateParams = lazyCompile(AgentsUpdateParamsSchema);
const validateAgentsDeleteParams = lazyCompile(AgentsDeleteParamsSchema);
const validateAgentsFilesListParams = lazyCompile(AgentsFilesListParamsSchema);
const validateAgentsFilesGetParams = lazyCompile(AgentsFilesGetParamsSchema);
const validateAgentsFilesSetParams = lazyCompile(AgentsFilesSetParamsSchema);
const validateArtifactsListParams = lazyCompile(ArtifactsListParamsSchema);
const validateArtifactsGetParams = lazyCompile(ArtifactsGetParamsSchema);
const validateArtifactsDownloadParams = lazyCompile(ArtifactsDownloadParamsSchema);
const validateNodePairRequestParams = lazyCompile(NodePairRequestParamsSchema);
const validateNodePairListParams = lazyCompile(NodePairListParamsSchema);
const validateNodePairApproveParams = lazyCompile(NodePairApproveParamsSchema);
const validateNodePairRejectParams = lazyCompile(NodePairRejectParamsSchema);
const validateNodePairRemoveParams = lazyCompile(NodePairRemoveParamsSchema);
const validateNodePairVerifyParams = lazyCompile(NodePairVerifyParamsSchema);
const validateNodeRenameParams = lazyCompile(NodeRenameParamsSchema);
const validateNodeListParams = lazyCompile(NodeListParamsSchema);
const validateEnvironmentsListParams = lazyCompile(EnvironmentsListParamsSchema);
const validateEnvironmentsStatusParams = lazyCompile(EnvironmentsStatusParamsSchema);
const validateNodePendingAckParams = lazyCompile(NodePendingAckParamsSchema);
const validateNodeDescribeParams = lazyCompile(NodeDescribeParamsSchema);
const validateNodeInvokeParams = lazyCompile(NodeInvokeParamsSchema);
const validateNodeInvokeResultParams = lazyCompile(NodeInvokeResultParamsSchema);
const validateNodeEventParams = lazyCompile(NodeEventParamsSchema);
const validateNodeEventResult = lazyCompile(NodeEventResultSchema);
const validateNodePresenceAlivePayload = lazyCompile(NodePresenceAlivePayloadSchema);
const validateNodePendingDrainParams = lazyCompile(NodePendingDrainParamsSchema);
const validateNodePendingEnqueueParams = lazyCompile(NodePendingEnqueueParamsSchema);
const validatePushTestParams = lazyCompile(PushTestParamsSchema);
const validateWebPushVapidPublicKeyParams = lazyCompile(WebPushVapidPublicKeyParamsSchema);
const validateWebPushSubscribeParams = lazyCompile(WebPushSubscribeParamsSchema);
const validateWebPushUnsubscribeParams = lazyCompile(WebPushUnsubscribeParamsSchema);
const validateWebPushTestParams = lazyCompile(WebPushTestParamsSchema);
const validateSecretsResolveParams = lazyCompile(SecretsResolveParamsSchema);
const validateSecretsResolveResult = lazyCompile(SecretsResolveResultSchema);
const validateSessionsListParams = lazyCompile(SessionsListParamsSchema);
const validateSessionsCleanupParams = lazyCompile(SessionsCleanupParamsSchema);
const validateSessionsPreviewParams = lazyCompile(SessionsPreviewParamsSchema);
const validateSessionsDescribeParams = lazyCompile(SessionsDescribeParamsSchema);
const validateSessionsResolveParams = lazyCompile(SessionsResolveParamsSchema);
const validateSessionsCreateParams = lazyCompile(SessionsCreateParamsSchema);
const validateSessionsSendParams = lazyCompile(SessionsSendParamsSchema);
const validateSessionsMessagesSubscribeParams = lazyCompile(SessionsMessagesSubscribeParamsSchema);
const validateSessionsMessagesUnsubscribeParams = lazyCompile(SessionsMessagesUnsubscribeParamsSchema);
const validateSessionsAbortParams = lazyCompile(SessionsAbortParamsSchema);
const validateSessionsPatchParams = lazyCompile(SessionsPatchParamsSchema);
const validateSessionsPluginPatchParams = lazyCompile(SessionsPluginPatchParamsSchema);
const validateSessionsResetParams = lazyCompile(SessionsResetParamsSchema);
const validateSessionsDeleteParams = lazyCompile(SessionsDeleteParamsSchema);
const validateSessionsCompactParams = lazyCompile(SessionsCompactParamsSchema);
const validateSessionsCompactionListParams = lazyCompile(SessionsCompactionListParamsSchema);
const validateSessionsCompactionGetParams = lazyCompile(SessionsCompactionGetParamsSchema);
const validateSessionsCompactionBranchParams = lazyCompile(SessionsCompactionBranchParamsSchema);
const validateSessionsCompactionRestoreParams = lazyCompile(SessionsCompactionRestoreParamsSchema);
const validateSessionsUsageParams = lazyCompile(SessionsUsageParamsSchema);
const validateTasksListParams = lazyCompile(TasksListParamsSchema);
const validateTasksGetParams = lazyCompile(TasksGetParamsSchema);
const validateTasksCancelParams = lazyCompile(TasksCancelParamsSchema);
const validateConfigGetParams = lazyCompile(ConfigGetParamsSchema);
const validateConfigSetParams = lazyCompile(ConfigSetParamsSchema);
const validateConfigApplyParams = lazyCompile(ConfigApplyParamsSchema);
const validateConfigPatchParams = lazyCompile(ConfigPatchParamsSchema);
const validateConfigSchemaParams = lazyCompile(ConfigSchemaParamsSchema);
const validateConfigSchemaLookupParams = lazyCompile(ConfigSchemaLookupParamsSchema);
const validateConfigSchemaLookupResult = lazyCompile(ConfigSchemaLookupResultSchema);
const validateWizardStartParams = lazyCompile(WizardStartParamsSchema);
const validateWizardNextParams = lazyCompile(WizardNextParamsSchema);
const validateWizardCancelParams = lazyCompile(WizardCancelParamsSchema);
const validateWizardStatusParams = lazyCompile(WizardStatusParamsSchema);
const validateTalkModeParams = lazyCompile(TalkModeParamsSchema);
const validateTalkEvent = lazyCompile(TalkEventSchema);
const validateTalkCatalogParams = lazyCompile(TalkCatalogParamsSchema);
const validateTalkCatalogResult = lazyCompile(TalkCatalogResultSchema);
const validateTalkConfigParams = lazyCompile(TalkConfigParamsSchema);
const validateTalkConfigResult = lazyCompile(TalkConfigResultSchema);
const validateTalkClientCreateParams = lazyCompile(TalkClientCreateParamsSchema);
const validateTalkClientCreateResult = lazyCompile(TalkClientCreateResultSchema);
const validateTalkClientToolCallParams = lazyCompile(TalkClientToolCallParamsSchema);
const validateTalkClientToolCallResult = lazyCompile(TalkClientToolCallResultSchema);
const validateTalkSessionCreateParams = lazyCompile(TalkSessionCreateParamsSchema);
const validateTalkSessionCreateResult = lazyCompile(TalkSessionCreateResultSchema);
const validateTalkSessionJoinParams = lazyCompile(TalkSessionJoinParamsSchema);
const validateTalkSessionJoinResult = lazyCompile(TalkSessionJoinResultSchema);
const validateTalkSessionAppendAudioParams = lazyCompile(TalkSessionAppendAudioParamsSchema);
const validateTalkSessionTurnParams = lazyCompile(TalkSessionTurnParamsSchema);
const validateTalkSessionCancelTurnParams = lazyCompile(TalkSessionCancelTurnParamsSchema);
const validateTalkSessionCancelOutputParams = lazyCompile(TalkSessionCancelOutputParamsSchema);
const validateTalkSessionTurnResult = lazyCompile(TalkSessionTurnResultSchema);
const validateTalkSessionSubmitToolResultParams = lazyCompile(TalkSessionSubmitToolResultParamsSchema);
const validateTalkSessionCloseParams = lazyCompile(TalkSessionCloseParamsSchema);
const validateTalkSessionOkResult = lazyCompile(TalkSessionOkResultSchema);
const validateTalkSpeakParams = lazyCompile(TalkSpeakParamsSchema);
const validateTalkSpeakResult = lazyCompile(TalkSpeakResultSchema);
const validateChannelsStatusParams = lazyCompile(ChannelsStatusParamsSchema);
const validateChannelsStartParams = lazyCompile(ChannelsStartParamsSchema);
const validateChannelsStopParams = lazyCompile(ChannelsStopParamsSchema);
const validateChannelsLogoutParams = lazyCompile(ChannelsLogoutParamsSchema);
const validateModelsListParams = lazyCompile(ModelsListParamsSchema);
const validateSkillsStatusParams = lazyCompile(SkillsStatusParamsSchema);
const validateToolsCatalogParams = lazyCompile(ToolsCatalogParamsSchema);
const validateToolsEffectiveParams = lazyCompile(ToolsEffectiveParamsSchema);
const validateToolsInvokeParams = lazyCompile(ToolsInvokeParamsSchema);
const validateSkillsBinsParams = lazyCompile(SkillsBinsParamsSchema);
const validateSkillsInstallParams = lazyCompile(SkillsInstallParamsSchema);
const validateSkillsUploadBeginParams = lazyCompile(SkillsUploadBeginParamsSchema);
const validateSkillsUploadChunkParams = lazyCompile(SkillsUploadChunkParamsSchema);
const validateSkillsUploadCommitParams = lazyCompile(SkillsUploadCommitParamsSchema);
const validateSkillsUpdateParams = lazyCompile(SkillsUpdateParamsSchema);
const validateSkillsSearchParams = lazyCompile(SkillsSearchParamsSchema);
const validateSkillsDetailParams = lazyCompile(SkillsDetailParamsSchema);
const validateCronListParams = lazyCompile(CronListParamsSchema);
const validateCronStatusParams = lazyCompile(CronStatusParamsSchema);
const validateCronGetParams = lazyCompile(CronGetParamsSchema);
const validateCronAddParams = lazyCompile(CronAddParamsSchema);
const validateCronUpdateParams = lazyCompile(CronUpdateParamsSchema);
const validateCronRemoveParams = lazyCompile(CronRemoveParamsSchema);
const validateCronRunParams = lazyCompile(CronRunParamsSchema);
const validateCronRunsParams = lazyCompile(CronRunsParamsSchema);
const validateDevicePairListParams = lazyCompile(DevicePairListParamsSchema);
const validateDevicePairApproveParams = lazyCompile(DevicePairApproveParamsSchema);
const validateDevicePairRejectParams = lazyCompile(DevicePairRejectParamsSchema);
const validateDevicePairRemoveParams = lazyCompile(DevicePairRemoveParamsSchema);
const validateDeviceTokenRotateParams = lazyCompile(DeviceTokenRotateParamsSchema);
const validateDeviceTokenRevokeParams = lazyCompile(DeviceTokenRevokeParamsSchema);
const validateExecApprovalsGetParams = lazyCompile(ExecApprovalsGetParamsSchema);
const validateExecApprovalsSetParams = lazyCompile(ExecApprovalsSetParamsSchema);
const validateExecApprovalGetParams = lazyCompile(ExecApprovalGetParamsSchema);
const validateExecApprovalRequestParams = lazyCompile(ExecApprovalRequestParamsSchema);
const validateExecApprovalResolveParams = lazyCompile(ExecApprovalResolveParamsSchema);
const validatePluginApprovalRequestParams = lazyCompile(PluginApprovalRequestParamsSchema);
const validatePluginApprovalResolveParams = lazyCompile(PluginApprovalResolveParamsSchema);
const validatePluginsUiDescriptorsParams = lazyCompile(PluginsUiDescriptorsParamsSchema);
const validatePluginsSessionActionParams = lazyCompile(PluginsSessionActionParamsSchema);
const validatePluginsSessionActionResult = lazyCompile(PluginsSessionActionResultSchema);
const validateExecApprovalsNodeGetParams = lazyCompile(ExecApprovalsNodeGetParamsSchema);
const validateExecApprovalsNodeSetParams = lazyCompile(ExecApprovalsNodeSetParamsSchema);
const validateLogsTailParams = lazyCompile(LogsTailParamsSchema);
const validateChatHistoryParams = lazyCompile(ChatHistoryParamsSchema);
const validateChatSendParams = lazyCompile(ChatSendParamsSchema);
const validateChatAbortParams = lazyCompile(ChatAbortParamsSchema);
const validateChatInjectParams = lazyCompile(ChatInjectParamsSchema);
const validateChatEvent = lazyCompile(ChatEventSchema);
const validateUpdateStatusParams = lazyCompile(UpdateStatusParamsSchema);
const validateUpdateRunParams = lazyCompile(UpdateRunParamsSchema);
const validateWebLoginStartParams = lazyCompile(WebLoginStartParamsSchema);
const validateWebLoginWaitParams = lazyCompile(WebLoginWaitParamsSchema);
function formatValidationErrors(errors) {
	if (!errors?.length) return "unknown validation error";
	const parts = [];
	for (const err of errors) {
		const keyword = typeof err?.keyword === "string" ? err.keyword : "";
		const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";
		if (keyword === "additionalProperties") {
			const additionalProperty = (err?.params)?.additionalProperty;
			if (typeof additionalProperty === "string" && additionalProperty.trim()) {
				const where = instancePath ? `at ${instancePath}` : "at root";
				parts.push(`${where}: unexpected property '${additionalProperty}'`);
				continue;
			}
		}
		const message = typeof err?.message === "string" && err.message.trim() ? err.message : "validation error";
		const where = instancePath ? `at ${instancePath}: ` : "";
		parts.push(`${where}${message}`);
	}
	const unique = Array.from(new Set(parts.filter((part) => part.trim())));
	if (!unique.length) return getAjv().errorsText(errors, { separator: "; " }) || "unknown validation error";
	return unique.join("; ");
}
//#endregion
export { validateExecApprovalsGetParams as $, ModelsListParamsSchema as $a, UpdateStatusParamsSchema as $i, ProtocolSchemas as $n, NodePendingDrainResultSchema as $r, validateSessionsSendParams as $t, validateConfigSchemaParams as A, TalkSpeakResultSchema as Aa, EnvironmentsListResultSchema as Ai, validateTalkSessionTurnParams as An, SessionsResolveParamsSchema as Ar, validateRequestFrame as At, validateCronUpdateParams as B, AgentsDeleteParamsSchema as Ba, CronRunParamsSchema as Bi, validateUpdateRunParams as Bn, PluginsSessionActionResultSchema as Br, validateSessionsCompactionListParams as Bt, validateChatSendParams as C, TalkSessionJoinParamsSchema as Ca, ExecApprovalRequestParamsSchema as Ci, validateTalkSessionCloseParams as Cn, SessionsDeleteParamsSchema as Cr, validatePluginApprovalRequestParams as Ct, validateConfigPatchParams as D, TalkSessionTurnParamsSchema as Da, EnvironmentStatusSchema as Di, validateTalkSessionJoinResult as Dn, SessionsPluginPatchParamsSchema as Dr, validatePluginsUiDescriptorsParams as Dt, validateConfigGetParams as E, TalkSessionSubmitToolResultParamsSchema as Ea, ExecApprovalsSetParamsSchema as Ei, validateTalkSessionJoinParams as En, SessionsPatchParamsSchema as Er, validatePluginsSessionActionResult as Et, validateCronListParams as F, ArtifactsGetParamsSchema as Fa, CronAddParamsSchema as Fi, validateTasksGetParams as Fn, WebPushSubscribeParamsSchema as Fr, validateSessionsAbortParams as Ft, validateDeviceTokenRevokeParams as G, AgentsFilesListParamsSchema as Ga, ConfigGetParamsSchema as Gi, validateWebPushSubscribeParams as Gn, NodePairApproveParamsSchema as Gr, validateSessionsListParams as Gt, validateDevicePairListParams as H, AgentsFileEntrySchema as Ha, CronStatusParamsSchema as Hi, validateWakeParams as Hn, NodeEventResultSchema as Hr, validateSessionsCreateParams as Ht, validateCronRemoveParams as I, ArtifactsListParamsSchema as Ia, CronGetParamsSchema as Ii, validateTasksListParams as In, WebPushTestParamsSchema as Ir, validateSessionsCleanupParams as It, validateEnvironmentsStatusParams as J, AgentsFilesSetResultSchema as Ja, ConfigSchemaLookupResultSchema as Ji, validateWebPushVapidPublicKeyParams as Jn, NodePairRemoveParamsSchema as Jr, validateSessionsPatchParams as Jt, validateDeviceTokenRotateParams as K, AgentsFilesListResultSchema as Ka, ConfigPatchParamsSchema as Ki, validateWebPushTestParams as Kn, NodePairListParamsSchema as Kr, validateSessionsMessagesSubscribeParams as Kt, validateCronRunParams as L, AgentSummarySchema as La, CronJobSchema as Li, validateToolsCatalogParams as Ln, WebPushUnsubscribeParamsSchema as Lr, validateSessionsCompactParams as Lt, validateConnectParams as M, WebLoginWaitParamsSchema as Ma, EnvironmentsStatusResultSchema as Mi, validateTalkSpeakParams as Mn, SessionsUsageParamsSchema as Mr, validateSecretsResolveParams as Mt, validateCronAddParams as N, ArtifactSummarySchema as Na, ErrorCodes as Ni, validateTalkSpeakResult as Nn, PushTestParamsSchema as Nr, validateSecretsResolveResult as Nt, validateConfigSchemaLookupParams as O, TalkSessionTurnResultSchema as Oa, EnvironmentSummarySchema as Oi, validateTalkSessionOkResult as On, SessionsPreviewParamsSchema as Or, validatePollParams as Ot, validateCronGetParams as P, ArtifactsDownloadParamsSchema as Pa, errorShape as Pi, validateTasksCancelParams as Pn, PushTestResultSchema as Pr, validateSendParams as Pt, validateExecApprovalResolveParams as Q, AgentsUpdateResultSchema as Qa, UpdateRunParamsSchema as Qi, validateWizardStatusParams as Qn, NodePendingDrainParamsSchema as Qr, validateSessionsResolveParams as Qt, validateCronRunsParams as R, AgentsCreateParamsSchema as Ra, CronListParamsSchema as Ri, validateToolsEffectiveParams as Rn, WebPushVapidPublicKeyParamsSchema as Rr, validateSessionsCompactionBranchParams as Rt, validateChatInjectParams as S, TalkSessionCreateResultSchema as Sa, ExecApprovalGetParamsSchema as Si, validateTalkSessionCancelTurnParams as Sn, AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION as So, SessionsCreateParamsSchema as Sr, validateNodeRenameParams as St, validateConfigApplyParams as T, TalkSessionOkResultSchema as Ta, ExecApprovalsGetParamsSchema as Ti, validateTalkSessionCreateResult as Tn, SessionsListParamsSchema as Tr, validatePluginsSessionActionParams as Tt, validateDevicePairRejectParams as U, AgentsFilesGetParamsSchema as Ua, CronUpdateParamsSchema as Ui, validateWebLoginStartParams as Un, NodeInvokeParamsSchema as Ur, validateSessionsDeleteParams as Ut, validateDevicePairApproveParams as V, AgentsDeleteResultSchema as Va, CronRunsParamsSchema as Vi, validateUpdateStatusParams as Vn, PluginsUiDescriptorsParamsSchema as Vr, validateSessionsCompactionRestoreParams as Vt, validateDevicePairRemoveParams as W, AgentsFilesGetResultSchema as Wa, ConfigApplyParamsSchema as Wi, validateWebLoginWaitParams as Wn, NodeListParamsSchema as Wr, validateSessionsDescribeParams as Wt, validateExecApprovalGetParams as X, AgentsListResultSchema as Xa, ConfigSchemaResponseSchema as Xi, validateWizardNextParams as Xn, NodePairVerifyParamsSchema as Xr, validateSessionsPreviewParams as Xt, validateEventFrame as Y, AgentsListParamsSchema as Ya, ConfigSchemaParamsSchema as Yi, validateWizardCancelParams as Yn, NodePairRequestParamsSchema as Yr, validateSessionsPluginPatchParams as Yt, validateExecApprovalRequestParams as Z, AgentsUpdateParamsSchema as Za, ConfigSetParamsSchema as Zi, validateWizardStartParams as Zn, NodePendingAckParamsSchema as Zr, validateSessionsResetParams as Zt, validateChannelsStatusParams as _, TalkSessionAppendAudioParamsSchema as _a, ShutdownEventSchema as _i, validateTalkConfigResult as _n, MessageActionParamsSchema as _o, SessionsCompactParamsSchema as _r, validateNodePairVerifyParams as _t, validateAgentsCreateParams as a, ChannelsStatusParamsSchema as aa, ChatHistoryParamsSchema as ai, validateSkillsStatusParams as an, SkillsStatusParamsSchema as ao, WizardStatusParamsSchema as ar, validateModelsListParams as at, validateChatEvent as b, TalkSessionCloseParamsSchema as ba, SnapshotSchema as bi, validateTalkSessionAppendAudioParams as bn, WakeParamsSchema as bo, SessionsCompactionListParamsSchema as br, validateNodePendingEnqueueParams as bt, validateAgentsFilesListParams as c, TalkCatalogParamsSchema as ca, LogsTailParamsSchema as ci, validateSkillsUploadChunkParams as cn, SkillsUploadChunkParamsSchema as co, TaskSummarySchema as cr, validateNodeEventResult as ct, validateAgentsUpdateParams as d, TalkClientCreateResultSchema as da, ErrorShapeSchema as di, validateTalkCatalogResult as dn, ToolsEffectiveParamsSchema as do, TasksGetParamsSchema as dr, validateNodeListParams as dt, COMMAND_DESCRIPTION_MAX_LENGTH as ea, NodePendingEnqueueParamsSchema as ei, validateSessionsUsageParams as en, SkillsDetailParamsSchema as eo, WizardCancelParamsSchema as er, validateExecApprovalsNodeGetParams as et, validateArtifactsDownloadParams as f, TalkClientToolCallParamsSchema as fa, EventFrameSchema as fi, validateTalkClientCreateParams as fn, ToolsInvokeParamsSchema as fo, TasksGetResultSchema as fr, validateNodePairApproveParams as ft, validateChannelsStartParams as g, TalkEventSchema as ga, ResponseFrameSchema as gi, validateTalkConfigParams as gn, AgentParamsSchema as go, SessionsCleanupParamsSchema as gr, validateNodePairRequestParams as gt, validateChannelsLogoutParams as h, TalkConfigResultSchema as ha, RequestFrameSchema as hi, validateTalkClientToolCallResult as hn, AgentIdentityResultSchema as ho, SessionsAbortParamsSchema as hr, validateNodePairRemoveParams as ht, validateAgentWaitParams as i, ChannelsStartParamsSchema as ia, ChatEventSchema as ii, validateSkillsSearchParams as in, SkillsSearchResultSchema as io, WizardStartResultSchema as ir, validateMessageActionParams as it, validateConfigSetParams as j, WebLoginStartParamsSchema as ja, EnvironmentsStatusParamsSchema as ji, validateTalkSessionTurnResult as jn, SessionsSendParamsSchema as jr, validateResponseFrame as jt, validateConfigSchemaLookupResult as k, TalkSpeakParamsSchema as ka, EnvironmentsListParamsSchema as ki, validateTalkSessionSubmitToolResultParams as kn, SessionsResetParamsSchema as kr, validatePushTestParams as kt, validateAgentsFilesSetParams as l, TalkCatalogResultSchema as la, LogsTailResultSchema as li, validateSkillsUploadCommitParams as ln, SkillsUploadCommitParamsSchema as lo, TasksCancelParamsSchema as lr, validateNodeInvokeParams as lt, validateArtifactsListParams as m, TalkConfigParamsSchema as ma, HelloOkSchema as mi, validateTalkClientToolCallParams as mn, AgentIdentityParamsSchema as mo, TasksListResultSchema as mr, validateNodePairRejectParams as mt, validateAgentIdentityParams as n, CommandsListResultSchema as na, NodePresenceAlivePayloadSchema as ni, validateSkillsDetailParams as nn, SkillsInstallParamsSchema as no, WizardNextResultSchema as nr, validateExecApprovalsSetParams as nt, validateAgentsDeleteParams as o, ChannelsStatusResultSchema as oa, ChatInjectParamsSchema as oi, validateSkillsUpdateParams as on, SkillsUpdateParamsSchema as oo, WizardStatusResultSchema as or, validateNodeDescribeParams as ot, validateArtifactsGetParams as p, TalkClientToolCallResultSchema as pa, GatewayFrameSchema as pi, validateTalkClientCreateResult as pn, AgentEventSchema as po, TasksListParamsSchema as pr, validateNodePairListParams as pt, validateEnvironmentsListParams as q, AgentsFilesSetParamsSchema as qa, ConfigSchemaLookupParamsSchema as qi, validateWebPushUnsubscribeParams as qn, NodePairRejectParamsSchema as qr, validateSessionsMessagesUnsubscribeParams as qt, validateAgentParams as r, ChannelsLogoutParamsSchema as ra, NodePresenceAliveReasonSchema as ri, validateSkillsInstallParams as rn, SkillsSearchParamsSchema as ro, WizardStartParamsSchema as rr, validateLogsTailParams as rt, validateAgentsFilesGetParams as s, ChannelsStopParamsSchema as sa, ChatSendParamsSchema as si, validateSkillsUploadBeginParams as sn, SkillsUploadBeginParamsSchema as so, WizardStepSchema as sr, validateNodeEventParams as st, formatValidationErrors as t, CommandsListParamsSchema as ta, NodePendingEnqueueResultSchema as ti, validateSkillsBinsParams as tn, SkillsDetailResultSchema as to, WizardNextParamsSchema as tr, validateExecApprovalsNodeSetParams as tt, validateAgentsListParams as u, TalkClientCreateParamsSchema as ua, ConnectParamsSchema as ui, validateTalkCatalogParams as un, ToolsCatalogParamsSchema as uo, TasksCancelResultSchema as ur, validateNodeInvokeResultParams as ut, validateChannelsStopParams as v, TalkSessionCancelOutputParamsSchema as va, TickEventSchema as vi, validateTalkEvent as vn, PollParamsSchema as vo, SessionsCompactionBranchParamsSchema as vr, validateNodePendingAckParams as vt, validateCommandsListParams as w, TalkSessionJoinResultSchema as wa, ExecApprovalResolveParamsSchema as wi, validateTalkSessionCreateParams as wn, SessionsDescribeParamsSchema as wr, validatePluginApprovalResolveParams as wt, validateChatHistoryParams as x, TalkSessionCreateParamsSchema as xa, StateVersionSchema as xi, validateTalkSessionCancelOutputParams as xn, parseSessionLabel as xo, SessionsCompactionRestoreParamsSchema as xr, validateNodePresenceAlivePayload as xt, validateChatAbortParams as y, TalkSessionCancelTurnParamsSchema as ya, PresenceEntrySchema as yi, validateTalkModeParams as yn, SendParamsSchema as yo, SessionsCompactionGetParamsSchema as yr, validateNodePendingDrainParams as yt, validateCronStatusParams as z, AgentsCreateResultSchema as za, CronRemoveParamsSchema as zi, validateToolsInvokeParams as zn, PluginsSessionActionParamsSchema as zr, validateSessionsCompactionGetParams as zt };

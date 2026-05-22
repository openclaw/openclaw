import { l as ToolPolicySchema } from "./zod-schema.agent-runtime-D3D7fvbE.js";
import { L as requireOpenAllowFrom, b as ReplyRuntimeConfigSchemaShape, h as MarkdownConfigSchema, l as GroupPolicySchema, o as DmPolicySchema } from "./zod-schema.core-DMLDoxA0.js";
import { r as buildChannelConfigSchema } from "./config-schema-CLM6ogpT.js";
import "./channel-config-schema-He9BEOhc.js";
import { t as zod_exports } from "./zod-DgrMscH9.js";
//#region extensions/irc/src/config-ui-hints.ts
const ircChannelConfigUiHints = {
	"": {
		label: "IRC",
		help: "IRC channel provider configuration and compatibility settings for classic IRC transport workflows. Use this section when bridging legacy chat infrastructure into OpenClaw."
	},
	dmPolicy: {
		label: "IRC DM Policy",
		help: "Direct message access control (\"pairing\" recommended). \"open\" requires channels.irc.allowFrom=[\"*\"]."
	},
	"nickserv.enabled": {
		label: "IRC NickServ Enabled",
		help: "Enable NickServ identify/register after connect (defaults to enabled when password is configured)."
	},
	"nickserv.service": {
		label: "IRC NickServ Service",
		help: "NickServ service nick (default: NickServ)."
	},
	"nickserv.password": {
		label: "IRC NickServ Password",
		help: "NickServ password used for IDENTIFY/REGISTER (sensitive)."
	},
	"nickserv.passwordFile": {
		label: "IRC NickServ Password File",
		help: "Optional file path containing NickServ password."
	},
	"nickserv.register": {
		label: "IRC NickServ Register",
		help: "If true, send NickServ REGISTER on every connect. Use once for initial registration, then disable."
	},
	"nickserv.registerEmail": {
		label: "IRC NickServ Register Email",
		help: "Email used with NickServ REGISTER (required when register=true)."
	},
	configWrites: {
		label: "IRC Config Writes",
		help: "Allow IRC to write config in response to channel events/commands (default: true)."
	}
};
//#endregion
//#region extensions/irc/src/config-schema.ts
const IrcGroupSchema = zod_exports.z.object({
	requireMention: zod_exports.z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: zod_exports.z.record(zod_exports.z.string(), ToolPolicySchema).optional(),
	skills: zod_exports.z.array(zod_exports.z.string()).optional(),
	enabled: zod_exports.z.boolean().optional(),
	allowFrom: zod_exports.z.array(zod_exports.z.union([zod_exports.z.string(), zod_exports.z.number()])).optional(),
	systemPrompt: zod_exports.z.string().optional()
}).strict();
const IrcNickServSchema = zod_exports.z.object({
	enabled: zod_exports.z.boolean().optional(),
	service: zod_exports.z.string().optional(),
	password: zod_exports.z.string().optional(),
	passwordFile: zod_exports.z.string().optional(),
	register: zod_exports.z.boolean().optional(),
	registerEmail: zod_exports.z.string().optional()
}).strict().superRefine((value, ctx) => {
	if (value.register && !value.registerEmail?.trim()) ctx.addIssue({
		code: zod_exports.z.ZodIssueCode.custom,
		path: ["registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
});
const IrcAccountSchemaBase = zod_exports.z.object({
	name: zod_exports.z.string().optional(),
	enabled: zod_exports.z.boolean().optional(),
	dangerouslyAllowNameMatching: zod_exports.z.boolean().optional(),
	host: zod_exports.z.string().optional(),
	port: zod_exports.z.number().int().min(1).max(65535).optional(),
	tls: zod_exports.z.boolean().optional(),
	nick: zod_exports.z.string().optional(),
	username: zod_exports.z.string().optional(),
	realname: zod_exports.z.string().optional(),
	password: zod_exports.z.string().optional(),
	passwordFile: zod_exports.z.string().optional(),
	nickserv: IrcNickServSchema.optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: zod_exports.z.array(zod_exports.z.union([zod_exports.z.string(), zod_exports.z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groupAllowFrom: zod_exports.z.array(zod_exports.z.union([zod_exports.z.string(), zod_exports.z.number()])).optional(),
	groups: zod_exports.z.record(zod_exports.z.string(), IrcGroupSchema.optional()).optional(),
	channels: zod_exports.z.array(zod_exports.z.string()).optional(),
	mentionPatterns: zod_exports.z.array(zod_exports.z.string()).optional(),
	markdown: MarkdownConfigSchema,
	...ReplyRuntimeConfigSchemaShape
}).strict();
const IrcAccountSchema = IrcAccountSchemaBase.superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"open\" requires channels.irc.allowFrom to include \"*\""
	});
});
const IrcChannelConfigSchema = buildChannelConfigSchema(IrcAccountSchemaBase.extend({
	accounts: zod_exports.z.record(zod_exports.z.string(), IrcAccountSchema.optional()).optional(),
	defaultAccount: zod_exports.z.string().optional()
}).superRefine((value, ctx) => {
	requireOpenAllowFrom({
		policy: value.dmPolicy,
		allowFrom: value.allowFrom,
		ctx,
		path: ["allowFrom"],
		message: "channels.irc.dmPolicy=\"open\" requires channels.irc.allowFrom to include \"*\""
	});
}), { uiHints: ircChannelConfigUiHints });
//#endregion
export { IrcChannelConfigSchema as t };

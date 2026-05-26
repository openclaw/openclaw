import { l as ToolPolicySchema } from "./zod-schema.agent-runtime-CkLkDy5d.js";
import { L as requireOpenAllowFrom, b as ReplyRuntimeConfigSchemaShape, h as MarkdownConfigSchema, l as GroupPolicySchema, o as DmPolicySchema } from "./zod-schema.core-CrlgnnCI.js";
import { r as buildChannelConfigSchema } from "./config-schema-DftNRjDz.js";
import "./channel-config-schema-BaJC-ytH.js";
import { z } from "zod";
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
const IrcGroupSchema = z.object({
	requireMention: z.boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: z.record(z.string(), ToolPolicySchema).optional(),
	skills: z.array(z.string()).optional(),
	enabled: z.boolean().optional(),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	systemPrompt: z.string().optional()
}).strict();
const IrcNickServSchema = z.object({
	enabled: z.boolean().optional(),
	service: z.string().optional(),
	password: z.string().optional(),
	passwordFile: z.string().optional(),
	register: z.boolean().optional(),
	registerEmail: z.string().optional()
}).strict().superRefine((value, ctx) => {
	if (value.register && !value.registerEmail?.trim()) ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
});
const IrcAccountSchemaBase = z.object({
	name: z.string().optional(),
	enabled: z.boolean().optional(),
	dangerouslyAllowNameMatching: z.boolean().optional(),
	host: z.string().optional(),
	port: z.number().int().min(1).max(65535).optional(),
	tls: z.boolean().optional(),
	nick: z.string().optional(),
	username: z.string().optional(),
	realname: z.string().optional(),
	password: z.string().optional(),
	passwordFile: z.string().optional(),
	nickserv: IrcNickServSchema.optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
	groups: z.record(z.string(), IrcGroupSchema.optional()).optional(),
	channels: z.array(z.string()).optional(),
	mentionPatterns: z.array(z.string()).optional(),
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
	accounts: z.record(z.string(), IrcAccountSchema.optional()).optional(),
	defaultAccount: z.string().optional()
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

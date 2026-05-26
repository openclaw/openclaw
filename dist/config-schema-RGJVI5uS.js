import { At as boolean, Et as array, Nn as record, Rn as string, Tn as object, Xn as union, wn as number } from "./schemas-Del5uzR8.js";
import { n as ZodIssueCode } from "./compat-bCpUj7Jq.js";
import { R as requireOpenAllowFrom, b as ReplyRuntimeConfigSchemaShape, h as MarkdownConfigSchema, l as GroupPolicySchema, o as DmPolicySchema } from "./zod-schema.core-D7Y_eqdd.js";
import { u as ToolPolicySchema } from "./zod-schema.agent-runtime-Bq5CXVVg.js";
import { r as buildChannelConfigSchema } from "./config-schema-ChfiQrSg.js";
import "./channel-config-schema-BBVXL5oD.js";
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
const IrcGroupSchema = object({
	requireMention: boolean().optional(),
	tools: ToolPolicySchema,
	toolsBySender: record(string(), ToolPolicySchema).optional(),
	skills: array(string()).optional(),
	enabled: boolean().optional(),
	allowFrom: array(union([string(), number()])).optional(),
	systemPrompt: string().optional()
}).strict();
const IrcNickServSchema = object({
	enabled: boolean().optional(),
	service: string().optional(),
	password: string().optional(),
	passwordFile: string().optional(),
	register: boolean().optional(),
	registerEmail: string().optional()
}).strict().superRefine((value, ctx) => {
	if (value.register && !value.registerEmail?.trim()) ctx.addIssue({
		code: ZodIssueCode.custom,
		path: ["registerEmail"],
		message: "channels.irc.nickserv.register=true requires channels.irc.nickserv.registerEmail"
	});
});
const IrcAccountSchemaBase = object({
	name: string().optional(),
	enabled: boolean().optional(),
	dangerouslyAllowNameMatching: boolean().optional(),
	host: string().optional(),
	port: number().int().min(1).max(65535).optional(),
	tls: boolean().optional(),
	nick: string().optional(),
	username: string().optional(),
	realname: string().optional(),
	password: string().optional(),
	passwordFile: string().optional(),
	nickserv: IrcNickServSchema.optional(),
	dmPolicy: DmPolicySchema.optional().default("pairing"),
	allowFrom: array(union([string(), number()])).optional(),
	groupPolicy: GroupPolicySchema.optional().default("allowlist"),
	groupAllowFrom: array(union([string(), number()])).optional(),
	groups: record(string(), IrcGroupSchema.optional()).optional(),
	channels: array(string()).optional(),
	mentionPatterns: array(string()).optional(),
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
	accounts: record(string(), IrcAccountSchema.optional()).optional(),
	defaultAccount: string().optional()
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

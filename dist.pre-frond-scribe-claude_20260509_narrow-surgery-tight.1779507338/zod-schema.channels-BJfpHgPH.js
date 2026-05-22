import { At as boolean, Et as array, Rn as string, Tn as object, Xn as union, dn as literal, wn as number } from "./schemas-Del5uzR8.js";
//#region src/config/zod-schema.approvals.ts
const NativeExecApprovalEnableModeSchema = union([boolean(), literal("auto")]);
const ExecApprovalForwardTargetSchema = object({
	channel: string().min(1),
	to: string().min(1),
	accountId: string().optional(),
	threadId: union([string(), number()]).optional()
}).strict();
const ExecApprovalForwardingSchema = object({
	enabled: boolean().optional(),
	mode: union([
		literal("session"),
		literal("targets"),
		literal("both")
	]).optional(),
	agentFilter: array(string()).optional(),
	sessionFilter: array(string()).optional(),
	targets: array(ExecApprovalForwardTargetSchema).optional()
}).strict().optional();
const ApprovalsSchema = object({
	exec: ExecApprovalForwardingSchema,
	plugin: ExecApprovalForwardingSchema
}).strict().optional();
//#endregion
//#region src/config/zod-schema.channels.ts
const ChannelHeartbeatVisibilitySchema = object({
	showOk: boolean().optional(),
	showAlerts: boolean().optional(),
	useIndicator: boolean().optional()
}).strict().optional();
const ChannelHealthMonitorSchema = object({ enabled: boolean().optional() }).strict().optional();
//#endregion
export { NativeExecApprovalEnableModeSchema as i, ChannelHeartbeatVisibilitySchema as n, ApprovalsSchema as r, ChannelHealthMonitorSchema as t };

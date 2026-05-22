import { At as boolean, Tn as object } from "./schemas-Bmna8ihM.js";
//#region src/config/zod-schema.channels.ts
const ChannelHeartbeatVisibilitySchema = object({
	showOk: boolean().optional(),
	showAlerts: boolean().optional(),
	useIndicator: boolean().optional()
}).strict().optional();
const ChannelHealthMonitorSchema = object({ enabled: boolean().optional() }).strict().optional();
//#endregion
export { ChannelHeartbeatVisibilitySchema as n, ChannelHealthMonitorSchema as t };

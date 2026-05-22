import { z } from "zod";
//#region src/config/zod-schema.channels.ts
const ChannelHeartbeatVisibilitySchema = z.object({
	showOk: z.boolean().optional(),
	showAlerts: z.boolean().optional(),
	useIndicator: z.boolean().optional()
}).strict().optional();
const ChannelHealthMonitorSchema = z.object({ enabled: z.boolean().optional() }).strict().optional();
//#endregion
export { ChannelHeartbeatVisibilitySchema as n, ChannelHealthMonitorSchema as t };

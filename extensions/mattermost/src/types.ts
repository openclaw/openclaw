import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import type { z } from "zod";
import type { MattermostAccountSchemaBase, MattermostConfigSchema } from "./config-schema-core.js";

export type MattermostReplyToMode = ReplyToMode;
export type MattermostChatTypeKey = "direct" | "channel" | "group";
export type MattermostChatMode = "oncall" | "onmessage" | "onchar";

export type MattermostAccountConfig = z.input<typeof MattermostAccountSchemaBase>;
export type MattermostConfig = z.input<typeof MattermostConfigSchema>;

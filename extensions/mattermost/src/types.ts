// Mattermost type declarations derive plugin contracts from the runtime schema.
import type { z } from "zod";
import type { MattermostAccountSchemaBase, MattermostConfigSchema } from "./config-schema-core.js";

export type MattermostReplyToMode = "off" | "first" | "all" | "batched";
export type MattermostChatTypeKey = "direct" | "channel" | "group";
export type MattermostChatMode = "oncall" | "onmessage" | "onchar";

export type MattermostAccountConfig = z.input<typeof MattermostAccountSchemaBase>;
export type MattermostConfig = z.input<typeof MattermostConfigSchema>;

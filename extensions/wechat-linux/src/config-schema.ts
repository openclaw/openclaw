import { z } from "zod";
import type { DmPolicy, GroupPolicy, WechatLinuxWindowMode } from "./types.js";

const DmPolicySchema = z.enum(["disabled", "allowlist", "open", "pairing"] satisfies DmPolicy[]);
const GroupPolicySchema = z.enum(["disabled", "allowlist", "open"] satisfies GroupPolicy[]);
const WindowModeSchema = z.enum(["auto", "standalone", "main"] satisfies WechatLinuxWindowMode[]);

export const WechatLinuxAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    pyWxDumpRoot: z.string().optional(),
    pythonPath: z.string().optional(),
    keyFile: z.string().optional(),
    dbDir: z.string().optional(),
    outputDir: z.string().optional(),
    display: z.string().optional(),
    xauthority: z.string().optional(),
    windowClass: z.string().optional(),
    windowMode: WindowModeSchema.optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    groupAllowFrom: z.array(z.string()).optional(),
    mentionPatterns: z.array(z.string()).optional(),
    textChunkLimit: z.number().int().min(1).max(20000).optional(),
    blockStreaming: z.boolean().optional(),
    mediaMaxMb: z.number().positive().max(1024).optional(),
    imageAnalysis: z.boolean().optional(),
    videoAnalysis: z.boolean().optional(),
    voiceAsr: z.boolean().optional(),
    linkDocs: z.boolean().optional(),
    visionBaseUrl: z.string().optional(),
    visionModel: z.string().optional(),
    visionApiKeyEnv: z.string().optional(),
    summaryBaseUrl: z.string().optional(),
    summaryModel: z.string().optional(),
    summaryApiKeyEnv: z.string().optional(),
    asrUrl: z.string().optional(),
    linkHookCmd: z.string().optional(),
    linkDocRoot: z.string().optional(),
    linkDomains: z.array(z.string()).optional(),
    linkHookTimeoutSec: z.number().int().min(1).max(600).optional(),
  })
  .strict();

export const WechatLinuxConfigSchema = WechatLinuxAccountSchemaBase.extend({
  accounts: z.record(z.string(), WechatLinuxAccountSchemaBase.optional()).optional(),
  defaultAccount: z.string().optional(),
}).strict();

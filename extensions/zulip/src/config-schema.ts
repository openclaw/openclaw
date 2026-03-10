import {
  BlockStreamingCoalesceSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk";
import { z } from "zod";

const ZulipTopicSchema = z
  .object({
    initialHistoryLimit: z.number().int().min(0).max(100).optional(),
  })
  .strict()
  .optional();

const ZulipStreamSchema = z
  .object({
    requireMention: z.boolean().optional(),
  })
  .strict();

const ZulipThreadBindingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    idleHours: z.number().min(0).optional(),
    maxAgeHours: z.number().min(0).optional(),
  })
  .strict()
  .optional();

const ZulipXCaseRouteSchema = z
  .object({
    expertAgentId: z.string().min(1).optional(),
    analysisStream: z.string().min(1).optional(),
    analysisTopic: z.string().min(1).optional(),
    aliases: z.array(z.string().min(1)).optional(),
    postAsAccountId: z.string().min(1).optional(),
  })
  .strict();

const ZulipXCaseSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    commandPostStream: z.string().min(1).optional(),
    commandPostTopic: z.string().min(1).optional().default("command-post"),
    perCaseTopic: z.boolean().optional().default(true),
    caseTopicMode: z.enum(["always", "on_continue", "never"]).optional(),
    autoTriage: z
      .enum(["off", "command_post_only", "mentioned", "always"])
      .optional()
      .default("command_post_only"),
    autoAnalyzeOnCapture: z.boolean().optional().default(true),
    routePeerPrefix: z.string().min(1).optional().default("xcase"),
    expertAgentId: z.string().min(1).optional(),
    expertAgentIds: z.array(z.string().min(1)).optional(),
    routes: z.record(z.string().min(1), ZulipXCaseRouteSchema).optional(),
    defaultRoute: z.string().min(1).optional().default("default"),
    maxLinksPerMessage: z.number().int().min(1).max(10).optional().default(3),
    maxOpenCases: z.number().int().min(1).max(5000).optional().default(500),
    includeMessageContext: z.boolean().optional().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.enabled) {
      return;
    }
    if (!value.commandPostStream) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["commandPostStream"],
        message:
          "channels.zulip.xcase.enabled=true requires channels.zulip.xcase.commandPostStream",
      });
    }
    const defaultRoute = value.defaultRoute?.trim();
    if (defaultRoute && value.routes && !(defaultRoute in value.routes)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultRoute"],
        message: `channels.zulip.xcase.defaultRoute="${defaultRoute}" must exist in channels.zulip.xcase.routes`,
      });
    }
  })
  .optional();

const ZulipGroupSchema = z
  .object({
    tools: ToolPolicySchema,
    toolsBySender: z.record(z.string().min(1), ToolPolicySchema).optional(),
  })
  .strict()
  .optional();

const ZulipExecApprovalSchema = z
  .object({
    enabled: z.boolean().optional(),
    approvers: z.array(z.union([z.string(), z.number()])).optional(),
    agentFilter: z.array(z.string().min(1)).optional(),
    sessionFilter: z.array(z.string().min(1)).optional(),
    cleanupAfterResolve: z.boolean().optional(),
    target: z.enum(["dm", "session", "both", "stream"]).optional(),
    stream: z.string().min(1).optional(),
    topic: z.string().min(1).optional().default("exec-approvals"),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.target === "stream" && !value.stream?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stream"],
        message:
          'channels.zulip.execApprovals.target="stream" requires channels.zulip.execApprovals.stream',
      });
    }
  })
  .optional();

const ZulipAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    botEmail: z.string().optional(),
    botApiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    tlsRejectUnauthorized: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    draftStreaming: z.enum(["off", "partial", "block"]).optional(),
    draftStreamingThrottleMs: z.number().int().min(250).max(5000).optional(),
    groups: z.record(z.string().min(1), ZulipGroupSchema).optional(),
    topic: ZulipTopicSchema,
    streams: z.record(z.string().min(1), ZulipStreamSchema).optional(),
    widgetsEnabled: z.boolean().optional(),
    threadBindings: ZulipThreadBindingsSchema,
    execApprovals: ZulipExecApprovalSchema,
    xcase: ZulipXCaseSchema,
  })
  .strict();

const ZulipAccountSchema = ZulipAccountSchemaBase.superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.zulip.dmPolicy="open" requires channels.zulip.allowFrom to include "*"',
  });
});

export const ZulipConfigSchema = ZulipAccountSchemaBase.extend({
  accounts: z.record(z.string(), ZulipAccountSchema.optional()).optional(),
}).superRefine((value, ctx) => {
  requireOpenAllowFrom({
    policy: value.dmPolicy,
    allowFrom: value.allowFrom,
    ctx,
    path: ["allowFrom"],
    message: 'channels.zulip.dmPolicy="open" requires channels.zulip.allowFrom to include "*"',
  });
});

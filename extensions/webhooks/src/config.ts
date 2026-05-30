import { z } from "zod";
import { normalizeWebhookPath } from "../runtime-api.js";

const secretRefSchema = z
  .object({
    source: z.enum(["env", "file", "exec"]),
    provider: z.string().trim().min(1),
    id: z.string().trim().min(1),
  })
  .strict();

const secretInputSchema = z.union([z.string().trim().min(1), secretRefSchema]);

const webhookAuthConfigSchema = z
  .object({
    mode: z.enum(["bearer", "header", "hmac-sha256"]),
    secret: secretInputSchema,
    header: z.string().trim().min(1).optional(),
    prefix: z.string().trim().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.mode === "header" || value.mode === "hmac-sha256") && !value.header) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "header is required for header and hmac-sha256 auth",
        path: ["header"],
      });
    }
  });

const webhookDispatchConfigSchema = z
  .object({
    mode: z.enum(["ack", "taskflow", "agent", "deliver"]).default("taskflow"),
    agent: z
      .object({
        messageTemplate: z.string().trim().min(1).optional(),
        deliveryMode: z.enum(["announce", "none"]).optional(),
        delayMs: z.number().int().nonnegative().optional(),
        nameTemplate: z.string().trim().min(1).optional(),
        tagTemplate: z.string().trim().min(1).optional(),
        agentId: z.string().trim().min(1).optional(),
        onCompletion: z
          .object({
            deliver: z.lazy(() => webhookDeliveryConfigSchema),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    taskflow: z
      .object({
        goalTemplate: z.string().trim().min(1).optional(),
        currentStep: z.string().trim().min(1).nullable().optional(),
        status: z.enum(["queued", "running", "waiting", "blocked"]).optional(),
        notifyPolicy: z.enum(["done_only", "state_changes", "silent"]).optional(),
        runTask: z
          .object({
            enabled: z.boolean().optional(),
            runtime: z.enum(["acp"]).optional(),
            taskTemplate: z.string().trim().min(1).optional(),
            sourceId: z.string().trim().min(1).optional(),
            childSessionKey: z.string().trim().min(1).optional(),
            parentTaskId: z.string().trim().min(1).optional(),
            agentId: z.string().trim().min(1).optional(),
            runIdTemplate: z.string().trim().min(1).optional(),
            labelTemplate: z.string().trim().min(1).optional(),
            notifyPolicy: z.enum(["done_only", "state_changes", "silent"]).optional(),
            status: z.enum(["queued", "running"]).optional(),
            preferMetadata: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .default({ mode: "taskflow" });

const webhookDeliverTargetSchema = z.string().trim().min(1);

const templatedNumberOrStringSchema = z.union([z.string().trim().min(1), z.number().finite()]);

const webhookDeliveryConfigSchema = z.union([
  webhookDeliverTargetSchema,
  z
    .object({
      mode: z.enum(["log", "channel"]).optional(),
      channel: z.string().trim().min(1).optional(),
      to: z.string().trim().min(1).optional(),
      textTemplate: z.string().trim().min(1).optional(),
      accountId: z.string().trim().min(1).optional(),
      threadId: templatedNumberOrStringSchema.optional(),
      silent: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal("exec"),
      command: z.string().trim().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      cwd: z.string().trim().min(1).optional(),
      textTemplate: z.string().trim().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);

const webhookDeliveryExtraConfigSchema = z.record(
  z.string(),
  z.union([z.string(), z.number().finite(), z.boolean()]),
);

const webhookEventConfigSchema = z
  .object({
    header: z.string().trim().min(1).optional(),
    payloadPath: z.string().trim().min(1).optional(),
  })
  .strict()
  .default({});

const webhookIdempotencyConfigSchema = z
  .object({
    header: z.string().trim().min(1).optional(),
    payloadPath: z.string().trim().min(1).optional(),
    ttlHours: z.number().positive().finite().optional(),
  })
  .strict();

const webhookVerificationConfigSchema = z
  .object({
    event: z.string().trim().min(1).optional(),
    challengePath: z.string().trim().min(1).optional(),
    responsePath: z.string().trim().min(1).optional(),
  })
  .strict();

const webhookRouteConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(true),
    path: z.string().trim().min(1).optional(),
    sessionKey: z.string().trim().min(1).optional(),
    secret: secretInputSchema.optional(),
    auth: webhookAuthConfigSchema.optional(),
    dispatch: webhookDispatchConfigSchema,
    events: z.array(z.string().trim().min(1)).optional(),
    event: webhookEventConfigSchema,
    idempotency: webhookIdempotencyConfigSchema.optional(),
    verification: webhookVerificationConfigSchema.optional(),
    controllerId: z.string().trim().min(1).optional(),
    prompt: z.string().trim().min(1).optional(),
    skills: z.array(z.string().trim().min(1)).optional(),
    deliver: webhookDeliveryConfigSchema.optional(),
    deliverExtra: webhookDeliveryExtraConfigSchema.optional(),
    deliver_extra: webhookDeliveryExtraConfigSchema.optional(),
    deliverOnly: z.boolean().optional(),
    deliver_only: z.boolean().optional(),
    description: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const dispatchMode = resolveRawDispatchMode(value);
    if ((dispatchMode === "taskflow" || dispatchMode === "agent") && !value.sessionKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sessionKey is required for taskflow and agent dispatch",
        path: ["sessionKey"],
      });
    }
    if (dispatchMode === "deliver" && !value.deliver) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "deliver is required for deliver dispatch",
        path: ["deliver"],
      });
    }
    if (!value.auth && !value.secret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "secret or auth is required",
        path: ["secret"],
      });
    }
  });

type RawWebhookRouteConfig = z.infer<typeof webhookRouteConfigSchema>;

const webhooksPluginConfigSchema = z
  .object({
    publicUrl: z
      .string()
      .trim()
      .url()
      .refine(
        (value) => {
          const protocol = new URL(value).protocol;
          return protocol === "http:" || protocol === "https:";
        },
        { message: "publicUrl must be an HTTP(S) URL" },
      )
      .optional(),
    routes: z.record(z.string().trim().min(1), webhookRouteConfigSchema).default({}),
  })
  .strict();

export type WebhookSecretInput = z.infer<typeof secretInputSchema>;

export type ConfiguredWebhookAuth =
  | {
      mode: "bearer";
      secret: WebhookSecretInput;
      prefix: string;
      legacySharedHeader?: boolean;
    }
  | {
      mode: "header";
      secret: WebhookSecretInput;
      header: string;
      prefix?: string;
    }
  | {
      mode: "hmac-sha256";
      secret: WebhookSecretInput;
      header: string;
      prefix?: string;
    };

export type ConfiguredWebhookEventConfig = {
  header?: string;
  payloadPath?: string;
};

export type ConfiguredWebhookIdempotencyConfig = {
  header?: string;
  payloadPath?: string;
  ttlMs: number;
};

export type ConfiguredWebhookVerificationConfig = {
  event?: string;
  challengePath: string;
  responsePath: string;
};

export type ConfiguredWebhookTaskFlowTemplateConfig = {
  goalTemplate?: string;
  currentStep?: string | null;
  status?: "queued" | "running" | "waiting" | "blocked";
  notifyPolicy?: "done_only" | "state_changes" | "silent";
  runTask?: {
    enabled: boolean;
    runtime: "acp";
    taskTemplate?: string;
    sourceId?: string;
    childSessionKey?: string;
    parentTaskId?: string;
    agentId?: string;
    runIdTemplate?: string;
    labelTemplate?: string;
    notifyPolicy?: "done_only" | "state_changes" | "silent";
    status?: "queued" | "running";
    preferMetadata?: boolean;
  };
};

export type ConfiguredWebhookAgentDispatchConfig = {
  messageTemplate?: string;
  deliveryMode: "announce" | "none";
  delayMs: number;
  nameTemplate?: string;
  tagTemplate?: string;
  agentId?: string;
  onCompletion?: {
    delivery: ConfiguredWebhookDeliveryConfig;
  };
};

export type ConfiguredWebhookDeliveryConfig =
  | {
      mode: "log";
    }
  | {
      mode: "channel";
      channel: string;
      to?: string;
      textTemplate?: string;
      accountId?: string;
      threadId?: string | number;
      silent?: boolean;
    }
  | {
      mode: "exec";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
      textTemplate?: string;
      timeoutMs?: number;
    };

type ConfiguredWebhookRouteBase = {
  routeId: string;
  path: string;
  auth: ConfiguredWebhookAuth;
  events?: string[];
  event: ConfiguredWebhookEventConfig;
  idempotency?: ConfiguredWebhookIdempotencyConfig;
  verification?: ConfiguredWebhookVerificationConfig;
  prompt?: string;
  skills?: string[];
  description?: string;
};

export type ConfiguredTaskFlowWebhookRouteConfig = ConfiguredWebhookRouteBase & {
  dispatchMode: "taskflow";
  sessionKey: string;
  secret: WebhookSecretInput;
  controllerId: string;
  taskflow?: ConfiguredWebhookTaskFlowTemplateConfig;
};

export type ConfiguredAgentWebhookRouteConfig = ConfiguredWebhookRouteBase & {
  dispatchMode: "agent";
  sessionKey: string;
  agent: ConfiguredWebhookAgentDispatchConfig;
};

export type ConfiguredDeliverWebhookRouteConfig = ConfiguredWebhookRouteBase & {
  dispatchMode: "deliver";
  delivery: ConfiguredWebhookDeliveryConfig;
};

export type ConfiguredAckWebhookRouteConfig = ConfiguredWebhookRouteBase & {
  dispatchMode: "ack";
};

export type ConfiguredWebhookRouteConfig =
  | ConfiguredTaskFlowWebhookRouteConfig
  | ConfiguredAgentWebhookRouteConfig
  | ConfiguredDeliverWebhookRouteConfig
  | ConfiguredAckWebhookRouteConfig;

export type ConfiguredWebhooksPluginConfig = {
  publicUrl?: string;
  routes: ConfiguredWebhookRouteConfig[];
};

function resolveRawDispatchMode(route: {
  dispatch: {
    mode: "ack" | "taskflow" | "agent" | "deliver";
  };
  deliverOnly?: boolean;
  deliver_only?: boolean;
}): "ack" | "taskflow" | "agent" | "deliver" {
  if (route.deliverOnly === true || route.deliver_only === true) {
    return "deliver";
  }
  return route.dispatch.mode;
}

function normalizeAuth(route: RawWebhookRouteConfig): ConfiguredWebhookAuth {
  if (!route.auth) {
    return {
      mode: "bearer",
      secret: route.secret as WebhookSecretInput,
      prefix: "Bearer",
      legacySharedHeader: true,
    };
  }
  if (route.auth.mode === "bearer") {
    return {
      mode: "bearer",
      secret: route.auth.secret,
      prefix: route.auth.prefix?.trim() || "Bearer",
    };
  }
  return {
    mode: route.auth.mode,
    secret: route.auth.secret,
    header: route.auth.header as string,
    ...(route.auth.prefix !== undefined ? { prefix: route.auth.prefix.trim() } : {}),
  };
}

function normalizeStringTemplate(value: string | number | boolean | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return String(value).trim() || undefined;
}

function normalizeVerificationConfig(
  route: RawWebhookRouteConfig,
): ConfiguredWebhookVerificationConfig | undefined {
  if (!route.verification) {
    return undefined;
  }
  return {
    ...(route.verification.event ? { event: route.verification.event } : {}),
    challengePath: route.verification.challengePath ?? "challenge",
    responsePath: route.verification.responsePath ?? "challenge",
  };
}

function normalizeDeliveryConfigFromInput(
  routeId: string,
  raw: z.infer<typeof webhookDeliveryConfigSchema> | undefined,
  extra: z.infer<typeof webhookDeliveryExtraConfigSchema> = {},
): ConfiguredWebhookDeliveryConfig | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw === "string") {
    const channel = raw.trim();
    if (channel === "log") {
      return { mode: "log" };
    }
    const to =
      normalizeStringTemplate(extra.chat_id) ??
      normalizeStringTemplate(extra.chatId) ??
      normalizeStringTemplate(extra.to);
    const accountId =
      normalizeStringTemplate(extra.account_id) ?? normalizeStringTemplate(extra.accountId);
    const threadId =
      normalizeStringTemplate(extra.message_thread_id) ??
      normalizeStringTemplate(extra.thread_id) ??
      normalizeStringTemplate(extra.thread) ??
      normalizeStringTemplate(extra.threadId);
    return {
      mode: "channel",
      channel,
      ...(to ? { to } : {}),
      ...(accountId ? { accountId } : {}),
      ...(threadId ? { threadId } : {}),
      ...(typeof extra.silent === "boolean" ? { silent: extra.silent } : {}),
    };
  }
  if (raw.mode === "exec") {
    return {
      mode: "exec",
      command: raw.command,
      ...(raw.args ? { args: raw.args } : {}),
      ...(raw.env ? { env: raw.env } : {}),
      ...(raw.cwd ? { cwd: raw.cwd } : {}),
      ...(raw.textTemplate ? { textTemplate: raw.textTemplate } : {}),
      ...(raw.timeoutMs ? { timeoutMs: raw.timeoutMs } : {}),
    };
  }
  const mode = raw.mode ?? (raw.channel ? "channel" : undefined);
  if (!mode) {
    throw new Error(
      `webhooks.routes.${routeId}.deliver requires mode "log" or a channel for delivery.`,
    );
  }
  if (mode === "log") {
    return { mode: "log" };
  }
  if (!raw.channel) {
    throw new Error(`webhooks.routes.${routeId}.deliver requires channel for channel delivery.`);
  }
  return {
    mode: "channel",
    channel: raw.channel,
    ...(raw.to
      ? { to: raw.to }
      : (() => {
          const to =
            normalizeStringTemplate(extra.chat_id) ??
            normalizeStringTemplate(extra.chatId) ??
            normalizeStringTemplate(extra.to);
          return to ? { to } : {};
        })()),
    ...(raw.textTemplate ? { textTemplate: raw.textTemplate } : {}),
    ...(raw.accountId
      ? { accountId: raw.accountId }
      : (() => {
          const accountId =
            normalizeStringTemplate(extra.account_id) ?? normalizeStringTemplate(extra.accountId);
          return accountId ? { accountId } : {};
        })()),
    ...(raw.threadId !== undefined
      ? { threadId: raw.threadId }
      : (() => {
          const threadId =
            normalizeStringTemplate(extra.message_thread_id) ??
            normalizeStringTemplate(extra.thread_id) ??
            normalizeStringTemplate(extra.thread) ??
            normalizeStringTemplate(extra.threadId);
          return threadId ? { threadId } : {};
        })()),
    ...(raw.silent !== undefined
      ? { silent: raw.silent }
      : typeof extra.silent === "boolean"
        ? { silent: extra.silent }
        : {}),
  };
}

function normalizeDeliveryConfig(
  routeId: string,
  route: RawWebhookRouteConfig,
): ConfiguredWebhookDeliveryConfig | undefined {
  return normalizeDeliveryConfigFromInput(
    routeId,
    route.deliver,
    route.deliverExtra ?? route.deliver_extra ?? {},
  );
}

function normalizeTaskFlowTemplateConfig(
  route: RawWebhookRouteConfig,
): ConfiguredWebhookTaskFlowTemplateConfig | undefined {
  const raw = route.dispatch.taskflow;
  if (!raw && !route.prompt) {
    return undefined;
  }
  return {
    ...(raw?.goalTemplate ? { goalTemplate: raw.goalTemplate } : {}),
    ...(raw?.currentStep !== undefined ? { currentStep: raw.currentStep } : {}),
    ...(raw?.status ? { status: raw.status } : {}),
    ...(raw?.notifyPolicy ? { notifyPolicy: raw.notifyPolicy } : {}),
    ...(raw?.runTask
      ? {
          runTask: {
            enabled: raw.runTask.enabled ?? true,
            runtime: raw.runTask.runtime ?? "acp",
            ...(raw.runTask.taskTemplate ? { taskTemplate: raw.runTask.taskTemplate } : {}),
            ...(raw.runTask.sourceId ? { sourceId: raw.runTask.sourceId } : {}),
            ...(raw.runTask.childSessionKey
              ? { childSessionKey: raw.runTask.childSessionKey }
              : {}),
            ...(raw.runTask.parentTaskId ? { parentTaskId: raw.runTask.parentTaskId } : {}),
            ...(raw.runTask.agentId ? { agentId: raw.runTask.agentId } : {}),
            ...(raw.runTask.runIdTemplate ? { runIdTemplate: raw.runTask.runIdTemplate } : {}),
            ...(raw.runTask.labelTemplate ? { labelTemplate: raw.runTask.labelTemplate } : {}),
            ...(raw.runTask.notifyPolicy ? { notifyPolicy: raw.runTask.notifyPolicy } : {}),
            ...(raw.runTask.status ? { status: raw.runTask.status } : {}),
            ...(raw.runTask.preferMetadata !== undefined
              ? { preferMetadata: raw.runTask.preferMetadata }
              : {}),
          },
        }
      : {}),
  };
}

function normalizeAgentDispatchConfig(
  route: RawWebhookRouteConfig,
  routeId: string,
): ConfiguredWebhookAgentDispatchConfig {
  const raw = route.dispatch.agent;
  const completionDelivery = normalizeDeliveryConfigFromInput(routeId, raw?.onCompletion?.deliver);
  return {
    ...(raw?.messageTemplate ? { messageTemplate: raw.messageTemplate } : {}),
    deliveryMode: raw?.deliveryMode ?? "announce",
    delayMs: raw?.delayMs ?? 1,
    ...(raw?.nameTemplate ? { nameTemplate: raw.nameTemplate } : {}),
    ...(raw?.tagTemplate ? { tagTemplate: raw.tagTemplate } : {}),
    ...(raw?.agentId ? { agentId: raw.agentId } : {}),
    ...(completionDelivery ? { onCompletion: { delivery: completionDelivery } } : {}),
  };
}

export function resolveWebhooksPluginConfig(params: {
  pluginConfig: unknown;
}): ConfiguredWebhookRouteConfig[] {
  const parsed = webhooksPluginConfigSchema.parse(params.pluginConfig ?? {});
  const configuredRoutes: ConfiguredWebhookRouteConfig[] = [];

  for (const [routeId, route] of Object.entries(parsed.routes)) {
    if (!route.enabled) {
      continue;
    }
    const path = normalizeWebhookPath(route.path ?? `/plugins/webhooks/${routeId}`);
    const base = {
      routeId,
      path,
      auth: normalizeAuth(route),
      ...(route.events?.length ? { events: [...route.events] } : {}),
      event: {
        ...(route.event.header ? { header: route.event.header } : {}),
        ...(route.event.payloadPath ? { payloadPath: route.event.payloadPath } : {}),
      },
      ...(route.idempotency
        ? {
            idempotency: {
              ...(route.idempotency.header ? { header: route.idempotency.header } : {}),
              ...(route.idempotency.payloadPath
                ? { payloadPath: route.idempotency.payloadPath }
                : {}),
              ttlMs: Math.floor((route.idempotency.ttlHours ?? 24) * 60 * 60 * 1000),
            },
          }
        : {}),
      ...(route.verification ? { verification: normalizeVerificationConfig(route) } : {}),
      ...(route.description ? { description: route.description } : {}),
      ...(route.prompt ? { prompt: route.prompt } : {}),
      ...(route.skills?.length ? { skills: [...route.skills] } : {}),
    } satisfies ConfiguredWebhookRouteBase;

    const dispatchMode = resolveRawDispatchMode(route);

    if (dispatchMode === "ack") {
      configuredRoutes.push({
        ...base,
        dispatchMode: "ack",
      });
      continue;
    }

    if (dispatchMode === "deliver") {
      const delivery = normalizeDeliveryConfig(routeId, route);
      if (!delivery) {
        throw new Error(`webhooks.routes.${routeId}.deliver is required for deliver dispatch.`);
      }
      configuredRoutes.push({
        ...base,
        dispatchMode: "deliver",
        delivery,
      });
      continue;
    }

    if (dispatchMode === "agent") {
      configuredRoutes.push({
        ...base,
        dispatchMode: "agent",
        sessionKey: route.sessionKey as string,
        agent: normalizeAgentDispatchConfig(route, routeId),
      });
      continue;
    }

    const taskflow = normalizeTaskFlowTemplateConfig(route);
    configuredRoutes.push({
      ...base,
      dispatchMode: "taskflow",
      sessionKey: route.sessionKey as string,
      secret: (route.secret ?? route.auth?.secret) as WebhookSecretInput,
      controllerId: route.controllerId ?? `webhooks/${routeId}`,
      ...(taskflow ? { taskflow } : {}),
    });
  }

  return configuredRoutes;
}

export function resolveWebhooksPluginRuntimeConfig(params: {
  pluginConfig: unknown;
}): ConfiguredWebhooksPluginConfig {
  const parsed = webhooksPluginConfigSchema.parse(params.pluginConfig ?? {});
  return {
    ...(parsed.publicUrl ? { publicUrl: parsed.publicUrl } : {}),
    routes: resolveWebhooksPluginConfig(params),
  };
}

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
    mode: z.enum(["ack", "taskflow"]).default("taskflow"),
  })
  .strict()
  .default({ mode: "taskflow" });

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
    controllerId: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const dispatchMode = value.dispatch.mode;
    if (dispatchMode === "taskflow" && !value.sessionKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sessionKey is required for taskflow dispatch",
        path: ["sessionKey"],
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

const webhooksPluginConfigSchema = z
  .object({
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

type ConfiguredWebhookRouteBase = {
  routeId: string;
  path: string;
  auth: ConfiguredWebhookAuth;
  events?: string[];
  event: ConfiguredWebhookEventConfig;
  idempotency?: ConfiguredWebhookIdempotencyConfig;
  description?: string;
};

export type ConfiguredTaskFlowWebhookRouteConfig = ConfiguredWebhookRouteBase & {
  dispatchMode: "taskflow";
  sessionKey: string;
  secret: WebhookSecretInput;
  controllerId: string;
};

export type ConfiguredAckWebhookRouteConfig = ConfiguredWebhookRouteBase & {
  dispatchMode: "ack";
};

export type ConfiguredWebhookRouteConfig =
  | ConfiguredTaskFlowWebhookRouteConfig
  | ConfiguredAckWebhookRouteConfig;

function normalizeAuth(
  route: z.infer<typeof webhookRouteConfigSchema>,
): ConfiguredWebhookAuth {
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

export function resolveWebhooksPluginConfig(params: {
  pluginConfig: unknown;
}): ConfiguredWebhookRouteConfig[] {
  const parsed = webhooksPluginConfigSchema.parse(params.pluginConfig ?? {});
  const configuredRoutes: ConfiguredWebhookRouteConfig[] = [];
  const seenPaths = new Map<string, string>();

  for (const [routeId, route] of Object.entries(parsed.routes)) {
    if (!route.enabled) {
      continue;
    }
    const path = normalizeWebhookPath(route.path ?? `/plugins/webhooks/${routeId}`);
    const existingRouteId = seenPaths.get(path);
    if (existingRouteId) {
      throw new Error(
        `webhooks.routes.${routeId}.path conflicts with routes.${existingRouteId}.path (${path}).`,
      );
    }

    seenPaths.set(path, routeId);
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
      ...(route.description ? { description: route.description } : {}),
    } satisfies ConfiguredWebhookRouteBase;

    if (route.dispatch.mode === "ack") {
      configuredRoutes.push({
        ...base,
        dispatchMode: "ack",
      });
      continue;
    }

    configuredRoutes.push({
      ...base,
      dispatchMode: "taskflow",
      sessionKey: route.sessionKey as string,
      secret: (route.secret ?? route.auth?.secret) as WebhookSecretInput,
      controllerId: route.controllerId ?? `webhooks/${routeId}`,
    });
  }

  return configuredRoutes;
}

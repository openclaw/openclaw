import { spawn } from "node:child_process";
import type { PluginRuntime } from "../api.js";
import type { OpenClawConfig } from "../runtime-api.js";
import type { ConfiguredWebhookDeliveryConfig } from "./config.js";
import type { DeliverWebhookTarget, WebhookLogger } from "./http.js";
import {
  buildDefaultWebhookPrompt,
  renderOptionalTemplate,
  renderTemplate,
  type WebhookDispatchContext,
} from "./template.js";

type LoadChannelOutboundAdapter = PluginRuntime["channel"]["outbound"]["loadAdapter"];

function renderDeliveryField(
  value: string | number | undefined,
  context: WebhookDispatchContext,
): string | number | undefined {
  if (typeof value === "string") {
    return renderTemplate(value, context).trim();
  }
  return value;
}

function renderExecArgs(
  args: readonly string[] | undefined,
  context: WebhookDispatchContext,
): string[] {
  return (args ?? []).map((arg) => renderTemplate(arg, context));
}

function renderExecEnv(
  env: Record<string, string> | undefined,
  context: WebhookDispatchContext,
): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [key, renderTemplate(value, context)]),
  );
}

async function runExecDelivery(params: {
  delivery: Extract<ConfiguredWebhookDeliveryConfig, { mode: "exec" }>;
  context: WebhookDispatchContext;
  text: string;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const args = renderExecArgs(params.delivery.args, params.context);
  const env = renderExecEnv(params.delivery.env, params.context);
  const timeoutMs = params.delivery.timeoutMs ?? 30_000;
  return await new Promise((resolve, reject) => {
    const child = spawn(params.delivery.command, args, {
      cwd: params.delivery.cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`exec delivery timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
    child.stdin.end(params.text);
  });
}

export async function executeDeliveryDispatch(params: {
  target: DeliverWebhookTarget;
  context: WebhookDispatchContext;
  loadChannelOutboundAdapter?: LoadChannelOutboundAdapter;
  logger?: WebhookLogger;
  cfg: OpenClawConfig;
}): Promise<{ statusCode: number; body: unknown }> {
  const { target, context } = params;
  const defaultText =
    renderOptionalTemplate(target.prompt, context) ?? buildDefaultWebhookPrompt(context);
  if (target.delivery.mode === "log") {
    params.logger?.info?.("[webhooks] delivery event", {
      routeId: target.routeId,
      eventType: context.eventType,
      idempotencyKey: context.idempotencyKey,
      text: defaultText,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        routeId: target.routeId,
        result: {
          action: "deliver",
          mode: "log",
          ...(context.eventType ? { eventType: context.eventType } : {}),
          ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
        },
      },
    };
  }

  if (target.delivery.mode === "exec") {
    const text =
      renderOptionalTemplate(target.delivery.textTemplate, context) ??
      renderOptionalTemplate(target.prompt, context) ??
      buildDefaultWebhookPrompt(context);
    const result = await runExecDelivery({
      delivery: target.delivery,
      context,
      text,
    });
    if (result.exitCode !== 0) {
      return {
        statusCode: 502,
        body: {
          ok: false,
          routeId: target.routeId,
          code: "exec_delivery_failed",
          error: `exec delivery exited ${String(result.exitCode ?? result.signal ?? "unknown")}`,
        },
      };
    }
    params.logger?.info?.("[webhooks] exec delivery completed", {
      routeId: target.routeId,
      eventType: context.eventType,
      idempotencyKey: context.idempotencyKey,
    });
    return {
      statusCode: 200,
      body: {
        ok: true,
        routeId: target.routeId,
        result: {
          action: "deliver",
          mode: "exec",
          ...(context.eventType ? { eventType: context.eventType } : {}),
          ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
        },
      },
    };
  }

  const loadAdapter = params.loadChannelOutboundAdapter;
  if (!loadAdapter) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "delivery_unavailable",
        error: "Channel delivery is unavailable in this Gateway runtime.",
      },
    };
  }
  const adapter = await loadAdapter(target.delivery.channel);
  if (!adapter?.sendText) {
    return {
      statusCode: 503,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "channel_unavailable",
        error: `Channel ${target.delivery.channel} is not available for text delivery.`,
      },
    };
  }
  const deliveryTo = renderDeliveryField(target.delivery.to, context);
  const deliveryAccountId = renderDeliveryField(target.delivery.accountId, context);
  const deliveryThreadId = renderDeliveryField(target.delivery.threadId, context);
  const normalizedDeliveryTo =
    typeof deliveryTo === "string" && deliveryTo.trim() ? deliveryTo.trim() : undefined;
  if (!normalizedDeliveryTo && !adapter.resolveTarget) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "invalid_delivery_target",
        error:
          "Delivery target is required because the channel does not provide default target resolution.",
      },
    };
  }
  const resolvedTarget = adapter.resolveTarget?.({
    cfg: params.cfg,
    ...(normalizedDeliveryTo ? { to: normalizedDeliveryTo } : {}),
    ...(typeof deliveryAccountId === "string" && deliveryAccountId.trim()
      ? { accountId: deliveryAccountId }
      : {}),
    mode: "explicit",
  });
  if (resolvedTarget?.ok === false) {
    return {
      statusCode: 400,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "invalid_delivery_target",
        error: resolvedTarget.error.message,
      },
    };
  }
  const text =
    renderOptionalTemplate(target.delivery.textTemplate, context) ??
    renderOptionalTemplate(target.prompt, context) ??
    buildDefaultWebhookPrompt(context);
  let result;
  try {
    const outboundTo = resolvedTarget?.ok === true ? resolvedTarget.to : normalizedDeliveryTo;
    if (!outboundTo) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          routeId: target.routeId,
          code: "invalid_delivery_target",
          error: "Delivery target resolved to an empty value.",
        },
      };
    }
    result = await adapter.sendText({
      cfg: params.cfg,
      to: outboundTo,
      text,
      ...(typeof deliveryAccountId === "string" && deliveryAccountId.trim()
        ? { accountId: deliveryAccountId }
        : {}),
      ...(deliveryThreadId !== undefined && deliveryThreadId !== ""
        ? { threadId: deliveryThreadId }
        : {}),
      ...(target.delivery.silent !== undefined ? { silent: target.delivery.silent } : {}),
    });
  } catch (error) {
    return {
      statusCode: 502,
      body: {
        ok: false,
        routeId: target.routeId,
        code: "delivery_failed",
        error: error instanceof Error ? error.message : "Channel delivery failed.",
      },
    };
  }
  return {
    statusCode: 200,
    body: {
      ok: true,
      routeId: target.routeId,
      result: {
        action: "deliver",
        mode: "channel",
        channel: result.channel ?? target.delivery.channel,
        messageId: result.messageId,
        ...(context.eventType ? { eventType: context.eventType } : {}),
        ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
      },
    },
  };
}

export async function deliverWebhookCompletion(params: {
  routeId: string;
  delivery: ConfiguredWebhookDeliveryConfig;
  context: WebhookDispatchContext;
  completionText: string;
  loadChannelOutboundAdapter?: LoadChannelOutboundAdapter;
  logger?: WebhookLogger;
  cfg: OpenClawConfig;
}): Promise<void> {
  const completionText = params.completionText.trim();
  if (!completionText) {
    return;
  }
  const result = await executeDeliveryDispatch({
    target: {
      routeId: params.routeId,
      path: "",
      dispatchMode: "deliver",
      auth: { mode: "bearer", secret: "unused", prefix: "Bearer" },
      delivery: params.delivery,
    },
    context: {
      ...params.context,
      completionText,
    },
    loadChannelOutboundAdapter: params.loadChannelOutboundAdapter,
    logger: params.logger,
    cfg: params.cfg,
  });
  if (result.statusCode >= 400) {
    throw new Error(
      `webhook completion delivery failed for ${params.routeId}: ${String(
        (result.body as { error?: unknown }).error ?? result.statusCode,
      )}`,
    );
  }
}

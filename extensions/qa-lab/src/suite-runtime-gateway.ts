import { setTimeout as sleep } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { writeGatewayRestartIntentSync } from "openclaw/plugin-sdk/qa-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord as isPlainObject } from "openclaw/plugin-sdk/string-coerce-runtime";
import { QaSuiteInfraError } from "./errors.js";
import { discardIgnoredResponseBody } from "./ignored-response-body.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { waitForQaHttpReady } from "./suite-http-readiness.js";
import { applyQaMergePatch } from "./suite-merge-patch.js";
import type { QaConfigSnapshot, QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

type QaGatewayMutationEnv = Pick<
  QaSuiteRuntimeEnv,
  "gateway" | "transport" | "providerMode" | "primaryModel" | "alternateModel"
>;

const QA_SUITE_FETCH_JSON_TIMEOUT_MS = 15_000;

async function fetchJson<T>(url: string, timeoutMs = QA_SUITE_FETCH_JSON_TIMEOUT_MS): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    policy: { allowPrivateNetwork: true },
    timeoutMs,
    auditContext: "qa-lab-suite-fetch-json",
  });
  try {
    if (!response.ok) {
      await discardIgnoredResponseBody(response);
      throw new Error(`request failed ${response.status}: ${url}`);
    }
    return await readProviderJsonResponse<T>(response, "qa-lab-suite-fetch-json");
  } finally {
    await release();
  }
}

async function waitForGatewayHealthy(env: Pick<QaSuiteRuntimeEnv, "gateway">, timeoutMs = 45_000) {
  const ready = await waitForQaHttpReady(
    `${env.gateway.baseUrl}/readyz`,
    timeoutMs,
    250,
    "qa-lab-suite-wait-for-gateway-healthy",
  );
  if (!ready) {
    throw new QaSuiteInfraError("gateway_ready_timeout", `timed out after ${timeoutMs}ms`);
  }
}

async function waitForTransportReady(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
  timeoutMs = 45_000,
) {
  try {
    await env.transport.waitReady({
      gateway: env.gateway,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof QaSuiteInfraError) {
      throw error;
    }
    throw new QaSuiteInfraError(
      "transport_ready_timeout",
      `transport did not become ready: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
}

async function waitForConfigRestartSettle(
  env: Pick<QaSuiteRuntimeEnv, "gateway" | "transport">,
  restartDelayMs = 1_000,
  timeoutMs = 60_000,
  settleBufferMs = 750,
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const readyAfterMs = restartDelayMs + settleBufferMs;
  let lastHealthError: unknown = null;

  // A delay beyond this mutation's observation window intentionally keeps the
  // current process alive so scenarios can prove config reads without restart.
  if (restartDelayMs >= timeoutMs) {
    await waitForGatewayHealthy(env, timeoutMs);
    await waitForTransportReady(env, timeoutMs);
    return;
  }

  while (Date.now() < deadline) {
    try {
      await waitForGatewayHealthy(env, Math.max(1, Math.min(1_000, deadline - Date.now())));
      if (Date.now() - startedAt >= readyAfterMs) {
        const remainingMs = Math.max(1, deadline - Date.now());
        await waitForTransportReady(env, remainingMs);
        return;
      }
    } catch (error) {
      lastHealthError = error;
    }
    await sleep(Math.min(250, Math.max(1, deadline - Date.now())));
  }

  throw new QaSuiteInfraError(
    "transport_ready_timeout",
    `timed out after ${timeoutMs}ms waiting for config restart readiness${
      lastHealthError ? `: ${formatErrorMessage(lastHealthError)}` : ""
    }`,
  );
}

function withoutQaConfigApplyVolatileFields(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const comparable = structuredClone(config);
  // config.apply updates root metadata on write; metadata alone needs no restart.
  delete comparable.meta;
  return comparable;
}

function isConfigMutationNoopForSnapshot(
  action: "config.patch" | "config.apply",
  config: Record<string, unknown>,
  raw: string,
) {
  let nextConfig: unknown;
  try {
    nextConfig = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isPlainObject(nextConfig)) {
    return false;
  }
  return action === "config.patch"
    ? isDeepStrictEqual(applyQaMergePatch(config, nextConfig), config)
    : isDeepStrictEqual(
        withoutQaConfigApplyVolatileFields(config),
        withoutQaConfigApplyVolatileFields(nextConfig),
      );
}

async function readConfigSnapshot(env: Pick<QaSuiteRuntimeEnv, "gateway">) {
  const snapshot = (await env.gateway.call(
    "config.get",
    {},
    { timeoutMs: 60_000 },
  )) as QaConfigSnapshot;
  if (!snapshot.hash || !snapshot.config) {
    throw new Error("config.get returned no hash/config");
  }
  return {
    hash: snapshot.hash,
    config: snapshot.config,
  } satisfies { hash: string; config: Record<string, unknown> };
}

async function runConfigMutation(params: {
  env: QaGatewayMutationEnv;
  action: "config.patch" | "config.apply";
  raw: string;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  note?: string;
  restartDelayMs?: number;
  restartSettleBufferMs?: number;
  replacePaths?: readonly string[];
  skipRestartDeferral?: boolean;
}) {
  const restartDelayMs = params.restartDelayMs ?? 1_000;
  const timeoutMs = resolveQaLiveTurnTimeoutMs(params.env, 180_000);
  // The suite owns config writes. Conflicts or interrupted replies fail this run.
  const snapshot = await readConfigSnapshot(params.env);
  if (
    isConfigMutationNoopForSnapshot(params.action, snapshot.config, params.raw) &&
    params.skipRestartDeferral !== true
  ) {
    // QA scenarios do best-effort cleanup in finally blocks. Skipping
    // client-known no-op patches keeps that cleanup from burning the
    // control-plane write budget and making later capability checks flaky.
    return { ok: true, noop: true };
  }
  let restartTargetPid: number | undefined;
  if (params.skipRestartDeferral === true) {
    const systemInfo = await params.env.gateway.call("system.info", {}, { timeoutMs });
    const targetPid =
      typeof systemInfo === "object" && systemInfo !== null
        ? (systemInfo as { pid?: unknown }).pid
        : undefined;
    if (typeof targetPid !== "number" || !Number.isSafeInteger(targetPid) || targetPid <= 0) {
      throw new Error("qa gateway restart returned an invalid active process id");
    }
    restartTargetPid = targetPid;
  }
  const result = await params.env.gateway.call(
    params.action,
    {
      raw: params.raw,
      baseHash: snapshot.hash,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      ...(params.note ? { note: params.note } : {}),
      restartDelayMs,
      ...(params.replacePaths?.length ? { replacePaths: params.replacePaths } : {}),
    },
    { timeoutMs },
  );
  if (params.skipRestartDeferral === true) {
    if (
      !writeGatewayRestartIntentSync({
        env: params.env.gateway.runtimeEnv,
        targetPid: restartTargetPid,
        reason: "config.patch",
        // QA checkpoints must be interrupted, not allowed to finish a graceful drain.
        intent: { force: true, waitMs: 0 },
      })
    ) {
      throw new Error("qa gateway could not persist a forced restart intent");
    }
    await params.env.gateway.call(
      "gateway.restart.request",
      { reason: "config.patch", skipDeferral: true },
      { timeoutMs },
    );
  }
  await waitForConfigRestartSettle(
    params.env,
    restartDelayMs,
    timeoutMs,
    params.restartSettleBufferMs,
  );
  return result;
}

async function patchConfig(
  params: Omit<Parameters<typeof runConfigMutation>[0], "action" | "raw"> & {
    patch: Record<string, unknown>;
  },
) {
  return await runConfigMutation({
    ...params,
    action: "config.patch",
    raw: JSON.stringify(params.patch, null, 2),
  });
}

async function applyConfig(
  params: Omit<
    Parameters<typeof runConfigMutation>[0],
    "action" | "raw" | "restartSettleBufferMs" | "replacePaths" | "skipRestartDeferral"
  > & { nextConfig: Record<string, unknown> },
) {
  return await runConfigMutation({
    env: params.env,
    action: "config.apply",
    raw: JSON.stringify(params.nextConfig, null, 2),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    note: params.note,
    restartDelayMs: params.restartDelayMs,
  });
}

async function restartGatewayWithConfigPatch(params: {
  env: QaGatewayMutationEnv;
  patch: Record<string, unknown>;
}) {
  return await patchConfig({
    env: params.env,
    patch: params.patch,
    replacePaths: ["gateway.controlUi.allowedOrigins"],
    skipRestartDeferral: true,
  });
}

export {
  applyConfig,
  fetchJson,
  patchConfig,
  readConfigSnapshot,
  restartGatewayWithConfigPatch,
  waitForConfigRestartSettle,
  waitForGatewayHealthy,
  waitForTransportReady,
};

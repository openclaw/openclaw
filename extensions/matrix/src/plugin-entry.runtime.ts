import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMatrixAuthContext } from "./matrix/client.js";

type MatrixVerificationRequest = Pick<GatewayRequestHandlerOptions, "params" | "respond"> & {
  context: Pick<GatewayRequestHandlerOptions["context"], "getRuntimeConfig">;
};

const loadMatrixVerificationRuntime = createLazyRuntimeModule(
  () => import("./matrix/actions/verification.js"),
);

function sendError(respond: (ok: boolean, payload?: unknown) => void, err: unknown) {
  respond(false, { error: formatErrorMessage(err) });
}

function respondVerification(
  request: MatrixVerificationRequest,
  result: unknown,
  success: boolean,
) {
  if (request.params.expectedOwnerId !== undefined) {
    const accountId = resolveMatrixAuthContext({
      cfg: request.context.getRuntimeConfig(),
      accountId: normalizeOptionalString(request.params.accountId),
    }).accountId;
    // Owner-routed CLI calls preserve structured failure output and the selected account.
    request.respond(true, { result, accountId });
  } else {
    request.respond(success, result);
  }
}

export async function handleVerifyRecoveryKey({
  params,
  respond,
  context,
}: MatrixVerificationRequest): Promise<void> {
  try {
    const { verifyMatrixRecoveryKey } = await loadMatrixVerificationRuntime();
    const key = normalizeOptionalString(params?.key);
    if (!key) {
      respond(false, { error: "key required" });
      return;
    }
    const accountId = normalizeOptionalString(params?.accountId);
    const result = await verifyMatrixRecoveryKey(key, {
      accountId,
      cfg: context.getRuntimeConfig(),
    });
    respondVerification({ params, respond, context }, result, result.success);
  } catch (err) {
    sendError(respond, err);
  }
}

export async function handleVerificationBootstrap({
  params,
  respond,
  context,
}: MatrixVerificationRequest): Promise<void> {
  try {
    const { bootstrapMatrixVerification } = await loadMatrixVerificationRuntime();
    const accountId = normalizeOptionalString(params?.accountId);
    const recoveryKey = typeof params?.recoveryKey === "string" ? params.recoveryKey : undefined;
    const forceResetCrossSigning = params?.forceResetCrossSigning === true;
    const result = await bootstrapMatrixVerification({
      accountId,
      cfg: context.getRuntimeConfig(),
      recoveryKey,
      forceResetCrossSigning,
    });
    respondVerification({ params, respond, context }, result, result.success);
  } catch (err) {
    sendError(respond, err);
  }
}

export async function handleVerificationStatus({
  params,
  respond,
  context,
}: MatrixVerificationRequest): Promise<void> {
  try {
    const { getMatrixVerificationStatus } = await loadMatrixVerificationRuntime();
    const accountId = normalizeOptionalString(params?.accountId);
    const includeRecoveryKey = params?.includeRecoveryKey === true;
    const status = await getMatrixVerificationStatus({
      accountId,
      includeRecoveryKey,
      ...(params.allowDegradedLocalState === true ? { readiness: "none" as const } : {}),
      cfg: context.getRuntimeConfig(),
    });
    respondVerification({ params, respond, context }, status, true);
  } catch (err) {
    sendError(respond, err);
  }
}

import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type MatrixVerificationRequest = Pick<GatewayRequestHandlerOptions, "params" | "respond"> & {
  context: Pick<GatewayRequestHandlerOptions["context"], "getRuntimeConfig">;
};

const loadMatrixVerificationRuntime = createLazyRuntimeModule(
  () => import("./matrix/actions/verification.js"),
);

function sendError(respond: (ok: boolean, payload?: unknown) => void, err: unknown) {
  respond(false, { error: formatErrorMessage(err) });
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
    respond(result.success, result);
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
    respond(result.success, result);
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
      cfg: context.getRuntimeConfig(),
    });
    respond(true, status);
  } catch (err) {
    sendError(respond, err);
  }
}

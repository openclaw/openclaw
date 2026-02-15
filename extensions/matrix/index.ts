import type { GatewayRequestHandlerOptions, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema, normalizeAccountId } from "openclaw/plugin-sdk";
// Import validation utilities from core gateway protocol
// These are not re-exported in plugin-sdk but are needed for gateway method handlers
import {
  validateMatrixVerifyRecoveryKeyParams,
  validateMatrixVerifyStatusParams,
  formatValidationErrors,
} from "../../src/gateway/protocol/index.js";
import { ErrorCodes, errorShape } from "../../src/gateway/protocol/schema/error-codes.js";
import { matrixPlugin } from "./src/channel.js";
import {
  getMatrixRecoveryKeyHandler,
  getMatrixVerificationStore,
} from "./src/matrix/recovery-key/registry.js";
import { setMatrixRuntime } from "./src/runtime.js";

/**
 * Gateway method registration for Matrix verification.
 *
 * Following OpenClaw's extension pattern (see voice-call extension),
 * Matrix-specific RPC methods are registered here via api.registerGatewayMethod()
 * rather than in src/gateway/server-methods/. This keeps the extension
 * fully self-contained and avoids cross-boundary imports.
 *
 * Methods registered:
 * - matrix.verify.recoveryKey: Verify device using recovery key
 * - matrix.verify.status: Get current verification status
 */

/**
 * Validates and normalizes Matrix account ID.
 * Centralizes account validation logic for consistent error handling.
 *
 * @param accountId - Optional account ID to validate
 * @returns Normalized account ID (defaults to "default" if null/undefined)
 */
function validateMatrixAccount(accountId: string | null | undefined): string {
  const normalized = normalizeAccountId(accountId);
  // Additional validation could be added here if needed in the future
  return normalized;
}

const plugin = {
  id: "matrix",
  name: "Matrix",
  description: "Matrix channel plugin (matrix-js-sdk)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMatrixRuntime(api.runtime);
    api.registerChannel({ plugin: matrixPlugin });

    // Register gateway RPC methods for Matrix recovery key verification
    api.registerGatewayMethod(
      "matrix.verify.recoveryKey",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        // Validate parameters
        if (!validateMatrixVerifyRecoveryKeyParams(params)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid matrix.verify.recoveryKey params: ${formatValidationErrors(validateMatrixVerifyRecoveryKeyParams.errors)}`,
            ),
          );
          return;
        }

        const { key, accountId } = params as { key: string; accountId?: string };

        try {
          // Validate and normalize account ID
          const normalizedAccountId = validateMatrixAccount(accountId);

          // Get RecoveryKeyHandler from registry for specified account
          const handler = getMatrixRecoveryKeyHandler(normalizedAccountId);
          if (!handler) {
            throw new Error(
              `Matrix account '${normalizedAccountId}' not found or E2EE not enabled`,
            );
          }

          // Verify device with recovery key
          const result = await handler.verifyWithRecoveryKey(key);
          respond(true, result);
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          respond(true, {
            success: false,
            error: errorMessage,
            backupRestored: false,
            restoredSessionCount: 0,
          });
        }
      },
    );

    api.registerGatewayMethod(
      "matrix.verify.status",
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        // Validate parameters
        if (!validateMatrixVerifyStatusParams(params)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid matrix.verify.status params: ${formatValidationErrors(validateMatrixVerifyStatusParams.errors)}`,
            ),
          );
          return;
        }

        const { accountId } = params as { accountId?: string };

        try {
          // Validate and normalize account ID
          const normalizedAccountId = validateMatrixAccount(accountId);

          // Get verification store from registry for specified account
          const store = getMatrixVerificationStore(normalizedAccountId);

          if (!store) {
            // Return default "not configured" status if store not found
            respond(true, {
              accountId: normalizedAccountId,
              deviceVerified: false,
              deviceId: null,
              verifiedAt: null,
              configured: false,
            });
            return;
          }

          // Return current verification state with account context
          respond(true, {
            accountId: normalizedAccountId,
            deviceId: store.getDeviceId(),
            deviceVerified: store.isDeviceVerified(),
            verifiedAt: store.getVerifiedAt(),
            keyBackupVersion: store.getKeyBackupVersion(),
            restoredSessionCount: store.getRestoredSessionCount(),
            configured: true,
          });
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          respond(true, {
            accountId: validateMatrixAccount(accountId),
            deviceId: null,
            deviceVerified: false,
            verifiedAt: null,
            keyBackupVersion: null,
            restoredSessionCount: 0,
            configured: false,
            error: errorMessage,
          });
        }
      },
    );
  },
};

export default plugin;

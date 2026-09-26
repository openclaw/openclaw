import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { resolveMatrixAuth } from "./matrix/client.js";
import type { MatrixProbe, probeMatrix } from "./matrix/probe.js";
import type { CoreConfig } from "./types.js";

type SendMessageMatrix = (
  to: string,
  message: string,
  options: { cfg: CoreConfig; accountId?: string },
) => Promise<unknown>;

export function createMatrixProbeAccount(params: {
  resolveMatrixAuth: typeof resolveMatrixAuth;
  probeMatrix: typeof probeMatrix;
}) {
  return async ({
    account,
    timeoutMs,
    cfg,
  }: {
    account: { accountId?: string };
    timeoutMs?: number;
    cfg: unknown;
  }): Promise<MatrixProbe> => {
    try {
      const auth = await params.resolveMatrixAuth({
        cfg: cfg as CoreConfig,
        accountId: account.accountId,
      });
      return await params.probeMatrix({
        homeserver: auth.homeserver,
        accessToken: auth.accessToken,
        userId: auth.userId,
        deviceId: auth.deviceId,
        timeoutMs: timeoutMs ?? 5_000,
        accountId: account.accountId,
        allowPrivateNetwork: auth.allowPrivateNetwork,
        ssrfPolicy: auth.ssrfPolicy,
        dispatcherPolicy: auth.dispatcherPolicy,
      });
    } catch (err) {
      return {
        ok: false,
        error: formatErrorMessage(err),
        elapsedMs: 0,
      };
    }
  };
}

export function createMatrixPairingText(sendMessageMatrix: SendMessageMatrix) {
  return {
    idLabel: "matrixUserId",
    message: PAIRING_APPROVED_MESSAGE,
    normalizeAllowEntry: createPairingPrefixStripper(/^matrix:/i),
    notify: async ({
      id,
      message,
      cfg,
      accountId,
    }: {
      id: string;
      message: string;
      cfg: CoreConfig;
      accountId?: string;
    }) => {
      await sendMessageMatrix(`user:${id}`, message, {
        cfg,
        ...(accountId ? { accountId } : {}),
      });
    },
  };
}

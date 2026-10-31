import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/ssrf-dispatcher";
import {
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveValidatedMatrixHomeserverUrl } from "./client/url-validation.js";
import { resolveMatrixLocalTimeoutMs } from "./sdk/client-support.js";

export type MatrixProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  userId?: string | null;
};

export async function probeMatrix(params: {
  homeserver: string;
  accessToken: string;
  userId?: string;
  deviceId?: string;
  timeoutMs?: number;
  accountId?: string | null;
  allowPrivateNetwork?: boolean;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Promise<MatrixProbe> {
  return await runChannelProbe(
    undefined,
    async () => {
      const result: Omit<MatrixProbe, "elapsedMs"> = {
        ok: false,
        status: null,
        error: null,
      };
      if (!params.homeserver?.trim()) {
        return { ...result, error: "missing homeserver" };
      }
      if (!params.accessToken?.trim()) {
        return { ...result, error: "missing access token" };
      }
      const inputUserId = normalizeOptionalString(params.userId);
      const homeserver = await resolveValidatedMatrixHomeserverUrl(params.homeserver, {
        dangerouslyAllowPrivateNetwork: params.allowPrivateNetwork,
      });
      const { MatrixAuthedHttpClient } = await import("./sdk/http-client.js");
      const client = new MatrixAuthedHttpClient({
        homeserver,
        accessToken: params.accessToken,
        ssrfPolicy:
          params.ssrfPolicy ??
          ssrfPolicyFromDangerouslyAllowPrivateNetwork(params.allowPrivateNetwork),
        dispatcherPolicy: params.dispatcherPolicy,
      });
      const identity = await client.requestJson({
        method: "GET",
        endpoint: "/_matrix/client/v3/account/whoami",
        timeoutMs: resolveMatrixLocalTimeoutMs(params.timeoutMs),
      });
      const userId =
        isRecord(identity) && typeof identity.user_id === "string" ? identity.user_id.trim() : "";
      if (!userId) {
        throw new Error("Matrix whoami did not return user_id");
      }
      if (inputUserId && inputUserId !== userId) {
        return { ...result, error: "Matrix access token user does not match configured userId" };
      }
      return { ...result, ok: true, userId };
    },
    (error) => ({
      ok: false,
      status:
        typeof error === "object" && error && "statusCode" in error
          ? Number((error as { statusCode?: number }).statusCode)
          : null,
      error: formatErrorMessage(error),
    }),
  );
}

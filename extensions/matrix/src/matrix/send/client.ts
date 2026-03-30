import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../accounts.js";
import { withResolvedRuntimeMatrixClient } from "../client-bootstrap.js";
import type { MatrixClient } from "../sdk.js";

const getCore = () => getMatrixRuntime();

export function resolveMediaMaxBytes(
  accountId?: string | null,
  cfg?: CoreConfig,
): number | undefined {
  const resolvedCfg = cfg ?? (getCore().config.loadConfig() as CoreConfig);
  const matrixCfg = resolveMatrixAccountConfig({ cfg: resolvedCfg, accountId });
  const mediaMaxMb = typeof matrixCfg.mediaMaxMb === "number" ? matrixCfg.mediaMaxMb : undefined;
  if (typeof mediaMaxMb === "number") {
    return mediaMaxMb * 1024 * 1024;
  }
  return undefined;
}

export async function withResolvedMatrixClient<T>(
  opts: {
    client?: MatrixClient;
    cfg?: CoreConfig;
    timeoutMs?: number;
    accountId?: string | null;
  },
  run: (client: MatrixClient) => Promise<T>,
): Promise<T> {
  return await withResolvedRuntimeMatrixClient(
    {
      ...opts,
      // One-off outbound sends still need a started client so room encryption
      // state and live crypto sessions are available before sendMessage/sendEvent.
      readiness: "started",
    },
    run,
    // Started one-off send clients should flush sync/crypto state before CLI
    // shutdown paths can tear down the process.
    "persist",
  );
}

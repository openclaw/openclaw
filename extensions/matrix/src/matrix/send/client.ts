import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { CoreConfig } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import type { MatrixRuntimeClientOptions } from "../client-bootstrap.js";
import type { MatrixClient } from "../sdk.js";
import { withMatrixSendCurrentness } from "../sdk/send-currentness.js";

type MatrixControlClientOptions = Omit<MatrixRuntimeClientOptions, "readiness">;

const loadMatrixSendClientRuntime = createLazyRuntimeModule(() => import("../client-bootstrap.js"));

export function resolveMediaMaxBytes(
  accountId?: string | null,
  cfg?: CoreConfig,
): number | undefined {
  if (!cfg) {
    throw new Error(
      "Matrix media limits requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const matrixCfg = resolveMatrixAccountConfig({ cfg, accountId });
  const mediaMaxMb = matrixCfg.mediaMaxMb;
  // Only a positive value is a cap, matching CommonMediaMaxMbSchema. `0` or a negative
  // number would become a literal 0-byte limit that rejects every outbound media send;
  // fall through to the unset path instead. Inbound floors the same field (monitor/index.ts).
  return typeof mediaMaxMb === "number" && mediaMaxMb > 0 ? mediaMaxMb * 1024 * 1024 : undefined;
}

export async function withResolvedMatrixSendClient<T>(
  opts: MatrixControlClientOptions & {
    signal?: AbortSignal;
    assertDirectAdapterHandoff?: () => void;
  },
  run: (client: MatrixClient, abortSignal?: AbortSignal) => Promise<T>,
): Promise<T> {
  return await withResolvedMatrixClient(
    {
      ...opts,
      // One-off outbound sends still need a started client so room encryption
      // state and live crypto sessions are available before sendMessage/sendEvent.
      readiness: "started",
    },
    (client, abortSignal) => {
      if (!opts.signal && !opts.assertDirectAdapterHandoff) {
        return run(client, abortSignal);
      }
      return withMatrixSendCurrentness(
        client,
        () => {
          opts.assertDirectAdapterHandoff?.();
          opts.signal?.throwIfAborted();
          abortSignal?.throwIfAborted();
        },
        () => run(client, abortSignal),
      );
    },
    // Started one-off send clients should flush sync/crypto state before CLI
    // shutdown paths can tear down the process.
    "persist",
  );
}

export async function withResolvedMatrixControlClient<T>(
  opts: MatrixControlClientOptions,
  run: (client: MatrixClient, abortSignal?: AbortSignal) => Promise<T>,
): Promise<T> {
  return await withResolvedMatrixClient(
    {
      ...opts,
      readiness: "none",
    },
    run,
  );
}

async function withResolvedMatrixClient<T>(
  opts: MatrixControlClientOptions & { readiness: "started" | "none" },
  run: (client: MatrixClient, abortSignal?: AbortSignal) => Promise<T>,
  shutdownBehavior?: "persist",
): Promise<T> {
  if (opts.client) {
    return await run(opts.client);
  }
  const { withResolvedRuntimeMatrixClient } = await loadMatrixSendClientRuntime();
  return await withResolvedRuntimeMatrixClient(opts, run, shutdownBehavior);
}

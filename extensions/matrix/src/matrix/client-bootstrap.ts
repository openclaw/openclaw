import { getMatrixRuntime } from "../runtime.js";
import type { CoreConfig } from "../types.js";
import { getActiveMatrixClient } from "./active-client.js";
import { isBunRuntime, resolveMatrixAuthContext, resolveSharedMatrixClient } from "./client.js";
import type { MatrixClient } from "./sdk.js";

type ResolvedRuntimeMatrixClient = {
  client: MatrixClient;
  stopOnDone: boolean;
};

type MatrixRuntimeClientReadiness = "none" | "prepared" | "started";
type ResolvedRuntimeMatrixClientStopMode = "stop" | "persist";

type MatrixResolvedClientHook = (
  client: MatrixClient,
  context: { preparedByDefault: boolean },
) => Promise<void> | void;

async function ensureResolvedClientReadiness(params: {
  client: MatrixClient;
  readiness?: MatrixRuntimeClientReadiness;
  preparedByDefault: boolean;
}): Promise<void> {
  if (params.readiness === "started") {
    await params.client.start();
    return;
  }
  if (params.readiness === "prepared" || (!params.readiness && params.preparedByDefault)) {
    await params.client.prepareForOneOff();
  }
}

function ensureMatrixNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

async function resolveRuntimeMatrixClient(opts: {
  client?: MatrixClient;
  cfg?: CoreConfig;
  timeoutMs?: number;
  accountId?: string | null;
  onResolved?: MatrixResolvedClientHook;
}): Promise<ResolvedRuntimeMatrixClient> {
  ensureMatrixNodeRuntime();
  if (opts.client) {
    await opts.onResolved?.(opts.client, { preparedByDefault: false });
    return { client: opts.client, stopOnDone: false };
  }

  const cfg = opts.cfg ?? (getMatrixRuntime().config.loadConfig() as CoreConfig);
  const authContext = resolveMatrixAuthContext({
    cfg,
    accountId: opts.accountId,
  });
  const active = getActiveMatrixClient(authContext.accountId);
  if (active) {
    await opts.onResolved?.(active, { preparedByDefault: false });
    return { client: active, stopOnDone: false };
  }

  const client = await resolveSharedMatrixClient({
    cfg,
    timeoutMs: opts.timeoutMs,
    accountId: authContext.accountId,
  });
  await opts.onResolved?.(client, { preparedByDefault: true });
  return { client, stopOnDone: false };
}

export async function resolveRuntimeMatrixClientWithReadiness(opts: {
  client?: MatrixClient;
  cfg?: CoreConfig;
  timeoutMs?: number;
  accountId?: string | null;
  readiness?: MatrixRuntimeClientReadiness;
}): Promise<ResolvedRuntimeMatrixClient> {
  return await resolveRuntimeMatrixClient({
    client: opts.client,
    cfg: opts.cfg,
    timeoutMs: opts.timeoutMs,
    accountId: opts.accountId,
    onResolved: async (client, context) => {
      await ensureResolvedClientReadiness({
        client,
        readiness: opts.readiness,
        preparedByDefault: context.preparedByDefault,
      });
    },
  });
}

export async function stopResolvedRuntimeMatrixClient(
  resolved: ResolvedRuntimeMatrixClient,
  mode: ResolvedRuntimeMatrixClientStopMode = "stop",
): Promise<void> {
  if (!resolved.stopOnDone) {
    return;
  }
  if (mode === "persist") {
    await resolved.client.stopAndPersist();
    return;
  }
  resolved.client.stop();
}

export async function withResolvedRuntimeMatrixClient<T>(
  opts: {
    client?: MatrixClient;
    cfg?: CoreConfig;
    timeoutMs?: number;
    accountId?: string | null;
    readiness?: MatrixRuntimeClientReadiness;
  },
  run: (client: MatrixClient) => Promise<T>,
  stopMode: ResolvedRuntimeMatrixClientStopMode = "stop",
): Promise<T> {
  const resolved = await resolveRuntimeMatrixClientWithReadiness(opts);
  try {
    return await run(resolved.client);
  } finally {
    await stopResolvedRuntimeMatrixClient(resolved, stopMode);
  }
}

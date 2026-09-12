// Matrix plugin module implements client behavior.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolveMatrixRoomId } from "../send.js";
import type { MatrixActionClient, MatrixActionClientOpts } from "./types.js";

type MatrixActionClientStopMode = "stop" | "persist" | "discard";

const loadMatrixActionClientRuntime = createLazyRuntimeModule(
  () => import("../client-bootstrap.js"),
);

export async function withResolvedActionClient<T>(
  opts: MatrixActionClientOpts,
  run: (client: MatrixActionClient["client"], abortSignal?: AbortSignal) => Promise<T>,
  mode: MatrixActionClientStopMode = "stop",
): Promise<T> {
  const { withResolvedRuntimeMatrixClient } = await loadMatrixActionClientRuntime();
  return await withResolvedRuntimeMatrixClient(opts, run, mode);
}

export async function withStartedActionClient<T>(
  opts: MatrixActionClientOpts,
  run: (client: MatrixActionClient["client"], abortSignal?: AbortSignal) => Promise<T>,
): Promise<T> {
  return await withResolvedActionClient({ ...opts, readiness: "started" }, run, "persist");
}

export async function withResolvedRoomAction<T>(
  roomId: string,
  opts: MatrixActionClientOpts,
  run: (
    client: MatrixActionClient["client"],
    resolvedRoom: string,
    abortSignal?: AbortSignal,
  ) => Promise<T>,
): Promise<T> {
  return await withResolvedActionClient(opts, async (client, abortSignal) => {
    const resolvedRoom = await resolveMatrixRoomId(client, roomId);
    return await run(client, resolvedRoom, abortSignal);
  });
}

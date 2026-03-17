import { createMatrixClient, isBunRuntime } from "./client.js";
async function probeMatrix(params) {
  const started = Date.now();
  const result = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0
  };
  if (isBunRuntime()) {
    return {
      ...result,
      error: "Matrix probe requires Node (bun runtime not supported)",
      elapsedMs: Date.now() - started
    };
  }
  if (!params.homeserver?.trim()) {
    return {
      ...result,
      error: "missing homeserver",
      elapsedMs: Date.now() - started
    };
  }
  if (!params.accessToken?.trim()) {
    return {
      ...result,
      error: "missing access token",
      elapsedMs: Date.now() - started
    };
  }
  try {
    const client = await createMatrixClient({
      homeserver: params.homeserver,
      userId: params.userId ?? "",
      accessToken: params.accessToken,
      localTimeoutMs: params.timeoutMs
    });
    const userId = await client.getUserId();
    result.ok = true;
    result.userId = userId ?? null;
    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    return {
      ...result,
      status: typeof err === "object" && err && "statusCode" in err ? Number(err.statusCode) : result.status,
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started
    };
  }
}
export {
  probeMatrix
};

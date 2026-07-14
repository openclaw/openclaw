import { normalizeMatrixQaRoute } from "./recording-proxy.js";
// Qa Matrix plugin module probes Matrix substrates through one protocol contract.
import { requestMatrixJson, type MatrixQaFetchLike } from "./request.js";

const MATRIX_QA_DIFFERENTIAL_PROFILE = "matrix-qa-v1";

type MatrixQaProbeStep = {
  errcode?: string;
  id: string;
  method: "GET";
  responseFields: string[];
  route: string;
  status: number;
};

export type MatrixQaDifferentialProbeResult = {
  profile: typeof MATRIX_QA_DIFFERENTIAL_PROFILE;
  steps: MatrixQaProbeStep[];
  sync: {
    continuity: boolean;
    incrementalStatus: number;
    initialStatus: number;
  };
};

function topLevelFields(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.keys(value).toSorted()
    : [];
}

function errcode(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = (value as { errcode?: unknown }).errcode;
  return typeof candidate === "string" ? candidate : undefined;
}

function nextBatch(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = (value as { next_batch?: unknown }).next_batch;
  return typeof candidate === "string" ? candidate : undefined;
}

function userId(value: unknown) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = (value as { user_id?: unknown }).user_id;
  return typeof candidate === "string" ? candidate : undefined;
}

function buildStep(params: {
  body: unknown;
  endpoint: string;
  id: string;
  status: number;
}): MatrixQaProbeStep {
  const code = errcode(params.body);
  return {
    ...(code ? { errcode: code } : {}),
    id: params.id,
    method: "GET",
    responseFields: topLevelFields(params.body),
    route: normalizeMatrixQaRoute(new URL(params.endpoint, "http://matrix.test").pathname),
    status: params.status,
  };
}

export async function runMatrixQaDifferentialProbe(params: {
  accessToken: string;
  baseUrl: string;
  fetchImpl?: MatrixQaFetchLike;
  roomId: string;
  userId: string;
}): Promise<MatrixQaDifferentialProbeResult> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const versions = await requestMatrixJson<Record<string, unknown>>({
    baseUrl: params.baseUrl,
    endpoint: "/_matrix/client/versions",
    fetchImpl,
    method: "GET",
  });
  const whoami = await requestMatrixJson<Record<string, unknown>>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    endpoint: "/_matrix/client/v3/account/whoami",
    fetchImpl,
    method: "GET",
  });
  if (userId(whoami.body) !== params.userId) {
    throw new Error("Matrix differential probe whoami returned an unexpected user_id");
  }
  const initialSync = await requestMatrixJson<Record<string, unknown>>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    endpoint: "/_matrix/client/v3/sync",
    fetchImpl,
    method: "GET",
    query: { timeout: 0 },
  });
  const initialToken = nextBatch(initialSync.body);
  if (!initialToken) {
    throw new Error("Matrix differential probe initial sync did not return next_batch");
  }
  const incrementalSync = await requestMatrixJson<Record<string, unknown>>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    endpoint: "/_matrix/client/v3/sync",
    fetchImpl,
    method: "GET",
    query: { since: initialToken, timeout: 0 },
  });
  const incrementalToken = nextBatch(incrementalSync.body);
  if (!incrementalToken) {
    throw new Error("Matrix differential probe incremental sync did not return next_batch");
  }
  const missingStateEndpoint = `/_matrix/client/v3/rooms/${encodeURIComponent(params.roomId)}/state/org.openclaw.qa.missing/${encodeURIComponent(params.userId)}`;
  const missingState = await requestMatrixJson<Record<string, unknown>>({
    accessToken: params.accessToken,
    baseUrl: params.baseUrl,
    endpoint: missingStateEndpoint,
    fetchImpl,
    method: "GET",
    okStatuses: [404],
  });
  if (errcode(missingState.body) !== "M_NOT_FOUND") {
    throw new Error("Matrix differential probe missing state did not return M_NOT_FOUND");
  }

  return {
    profile: MATRIX_QA_DIFFERENTIAL_PROFILE,
    steps: [
      buildStep({
        body: versions.body,
        endpoint: "/_matrix/client/versions",
        id: "versions",
        status: versions.status,
      }),
      buildStep({
        body: whoami.body,
        endpoint: "/_matrix/client/v3/account/whoami",
        id: "whoami",
        status: whoami.status,
      }),
      buildStep({
        body: initialSync.body,
        endpoint: "/_matrix/client/v3/sync",
        id: "sync-initial",
        status: initialSync.status,
      }),
      buildStep({
        body: incrementalSync.body,
        endpoint: "/_matrix/client/v3/sync",
        id: "sync-incremental",
        status: incrementalSync.status,
      }),
      buildStep({
        body: missingState.body,
        endpoint: missingStateEndpoint,
        id: "missing-state",
        status: missingState.status,
      }),
    ],
    sync: {
      continuity: Boolean(initialToken && incrementalToken),
      incrementalStatus: incrementalSync.status,
      initialStatus: initialSync.status,
    },
  };
}

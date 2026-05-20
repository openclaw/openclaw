import type { GesahniReviewerConfig } from "./config.js";

export type BridgeAuthMode = "read" | "write";
export type BridgeMethod = "GET" | "POST" | "PATCH";

export type BridgeRequestParams = {
  path: string;
  method: BridgeMethod;
  auth: BridgeAuthMode;
  userId: string;
  body?: unknown;
  idempotencyKey?: string;
};

export type BridgeHttpResult =
  | {
      ok: true;
      status: number;
      statusText: string;
      body: unknown;
    }
  | {
      ok: false;
      status: number;
      statusText: string;
      body: unknown;
    };

export type BridgeClient = {
  request: (params: BridgeRequestParams) => Promise<BridgeHttpResult>;
};

function resolveBearerToken(config: GesahniReviewerConfig, auth: BridgeAuthMode): string {
  return auth === "read" ? config.readBridgeToken : config.writeBridgeToken;
}

async function readBridgeBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function createGesahniReviewerClient(params: {
  config: GesahniReviewerConfig;
  fetchImpl?: typeof fetch;
}): BridgeClient {
  const fetchImpl = params.fetchImpl ?? fetch;

  return {
    async request(request) {
      const url = new URL(request.path, `${params.config.baseUrl}/`);
      const headers = new Headers();
      headers.set("Authorization", `Bearer ${resolveBearerToken(params.config, request.auth)}`);
      headers.set("X-User-Id", request.userId);
      if (request.body !== undefined) {
        headers.set("Content-Type", "application/json");
      }
      if (request.idempotencyKey) {
        headers.set("Idempotency-Key", request.idempotencyKey);
      }

      const response = await fetchImpl(url.toString(), {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      const body = await readBridgeBody(response);

      if (response.ok) {
        return {
          ok: true,
          status: response.status,
          statusText: response.statusText,
          body,
        };
      }

      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        body,
      };
    },
  };
}

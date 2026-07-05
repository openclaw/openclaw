/**
 * Test fetch helper that adds no-op preconnect support expected by Browser tests.
 */
type FetchPreconnectOptions = {
  dns?: boolean;
  tcp?: boolean;
  http?: boolean;
  https?: boolean;
};

type FetchWithPreconnect = {
  preconnect: (url: string | URL, options?: FetchPreconnectOptions) => void;
  __openclawAcceptsDispatcher: true;
};

type MockReadableBody = {
  getReader?: () => unknown;
};

type MockResponseRecord = Record<string, unknown> & {
  arrayBuffer?: () => Promise<ArrayBuffer>;
  body?: MockReadableBody | null;
  json?: () => unknown;
  text?: () => Promise<string> | string;
};

function hasReadableBody(response: MockResponseRecord): boolean {
  const { body } = response;
  return typeof body === "object" && body !== null && typeof body.getReader === "function";
}

function normalizeMockResponse<T>(value: T): T {
  if (typeof value !== "object" || value === null || value instanceof Response) {
    return value;
  }

  const response = value as MockResponseRecord;
  if (typeof response.arrayBuffer === "function" || hasReadableBody(response)) {
    return value;
  }

  if (typeof response.text === "function") {
    const readText = response.text;
    response.arrayBuffer = async () => new Response(await readText.call(response)).arrayBuffer();
    return value;
  }

  if (typeof response.json === "function") {
    const readJson = response.json;
    response.arrayBuffer = async () => Response.json(await readJson.call(response)).arrayBuffer();
  }
  return value;
}

/** Adds Browser test preconnect metadata to a fetch-like function. */
export function withBrowserFetchPreconnect<T extends typeof fetch>(fn: T): T & FetchWithPreconnect;
export function withBrowserFetchPreconnect<T extends object>(
  fn: T,
): T & FetchWithPreconnect & typeof fetch;
export function withBrowserFetchPreconnect(fn: object) {
  const wrapped =
    typeof fn === "function"
      ? async (...args: unknown[]) => normalizeMockResponse(await fn(...args))
      : fn;
  if (typeof fn === "function" && typeof (fn as { mock?: unknown }).mock === "object") {
    (wrapped as { mock?: unknown }).mock = (fn as { mock?: unknown }).mock;
  }
  return Object.assign(wrapped, {
    preconnect: (_url: string | URL, _options?: FetchPreconnectOptions) => {},
    __openclawAcceptsDispatcher: true as const,
  });
}

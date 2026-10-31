import { requireFirstPostJsonRecordRequest } from "openclaw/plugin-sdk/test-fixtures";
import { expect } from "vitest";

type RequestMock = Parameters<typeof requireFirstPostJsonRecordRequest>[0];
type BodyExpectation = { body: unknown; multipart?: false } | { multipart: true };
export const baseUrl = "https://api.deepinfra.com/v1/openai";
const transport = {
  provider: "deepinfra",
  transport: "http",
  defaultBaseUrl: baseUrl,
  allowPrivateNetwork: false,
};

export function expectRequestConfig(mock: RequestMock, capability: "audio" | "image") {
  expect(mock).toHaveBeenCalledWith(expect.objectContaining({ ...transport, capability }));
}

export function expectMediaRequest(
  mock: RequestMock,
  expected: { path: string; apiKey: string; timeoutMs?: number } & BodyExpectation,
) {
  expect(mock).toHaveBeenCalledOnce();
  const request = requireFirstPostJsonRecordRequest(mock, `DeepInfra ${expected.path} request`);
  const headers = request.headers;
  if (!(headers instanceof Headers)) {
    throw new Error("Expected request Headers");
  }
  expect(Object.fromEntries(headers)).toEqual({
    authorization: `Bearer ${expected.apiKey}`,
    ...(expected.multipart ? {} : { "content-type": "application/json" }),
  });
  expect(request).toEqual({
    url: `${baseUrl}${expected.path}`,
    headers,
    timeoutMs: expected.timeoutMs,
    body: expected.multipart ? request.body : expected.body,
    fetchFn: fetch,
    allowPrivateNetwork: false,
    dispatcherPolicy: undefined,
  });
  return request;
}

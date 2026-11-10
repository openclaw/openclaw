import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect } from "vitest";
import { createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest, BrowserRouteRegistrar } from "./types.js";

type Handler = Parameters<BrowserRouteRegistrar["get"]>[1];
type Response = ReturnType<typeof createBrowserRouteResponse>;

export function startRoute(handler: Handler | undefined, request: Partial<BrowserRequest>) {
  if (!handler) {
    throw new Error("Missing browser route");
  }
  const response = createBrowserRouteResponse();
  const completion = Promise.resolve(handler({ params: {}, query: {}, ...request }, response.res));
  return { response, completion };
}

export async function runRoute(handler: Handler | undefined, request: Partial<BrowserRequest>) {
  const { response, completion } = startRoute(handler, request);
  await completion;
  return response;
}

export function gate<T = void>() {
  const entered = createDeferred<void>();
  const release = createDeferred<T>();
  return {
    entered: entered.promise,
    enter: entered.resolve,
    promise: release.promise,
    resolve: release.resolve,
    block: async () => {
      entered.resolve();
      return await release.promise;
    },
  };
}

export async function atBarrier(
  entered: Promise<unknown>,
  completion: Promise<unknown>,
  label: string,
  response?: Response,
) {
  await Promise.race([
    entered,
    completion.then(() => {
      throw new Error(
        response ? `${label}: ${response.statusCode} ${JSON.stringify(response.body)}` : label,
      );
    }),
  ]);
}

export function expectResponse(response: Response, body: unknown, status = 200) {
  expect(response.statusCode).toBe(status);
  expect(response.body).toEqual(body);
}

export function expectResponseContaining(response: Response, body: object, status = 200) {
  expect(response.statusCode).toBe(status);
  expect(response.body).toMatchObject(body);
}

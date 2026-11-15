import { expectDefined } from "@openclaw/normalization-core";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

export function createRouteFixture() {
  const routes = createBrowserRouteApp();
  return {
    ...routes,
    request: async (
      method: "get" | "post" | "delete",
      path: string,
      input: Partial<BrowserRequest> = {},
    ) => {
      const handler = expectDefined(
        routes[`${method}Handlers`].get(path),
        `registered ${method} ${path}`,
      );
      const response = createBrowserRouteResponse();
      await handler({ params: {}, query: {}, ...input }, response.res);
      return response;
    },
  };
}

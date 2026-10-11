import { describe, expect, it, vi } from "vitest";
import { createBrowserRouteContext } from "../server-context.js";
import { makeBrowserServerState } from "../server-context.test-harness.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const profilesService = vi.hoisted(() => ({
  importSystemProfile: vi.fn(async () => ({ ok: true }) as const),
  deleteProfile: vi.fn(async (name: string) => ({ ok: true, profile: name, deleted: true })),
}));

vi.mock("../profiles-service.js", () => ({ createBrowserProfilesService: () => profilesService }));

function createLifecycleRoute(path: string) {
  const state = makeBrowserServerState();
  const context = createBrowserRouteContext({ getState: () => state });
  const deleting = path === "DELETE /profiles/:name";
  const mutation = vi.fn();
  profilesService.deleteProfile.mockImplementation(async (name) => {
    mutation();
    return { ok: true, profile: name, deleted: true };
  });
  const profile = {
    ...context.forProfile(),
    ensureBrowserAvailable: async (options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted();
      mutation();
    },
    stopRunningBrowser: async () => {
      mutation();
      return { stopped: true };
    },
    resetProfile: async () => {
      mutation();
      return { moved: false, from: "/synthetic/profile" };
    },
  };
  const { app, postHandlers, deleteHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, { ...context, forProfile: () => profile });
  const handler = deleting ? deleteHandlers.get("/profiles/:name") : postHandlers.get(path);
  if (!handler) {
    throw new Error(`Missing browser lifecycle route ${path}`);
  }
  return {
    mutation,
    call: async (request: Partial<BrowserRequest>) => {
      const response = createBrowserRouteResponse();
      await handler({ params: { name: "work" }, query: {}, ...request }, response.res);
      return response;
    },
  };
}

describe("shared lifecycle admission", () => {
  it.each(["request canceled", "connection canceled"])(
    "rejects a request before mutation when %s",
    async (reason) => {
      const route = createLifecycleRoute("/start");
      const request = new AbortController();
      const connection = new AbortController();
      if (reason === "request canceled") {
        request.abort(new Error(reason));
      } else if (reason === "connection canceled") {
        connection.abort(new Error(reason));
      }

      const response = await route.call({
        signal: request.signal,
        requester: { signal: connection.signal, isCurrent: () => true },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(route.mutation).not.toHaveBeenCalled();
    },
  );

  it("rejects a retired dashboard before mutation", async () => {
    const route = createLifecycleRoute("/start");
    const response = await route.call({
      assertCurrent: async () => {
        throw new Error("dashboard retired");
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).toEqual({ error: "Error: dashboard retired" });
    expect(route.mutation).not.toHaveBeenCalled();
  });
});

describe("lifecycle admission", () => {
  it.each(["/start", "DELETE /profiles/:name"])(
    "%s rechecks requester authority after dashboard admission",
    async (path) => {
      const route = createLifecycleRoute(path);
      let current = true;
      const response = await route.call({
        requester: { signal: new AbortController().signal, isCurrent: () => current },
        assertCurrent: async () => {
          current = false;
        },
      });

      expect(response.statusCode).toBe(401);
      expect(route.mutation).not.toHaveBeenCalled();
    },
  );

  it.each(["/stop", "/reset-profile", "DELETE /profiles/:name"])(
    "%s invokes the admitted operation before yielding its authority check",
    async (path) => {
      const route = createLifecycleRoute(path);
      let current = true;
      const admittedWithAuthority: boolean[] = [];
      route.mutation.mockImplementation(() => admittedWithAuthority.push(current));

      const response = await route.call({
        requester: { signal: new AbortController().signal, isCurrent: () => current },
        assertCurrent: async () => {
          queueMicrotask(() =>
            queueMicrotask(() => {
              current = false;
            }),
          );
        },
      });

      expect(response.statusCode).toBe(200);
      expect(admittedWithAuthority).toEqual([true]);
    },
  );
});

async function callImport(body: unknown, signal?: AbortSignal) {
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserBasicRoutes(app, {} as never);
  const handler = postHandlers.get("/profiles/import");
  if (!handler) {
    throw new Error("expected /profiles/import handler");
  }
  const response = createBrowserRouteResponse();
  await handler({ body, signal } as never, response.res);
  return response;
}

describe("POST /profiles/import domain filter validation", () => {
  it.each([
    ["a non-array string", { domains: "google.com" }, "domains must be an array of domain strings"],
    [
      "an array of blanks",
      { domains: ["   ", ""] },
      "domains must include at least one non-empty domain",
    ],
  ])("fails closed for %s", async (_label, body, message) => {
    const response = await callImport(body);
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: message });
  });

  it("forwards the request abort signal into the import transaction", async () => {
    const abort = new AbortController();
    await callImport({ into: "imported" }, abort.signal);

    expect(profilesService.importSystemProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ into: "imported" }),
      { signal: abort.signal },
    );
  });
});

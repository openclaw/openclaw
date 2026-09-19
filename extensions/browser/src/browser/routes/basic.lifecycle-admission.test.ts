import { describe, expect, it, vi } from "vitest";
import { createBrowserRouteContext } from "../server-context.js";
import { makeBrowserServerState } from "../server-context.test-harness.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";
import type { BrowserRequest } from "./types.js";

const profilesService = vi.hoisted(() => ({
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

describe.each(["/start", "/stop", "/reset-profile", "DELETE /profiles/:name"])(
  "%s lifecycle admission",
  (path) => {
    it.each(["request canceled", "connection canceled", "authority revoked"])(
      "rejects a request before mutation when %s",
      async (reason) => {
        const route = createLifecycleRoute(path);
        const request = new AbortController();
        const connection = new AbortController();
        if (reason === "request canceled") {
          request.abort(new Error(reason));
        } else if (reason === "connection canceled") {
          connection.abort(new Error(reason));
        }

        const response = await route.call({
          signal: request.signal,
          requester: { signal: connection.signal, isCurrent: () => reason !== "authority revoked" },
        });

        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(route.mutation).not.toHaveBeenCalled();
      },
    );

    it("rechecks requester authority after dashboard admission", async () => {
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
    });

    it("invokes the admitted operation before yielding its authority check", async () => {
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
    });

    it("rejects a retired dashboard before mutation", async () => {
      const route = createLifecycleRoute(path);
      const response = await route.call({
        assertCurrent: async () => {
          throw new Error("dashboard retired");
        },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(response.body).toEqual({ error: "Error: dashboard retired" });
      expect(route.mutation).not.toHaveBeenCalled();
    });

    it("admits the current requester", async () => {
      const route = createLifecycleRoute(path);
      const response = await route.call({
        requester: { signal: new AbortController().signal, isCurrent: () => true },
        assertCurrent: async () => {},
      });

      expect(response.statusCode).toBe(200);
      expect(route.mutation).toHaveBeenCalledOnce();
    });
  },
);

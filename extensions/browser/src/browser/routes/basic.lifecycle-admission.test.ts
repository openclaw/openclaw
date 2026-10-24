import { describe, expect, it, vi } from "vitest";
import { createBrowserRouteContext } from "../server-context.js";
import { makeBrowserServerState } from "../server-context.test-harness.js";
import { registerBrowserBasicRoutes } from "./basic.js";
import { createRouteFixture } from "./request.test-support.js";
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
  function mutate<T>(result: T) {
    mutation();
    return result;
  }
  profilesService.deleteProfile.mockImplementation(async (name) =>
    mutate({ ok: true, profile: name, deleted: true }),
  );
  const profile = {
    ...context.forProfile(),
    ensureBrowserAvailable: async (options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted();
      mutation();
    },
    stopRunningBrowser: async () => mutate({ stopped: true }),
    resetProfile: async () => mutate({ moved: false, from: "/synthetic/profile" }),
  };
  const routes = createRouteFixture();
  registerBrowserBasicRoutes(routes.app, { ...context, forProfile: () => profile });
  return {
    mutation,
    call: (request: Partial<BrowserRequest>) =>
      routes.request(deleting ? "delete" : "post", deleting ? "/profiles/:name" : path, {
        params: { name: "work" },
        ...request,
      }),
  };
}

describe("shared lifecycle admission", () => {
  it.each(["request canceled", "connection canceled", "dashboard retired"])(
    "rejects a request before mutation when %s",
    async (reason) => {
      const route = createLifecycleRoute("/start");
      const request = new AbortController();
      const connection = new AbortController();
      const error = new Error(reason);
      if (reason !== "dashboard retired") {
        (reason === "request canceled" ? request : connection).abort(error);
      }

      const response = await route.call({
        signal: request.signal,
        requester: { signal: connection.signal, isCurrent: () => true },
        assertCurrent: async () => {
          if (reason === "dashboard retired") {
            throw error;
          }
        },
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      if (reason === "dashboard retired") {
        expect(response.body).toEqual({ error: "Error: dashboard retired" });
      }
      expect(route.mutation).not.toHaveBeenCalled();
    },
  );

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

describe("POST /profiles/import domain filter validation", () => {
  it.each([
    ["a non-array string", { domains: "google.com" }, "domains must be an array of domain strings"],
    [
      "an array of blanks",
      { domains: ["   ", ""] },
      "domains must include at least one non-empty domain",
    ],
  ])("fails closed for %s", async (_label, body, message) => {
    const response = await createLifecycleRoute("/profiles/import").call({ body });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({ error: message });
  });

  it("forwards the request abort signal into the import transaction", async () => {
    const abort = new AbortController();
    await createLifecycleRoute("/profiles/import").call({
      body: { into: "imported" },
      signal: abort.signal,
    });

    expect(profilesService.importSystemProfile).toHaveBeenLastCalledWith(
      expect.objectContaining({ into: "imported" }),
      { signal: abort.signal },
    );
  });
});

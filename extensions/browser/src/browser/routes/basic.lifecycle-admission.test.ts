import { expect, it, vi } from "vitest";
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

it.each([
  ["/start", "request", 0],
  ["/start", "connection", 0],
  ["/start", "dashboard", 0],
  ["/start", "during admission", 401],
  ["DELETE /profiles/:name", "during admission", 401],
  ["/stop", "after admission", 200],
  ["/reset-profile", "after admission", 200],
  ["DELETE /profiles/:name", "after admission", 200],
] as const)("%s respects authority revoked %s", async (path, revocation, status) => {
  const route = createLifecycleRoute(path);
  let current = true;
  const admittedWithAuthority: boolean[] = [];
  route.mutation.mockImplementation(() => admittedWithAuthority.push(current));
  const retired = new Error("dashboard retired");
  const response = await route.call({
    signal: revocation === "request" ? AbortSignal.abort(retired) : undefined,
    requester: {
      signal:
        revocation === "connection" ? AbortSignal.abort(retired) : new AbortController().signal,
      isCurrent: () => current,
    },
    assertCurrent: async () => {
      if (revocation === "dashboard") {
        throw retired;
      }
      const revoke = () => {
        current = false;
      };
      if (revocation === "during admission") {
        revoke();
      }
      if (revocation === "after admission") {
        queueMicrotask(() => queueMicrotask(revoke));
      }
    },
  });
  if (status) {
    expect(response.statusCode).toBe(status);
  } else {
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  }
  if (revocation === "dashboard") {
    expect(response.body).toEqual({ error: "Error: dashboard retired" });
  }
  expect(admittedWithAuthority).toEqual(status === 200 ? [true] : []);
});

it.each([
  ["google.com", "domains must be an array of domain strings"],
  [["   ", ""], "domains must include at least one non-empty domain"],
])("fails closed for domains=%j", async (domains, message) => {
  const response = await createLifecycleRoute("/profiles/import").call({ body: { domains } });
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

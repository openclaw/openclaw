import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionBrowserAuthority } from "./browser-dashboard.types.js";
import { getBrowserStateRuntime, setBrowserStateRuntime } from "./browser-runtime-state.js";
import {
  makeBrowserProfile,
  makeBrowserServerState,
} from "./browser/server-context.test-harness.js";
import { accessSessionBrowserDashboard } from "./session-browser-dashboard.js";

const mocked = vi.hoisted(() => ({
  definition: vi.fn(),
  create: vi.fn(),
  state: undefined as unknown,
  profile: undefined as unknown,
  lifecycle: undefined as unknown,
}));
vi.mock("./browser-dashboard-definition.js", async (original) => ({
  ...(await original<typeof import("./browser-dashboard-definition.js")>()),
  readBrowserDashboardDefinition: mocked.definition,
}));
// mock-isolation: model dashboard ownership without connecting to a host browser.
vi.mock("./browser-control-state.js", () => ({
  getBrowserControlState: () => mocked.state,
  createBrowserControlContext: () => ({
    state: () => mocked.state,
    forProfile: () => ({ profile: mocked.profile, ensureBrowserAvailable: async () => {} }),
  }),
}));
vi.mock("./control-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-service.js")>()),
  startBrowserControlServiceFromConfig: async () => true,
}));
vi.mock("./browser/pw-ai-module.js", () => ({
  getPwAiModule: async () => ({ createPageViaPlaywright: mocked.create }),
}));
vi.mock("./browser/server-context.lifecycle.js", async (original) => ({
  ...(await original<typeof import("./browser/server-context.lifecycle.js")>()),
  getProfileLifecycle: () => mocked.lifecycle,
  isProfileOperationCurrent: () => true,
}));

const request = { sessionKey: "agent:main:dashboard:one", agentId: "main", name: "review" };
const definition = {
  ...request,
  instanceId: "widget-one",
  revision: 1,
  profile: "openclaw",
  url: "https://example.test/",
};
class Authority implements SessionBrowserAuthority {
  session = new AbortController();
  actor = new AbortController();
  current = AbortSignal.any([this.actor.signal, this.session.signal]);
  releaseSession = vi.fn();
  target = {
    agentId: "main",
    sessionKey: request.sessionKey,
    sessionId: "one",
    lifecycleRevision: "incarnation",
  };
  sandboxRequired = false;
  assertCurrent = () => this.current.throwIfAborted();
  retainSession = () => ({
    signal: this.session.signal,
    assertCurrent: () => this.session.signal.throwIfAborted(),
    release: this.releaseSession,
  });
  retain(): never {
    throw new Error("Resource ownership must not retain an actor");
  }
  release() {}
  revokeActor = () => this.actor.abort(new Error("actor revoked"));
}
function page(id: string) {
  let current = true;
  return {
    targetId: id,
    isCurrent: () => current,
    close: vi.fn(async () => {
      current = false;
    }),
  };
}
function access(
  owner: SessionBrowserAuthority = new Authority(),
  options: Parameters<typeof accessSessionBrowserDashboard>[2] = { operation: "open" },
  input: Parameters<typeof accessSessionBrowserDashboard>[0] = request,
) {
  return accessSessionBrowserDashboard(input, owner, options);
}
let owner: Authority;
beforeEach(() => {
  vi.clearAllMocks();
  owner = new Authority();
  mocked.profile = makeBrowserProfile();
  const state = makeBrowserServerState();
  state.profiles.set("openclaw", { profile: makeBrowserProfile(), running: null });
  mocked.state = state;
  mocked.lifecycle = { controller: new AbortController() };
  mocked.definition.mockResolvedValue(definition);
  mocked.create.mockImplementation(async () => page("owned-tab"));
  setBrowserStateRuntime({
    dashboardOperations: new Map(),
    sessionTabs: {} as never,
    sessionTabOperations: new Map(),
  });
});
afterEach(async () => {
  await Promise.allSettled(
    [...(getBrowserStateRuntime().sessionDashboards?.values() ?? [])].map((resource) =>
      resource.close(),
    ),
  );
});

it("rejects a delayed old URL read without replacing the newer collaborator's context", async () => {
  const replacement = { ...definition, url: "https://current.example.test/" };
  const oldReadStarted = createDeferred<void>();
  const oldRead = createDeferred<typeof definition>();
  mocked.definition.mockImplementationOnce(() => {
    oldReadStarted.resolve();
    return oldRead.promise;
  });
  const stale = access();
  await oldReadStarted.promise;
  mocked.definition.mockResolvedValue(replacement);
  const current = await access(
    new Authority(),
    { operation: "open" },
    { ...request, instanceId: replacement.instanceId },
  );
  oldRead.resolve(definition);
  await expect(stale).rejects.toThrow("dashboard changed before this operation");
  expect(mocked.create).toHaveBeenCalledOnce();
  expect(mocked.create).toHaveBeenCalledWith(expect.objectContaining({ url: replacement.url }));
  expect(current.resource.page?.close).not.toHaveBeenCalled();
  expect(() => current.resource.assertCurrent()).not.toThrow();
  expect([...getBrowserStateRuntime().sessionDashboards!.values()]).toEqual([current.resource]);
});

it("allocates one isolated context for concurrent viewers and keeps it across actor retirement", async () => {
  const first = new Authority();
  const second = new Authority();
  const [one, two] = await Promise.all([access(first), access(second)]);
  expect(mocked.create).toHaveBeenCalledOnce();
  expect(mocked.create).toHaveBeenCalledWith(
    expect.objectContaining({ isolatedContext: true, url: definition.url }),
  );
  expect(one.resource).toBe(two.resource);
  first.revokeActor();
  expect(() => one.resource.assertCurrent()).not.toThrow();
  expect((await access(second, { operation: "inspect" })).response.browserTab?.targetId).toBe(
    "owned-tab",
  );
});

it("inspects without starting Chromium and preserves explicit Stop until Resume", async () => {
  const inspect = await access(owner, { operation: "inspect" });
  expect(inspect.response.paused).toBe(false);
  expect(mocked.create).not.toHaveBeenCalled();
  const opened = await access(owner);
  expect(opened.response.browserTab).toBeDefined();
  await access(owner, { operation: "stop" });
  expect(opened.resource.page?.close).toHaveBeenCalledOnce();
  expect((await access(owner)).response.paused).toBe(true);
  await access(owner, { operation: "open", resume: true });
  expect(mocked.create).toHaveBeenCalledTimes(2);
});

it.each(["definition change", "session retirement"])("closes its context on %s", async (reason) => {
  const { resource } = await access(owner);
  if (reason === "definition change") {
    mocked.definition.mockResolvedValue({ ...definition, url: "https://replacement.test/" });
    await expect(resource.assertDefinitionCurrent()).rejects.toThrow("removed or replaced");
    expect(owner.releaseSession).toHaveBeenCalledOnce();
  } else {
    owner.session.abort(new Error("session reset"));
    await resource.close();
  }
  expect(resource.page?.close).toHaveBeenCalledOnce();
  expect(resource.signal.aborted).toBe(true);
});

it("rejects a board-selected custom profile before allocating a context", async () => {
  mocked.definition.mockResolvedValue({ ...definition, profile: "custom" });
  await expect(access()).rejects.toThrow("configured default managed profile");
  expect(mocked.create).not.toHaveBeenCalled();
});

it("carries invocation and resource authority into the page creation effect boundary", async () => {
  mocked.create.mockImplementationOnce(async ({ assertCurrent }) => {
    assertCurrent();
    await Promise.resolve();
    owner.revokeActor();
    assertCurrent();
    throw new Error("revoked authority reached page allocation");
  });
  await expect(access(owner)).rejects.toThrow("actor revoked");
  expect(getBrowserStateRuntime().sessionDashboards?.size).toBe(0);
  expect(owner.releaseSession).toHaveBeenCalledOnce();
});

it.each(["actor", "session"])("compensates an allocation after %s retirement", async (retired) => {
  const allocated = page("late-page");
  mocked.create.mockImplementationOnce(async () => {
    if (retired === "actor") {
      owner.revokeActor();
    } else {
      owner.session.abort();
    }
    return allocated;
  });
  await expect(access(owner)).rejects.toThrow(retired === "actor" ? "actor revoked" : undefined);
  expect(allocated.close).toHaveBeenCalledOnce();
  expect(getBrowserStateRuntime().sessionDashboards?.size).toBe(0);
});

it("rejects required sandbox and unsupported profiles before allocating a context", async () => {
  owner.sandboxRequired = true;
  await expect(access(owner)).rejects.toThrow("does not provide a sandbox");
  owner.sandboxRequired = false;
  mocked.profile = makeBrowserProfile({ attachOnly: true });
  await expect(access(owner)).rejects.toThrow("local managed browser");
  expect(mocked.create).not.toHaveBeenCalled();
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  start: vi.fn(),
  ensure: vi.fn(),
  state: undefined as unknown,
  profile: undefined as unknown,
  lifecycle: undefined as unknown,
  profileCurrent: true,
}));
vi.mock("./browser-dashboard-definition.js", async (original) => ({
  ...(await original<typeof import("./browser-dashboard-definition.js")>()),
  readBrowserDashboardDefinition: mocked.definition,
}));
vi.mock("./browser-control-state.js", () => ({
  getBrowserControlState: () => mocked.state,
  createBrowserControlContext: () => ({
    state: () => mocked.state,
    forProfile: () => ({ profile: mocked.profile, ensureBrowserAvailable: mocked.ensure }),
  }),
}));
vi.mock("./browser/control-service.js", () => ({
  startBrowserControlServiceFromConfig: mocked.start,
}));
vi.mock("./browser/pw-ai-module.js", () => ({
  getPwAiModule: async () => ({ createPageViaPlaywright: mocked.create }),
}));
vi.mock("./browser/server-context.lifecycle.js", () => ({
  getProfileLifecycle: () => mocked.lifecycle,
  isProfileGenerationCurrent: () => mocked.profileCurrent,
}));

const request = { sessionKey: "agent:main:dashboard:one", agentId: "main", name: "review" };
const definition = {
  ...request,
  instanceId: "widget-one",
  revision: 1,
  profile: "openclaw",
  url: "https://example.test/",
};
function authority() {
  const session = new AbortController();
  let actorCurrent = true;
  const release = vi.fn();
  const value: SessionBrowserAuthority = {
    target: {
      agentId: "main",
      sessionKey: request.sessionKey,
      sessionId: "one",
      lifecycleRevision: "incarnation",
    },
    sandboxRequired: false,
    assertCurrent: () => {
      if (!actorCurrent) {
        throw new Error("actor revoked");
      }
      session.signal.throwIfAborted();
    },
    retainSession: () => ({
      signal: session.signal,
      assertCurrent: () => session.signal.throwIfAborted(),
      release,
    }),
    retain: () => {
      throw new Error("Resource ownership must not retain an actor");
    },
    release: () => {},
  };
  return {
    value,
    session,
    release,
    revokeActor: () => {
      actorCurrent = false;
    },
  };
}
function page(id: string) {
  let current = true;
  return {
    targetId: id,
    title: "Review",
    url: definition.url,
    type: "page",
    isCurrent: () => current,
    close: vi.fn(async () => {
      current = false;
    }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocked.profile = makeBrowserProfile();
  const state = makeBrowserServerState();
  state.profiles.set("openclaw", { profile: makeBrowserProfile(), running: null });
  mocked.state = state;
  mocked.lifecycle = { generation: 1, configRevision: 1, controller: new AbortController() };
  mocked.profileCurrent = true;
  mocked.definition.mockResolvedValue(definition);
  mocked.start.mockResolvedValue(true);
  mocked.ensure.mockResolvedValue(undefined);
  mocked.create.mockImplementation(async () => page("owned-tab"));
  setBrowserStateRuntime({
    dashboardOperations: new Map(),
    sessionTabs: {} as never,
    sessionTabDiscovery: {} as never,
  });
});
afterEach(async () => {
  await Promise.allSettled(
    [...(getBrowserStateRuntime().sessionDashboards?.values() ?? [])].map((resource) =>
      resource.close(),
    ),
  );
});

describe("isolated session browser owner", () => {
  it.each([
    { change: "URL", replacement: { ...definition, url: "https://current.example.test/" } },
    { change: "instance", replacement: { ...definition, instanceId: "widget-replacement" } },
  ])(
    "rejects a delayed old $change read without replacing the newer collaborator's context",
    async ({ replacement }) => {
      let releaseOldRead!: (value: typeof definition) => void;
      let markOldReadStarted!: () => void;
      const oldReadStarted = new Promise<void>((resolve) => {
        markOldReadStarted = resolve;
      });
      const oldRead = new Promise<typeof definition>((resolve) => {
        releaseOldRead = resolve;
      });
      mocked.definition.mockImplementationOnce(() => {
        markOldReadStarted();
        return oldRead;
      });
      const stale = accessSessionBrowserDashboard(request, authority().value, {
        operation: "open",
      });
      await oldReadStarted;
      mocked.definition.mockResolvedValue(replacement);
      const current = await accessSessionBrowserDashboard(
        { ...request, instanceId: replacement.instanceId },
        authority().value,
        { operation: "open" },
      );
      releaseOldRead(definition);
      await expect(stale).rejects.toThrow("dashboard changed before this operation");
      expect(mocked.create).toHaveBeenCalledOnce();
      expect(mocked.create).toHaveBeenCalledWith(expect.objectContaining({ url: replacement.url }));
      expect(current.resource.page?.close).not.toHaveBeenCalled();
      expect(() => current.resource.assertCurrent()).not.toThrow();
      expect([...getBrowserStateRuntime().sessionDashboards!.values()]).toEqual([current.resource]);
    },
  );

  it("allocates one isolated context for concurrent viewers and keeps it across actor retirement", async () => {
    const first = authority();
    const second = authority();
    const [one, two] = await Promise.all([
      accessSessionBrowserDashboard(request, first.value, { operation: "open" }),
      accessSessionBrowserDashboard(request, second.value, { operation: "open" }),
    ]);
    expect(mocked.create).toHaveBeenCalledOnce();
    expect(mocked.create).toHaveBeenCalledWith(
      expect.objectContaining({ isolatedContext: true, url: definition.url }),
    );
    expect(one.resource).toBe(two.resource);
    first.revokeActor();
    expect(() => one.resource.assertCurrent()).not.toThrow();
    expect(
      (await accessSessionBrowserDashboard(request, second.value, { operation: "inspect" }))
        .response.browserTab?.targetId,
    ).toBe("owned-tab");
  });

  it("inspects without starting Chromium and preserves explicit Stop until Resume", async () => {
    const owner = authority();
    const inspect = await accessSessionBrowserDashboard(request, owner.value, {
      operation: "inspect",
    });
    expect(inspect.response.paused).toBe(false);
    expect(mocked.create).not.toHaveBeenCalled();
    const opened = await accessSessionBrowserDashboard(request, owner.value, { operation: "open" });
    expect(opened.response.browserTab).toBeDefined();
    await accessSessionBrowserDashboard(request, owner.value, { operation: "stop" });
    expect(opened.resource.page?.close).toHaveBeenCalledOnce();
    expect(
      (await accessSessionBrowserDashboard(request, owner.value, { operation: "open" })).response
        .paused,
    ).toBe(true);
    await accessSessionBrowserDashboard(request, owner.value, { operation: "open", resume: true });
    expect(mocked.create).toHaveBeenCalledTimes(2);
  });

  it("fences a changed board immediately and closes its complete context", async () => {
    const owner = authority();
    const { resource } = await accessSessionBrowserDashboard(request, owner.value, {
      operation: "open",
    });
    resource.definitionChanged();
    expect(() => resource.assertCurrent()).toThrow("definition changed");
    mocked.definition.mockResolvedValue({ ...definition, url: "https://replacement.test/" });
    await expect(resource.assertDefinitionCurrent()).rejects.toThrow("removed or replaced");
    expect(resource.page?.close).toHaveBeenCalledOnce();
    expect(resource.signal.aborted).toBe(true);
    expect(owner.release).toHaveBeenCalledOnce();
  });

  it("closes an adopted context when its session lifetime ends", async () => {
    const owner = authority();
    const { resource } = await accessSessionBrowserDashboard(request, owner.value, {
      operation: "open",
    });
    owner.session.abort(new Error("session reset"));
    await resource.close();
    expect(resource.page?.close).toHaveBeenCalledOnce();
    expect(resource.signal.aborted).toBe(true);
  });

  it("rejects a board-selected custom profile before allocating a context", async () => {
    mocked.definition.mockResolvedValue({ ...definition, profile: "custom" });
    await expect(
      accessSessionBrowserDashboard(request, authority().value, { operation: "open" }),
    ).rejects.toThrow("configured default managed profile");
    expect(mocked.create).not.toHaveBeenCalled();
  });

  it("carries invocation and resource authority into the page creation effect boundary", async () => {
    const owner = authority();
    mocked.create.mockImplementationOnce(async ({ assertCurrent }) => {
      assertCurrent();
      await Promise.resolve();
      owner.revokeActor();
      assertCurrent();
      throw new Error("revoked authority reached page allocation");
    });
    await expect(
      accessSessionBrowserDashboard(request, owner.value, { operation: "open" }),
    ).rejects.toThrow("actor revoked");
    expect(getBrowserStateRuntime().sessionDashboards?.size).toBe(0);
    expect(owner.release).toHaveBeenCalledOnce();
  });

  it("compensates context creation when actor revocation wins an awaited allocation", async () => {
    const owner = authority();
    const allocated = page("late-page");
    mocked.create.mockImplementationOnce(async () => {
      owner.revokeActor();
      return allocated;
    });
    await expect(
      accessSessionBrowserDashboard(request, owner.value, { operation: "open" }),
    ).rejects.toThrow("actor revoked");
    expect(allocated.close).toHaveBeenCalledOnce();
    expect(getBrowserStateRuntime().sessionDashboards?.size).toBe(0);
  });

  it("compensates a context delivered after session retirement during allocation", async () => {
    const owner = authority();
    const allocated = page("late-page");
    mocked.create.mockImplementationOnce(async () => {
      owner.session.abort();
      return allocated;
    });
    await expect(
      accessSessionBrowserDashboard(request, owner.value, { operation: "open" }),
    ).rejects.toThrow();
    expect(allocated.close).toHaveBeenCalledOnce();
    expect(getBrowserStateRuntime().sessionDashboards?.size).toBe(0);
  });

  it("rejects required sandbox and unsupported profiles before allocating a context", async () => {
    const owner = authority();
    await expect(
      accessSessionBrowserDashboard(
        request,
        { ...owner.value, sandboxRequired: true },
        { operation: "open" },
      ),
    ).rejects.toThrow("does not provide a sandbox");
    mocked.profile = makeBrowserProfile({ attachOnly: true });
    await expect(
      accessSessionBrowserDashboard(request, owner.value, { operation: "open" }),
    ).rejects.toThrow("local managed browser");
    expect(mocked.create).not.toHaveBeenCalled();
  });
});

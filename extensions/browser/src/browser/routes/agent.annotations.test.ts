import type { BrowserAnnotationState } from "openclaw/plugin-sdk/browser-annotations";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-support/browser-security.mock.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import { getOrCreateProfileRuntime } from "../server-context.lifecycle.js";
import { makeBrowserProfile, makeBrowserServerState } from "../server-context.test-harness.js";
import { registerBrowserAnnotationRoutes } from "./agent.annotations.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./test-helpers.js";

const mocked = vi.hoisted(() => ({ annotations: vi.fn(), available: true }));
vi.mock("../pw-ai-module.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pw-ai-module.js")>()),
  getPwAiModule: async () =>
    mocked.available ? { annotationsViaPlaywright: mocked.annotations } : null,
}));

const state: BrowserAnnotationState = {
  documentId: "current-document",
  active: false,
  surfaceCount: 1,
  selection: null,
  controls: [],
  controlsHeading: "",
};

function setup(options: { enabled?: boolean; existingSession?: boolean } = {}) {
  const profile = makeBrowserProfile(options.existingSession ? { driver: "existing-session" } : {});
  const serverState = makeBrowserServerState({
    profile,
    resolvedOverrides: { evaluateEnabled: options.enabled ?? true },
  });
  getOrCreateProfileRuntime(serverState, profile);
  const tab = { targetId: "owned-tab", title: "Page", url: "https://example.test/", type: "page" };
  const profileCtx = {
    profile,
    ensureTabAvailable: async () => tab,
    listTabs: async () => [tab],
  } as unknown as ProfileContext;
  const context = {
    state: () => serverState,
    forProfile: () => profileCtx,
  } as unknown as BrowserRouteContext;
  const { app, postHandlers } = createBrowserRouteApp();
  registerBrowserAnnotationRoutes(app, context);
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("Dashboard access revoked");
    }
  };
  return {
    revoke: () => {
      current = false;
    },
    request: async (body: Record<string, unknown>) => {
      const response = createBrowserRouteResponse();
      await postHandlers.get("/annotations")!(
        { params: {}, query: {}, body, assertCurrent },
        response.res,
      );
      return response;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.available = true;
  mocked.annotations.mockResolvedValue(state);
});

describe("browser annotations route", () => {
  it("dispatches a typed command on the admitted tab and returns its state", async () => {
    const { request } = setup();
    const response = await request({ action: "state", targetId: "requested-alias" });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(state);
    expect(mocked.annotations).toHaveBeenCalledWith(
      expect.objectContaining({
        command: { action: "state" },
        targetId: "owned-tab",
        assertCurrent: expect.any(Function),
      }),
    );
  });

  it.each([
    { action: "evaluate", fn: "() => 1" },
    { action: "select", documentId: "old", clientX: Infinity, clientY: 1 },
    { action: "stop" },
    { action: "control", documentId: "doc", change: "send" },
  ])("rejects invalid command $action without executing page code", async (command) => {
    const response = await setup().request(command);
    expect(response.statusCode).toBe(400);
    expect(mocked.annotations).not.toHaveBeenCalled();
  });

  it("respects evaluateEnabled and reports unsupported runtimes explicitly", async () => {
    expect((await setup({ enabled: false }).request({ action: "state" })).statusCode).toBe(403);
    expect(
      (await setup({ existingSession: true }).request({ action: "state" })).body,
    ).toMatchObject({
      code: "ANNOTATION_UNSUPPORTED",
    });
    mocked.available = false;
    expect((await setup().request({ action: "state" })).body).toMatchObject({
      code: "ANNOTATION_UNSUPPORTED",
    });
    expect(mocked.annotations).not.toHaveBeenCalled();
  });

  it("does not publish data after dashboard authority is revoked", async () => {
    const { request, revoke } = setup();
    mocked.annotations.mockImplementationOnce(async () => {
      revoke();
      return state;
    });
    const response = await request({ action: "state" });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.body).not.toHaveProperty("documentId");
  });

  it("rejects malformed and oversized page projections", async () => {
    const { request } = setup();
    mocked.annotations.mockResolvedValueOnce({ ...state, controls: [{ type: "javascript" }] });
    expect((await request({ action: "state" })).statusCode).toBeGreaterThanOrEqual(400);
    mocked.annotations.mockResolvedValueOnce({ ...state, controlsHeading: "x".repeat(9000) });
    expect((await request({ action: "state" })).statusCode).toBeGreaterThanOrEqual(400);
  });
});

import * as security from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-support/browser-security.mock.js";
import { expectResponse, runRoute } from "./agent-route.test-support.js";
import { createDashboardRouteContext } from "./dashboard-ownership.test-support.js";
import { createBrowserRouteApp } from "./test-helpers.js";

const pw = vi.hoisted(() => ({ executeActViaPlaywright: vi.fn(async () => ({})) }));

// mock-isolation: Control the page effect while retaining real route admission and URL policy.
vi.mock("../pw-ai-module.js", () => ({ getPwAiModule: vi.fn(async () => pw) }));

const { registerBrowserAgentActRoutes } = await import("./agent.act.js");

describe("browser /act response URLs", () => {
  beforeEach(() => {
    pw.executeActViaPlaywright.mockReset().mockResolvedValue({});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["unchanged", "navigated", "policy-changed", "not-admitted", "cancelled"] as const)(
    "validates response URLs without repeating admitted DNS work (%s)",
    async (scenario) => {
      const tab = {
        targetId: "tab-1",
        title: "Example",
        url: "https://example.com/",
        type: "page",
      };
      const policy = { dangerouslyAllowPrivateNetwork: true };
      const ctx = createDashboardRouteContext(tab, { evaluateEnabled: true });
      ctx.state().resolved.ssrfPolicy = policy;
      const lookup = vi.spyOn(security, "resolvePinnedHostnameWithPolicy");
      const controller = new AbortController();
      const reason = new Error("response preparation cancelled");
      const { app, postHandlers } = createBrowserRouteApp();
      registerBrowserAgentActRoutes(app, ctx);

      pw.executeActViaPlaywright.mockImplementationOnce(async () => {
        if (scenario === "navigated") {
          tab.url = "https://example.org/";
        } else if (scenario === "policy-changed") {
          policy.dangerouslyAllowPrivateNetwork = false;
        }
        return {};
      });
      if (scenario === "cancelled") {
        vi.spyOn(ctx.forProfile(), "listTabs").mockImplementationOnce(async () => {
          controller.abort(reason);
          return [tab];
        });
      }

      const response = await runRoute(postHandlers.get("/act"), {
        body:
          scenario === "not-admitted"
            ? { kind: "resize", targetId: tab.targetId, width: 800, height: 600 }
            : { kind: "hover", targetId: tab.targetId, ref: "1" },
        signal: controller.signal,
      });

      expect(pw.executeActViaPlaywright).toHaveBeenCalledOnce();
      if (scenario === "cancelled") {
        expectResponse(response, { error: expect.stringContaining(reason.message) }, 500);
      } else {
        expectResponse(response, {
          ok: true,
          targetId: tab.targetId,
          ...(scenario === "policy-changed" ? {} : { url: tab.url }),
        });
      }
      expect(lookup.mock.calls.map(([hostname]) => hostname)).toEqual(
        scenario === "navigated" ? ["example.com", "example.org"] : ["example.com"],
      );
    },
  );
});

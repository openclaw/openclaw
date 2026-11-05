// Gateway dispatch proof lives with the A2A plugin. Core type graphs must not
// import bundled extension files, and this is the route that otherwise falls
// through to the root Control UI document.
import fs from "node:fs/promises";
import path from "node:path";
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, expect, it, vi } from "vitest";
import {
  AUTH_NONE,
  sendRequest,
  withGatewayServer,
} from "../../../src/gateway/server-http.test-harness.js";
import {
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
} from "../../../src/gateway/server/plugins-http.js";
import type { createSubsystemLogger } from "../../../src/logging/subsystem.js";
import { withTempDir } from "../../../src/test-utils/temp-dir.js";
import { a2aChannelPlugin } from "./channel.js";
import { createA2aGatewayFixture } from "./gateway.test-support.js";

const CONTROL_UI_DOCUMENT = "<!doctype html><html>spa fallback</html>\n";
const JSON_NOT_FOUND = JSON.stringify({ error: "Not found" });

afterEach(() => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
});

it("returns JSON 404 for unsupported /a2a/v1 descendants instead of the Control UI", async () => {
  const fixture = createA2aGatewayFixture();
  const log = { warn: vi.fn() } as unknown as ReturnType<typeof createSubsystemLogger>;

  await withTempDir("openclaw-a2a-namespace-", async (directory) => {
    const root = await fs.realpath(directory);
    await fs.writeFile(path.join(root, "index.html"), CONTROL_UI_DOCUMENT);
    await withGatewayServer({
      prefix: "a2a-namespace-control-ui",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        controlUiRoot: { kind: "resolved", path: root },
        handlePluginRequest: createGatewayPluginRequestHandler({
          registry: fixture.registry,
          log,
        }),
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          shouldEnforceGatewayAuthForPluginPath(fixture.registry, pathContext),
        isStartupPluginRuntimeReady: () => true,
      },
      run: async (server) => {
        const lifecycle = a2aChannelPlugin.gateway!.startAccount!(fixture.ctx);
        await vi.waitFor(() => expect(fixture.ctx.getStatus().lifecycle).toBe("ready"));
        try {
          for (const accept of [undefined, "*/*"] as const) {
            const response = await sendRequest(server, {
              path: "/a2a/v1/agent-card",
              headers: accept === undefined ? undefined : { accept },
            });
            const label = `GET /a2a/v1/agent-card accept=${accept ?? "absent"}`;
            expect(response.res.statusCode, label).toBe(404);
            expect(response.getBody(), label).toBe(JSON_NOT_FOUND);
            expect(response.setHeader, label).toHaveBeenCalledWith(
              "Content-Type",
              "application/json; charset=utf-8",
            );
          }

          const exact = await sendRequest(server, { path: "/a2a/v1" });
          expect(exact.res.statusCode).toBe(404);
          expect(exact.getBody()).toBe(JSON_NOT_FOUND);

          for (const discoveryPath of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
            const discovery = await sendRequest(server, { path: discoveryPath });
            expect(discovery.res.statusCode, discoveryPath).toBe(200);
            expect(JSON.parse(discovery.getBody()), discoveryPath).toMatchObject({
              supportedInterfaces: [
                expect.objectContaining({ url: expect.stringMatching(/\/a2a\/v1$/) }),
              ],
            });
          }

          const nestedDiscovery = await sendRequest(server, {
            path: "/a2a/v1/.well-known/agent-card.json",
          });
          expect(nestedDiscovery.res.statusCode).toBe(404);
          expect(nestedDiscovery.getBody()).toBe(JSON_NOT_FOUND);

          const unauthorized = await sendRequest(server, { path: "/a2a/v1", method: "POST" });
          expect(unauthorized.res.statusCode).toBe(401);
          expect(JSON.parse(unauthorized.getBody())).toMatchObject({
            error: expect.stringContaining("Unauthorized"),
          });

          for (const spaPath of ["/chat", "/a2a/v10"]) {
            const spa = await sendRequest(server, {
              path: spaPath,
              headers: { accept: "*/*" },
            });
            expect(spa.res.statusCode, spaPath).toBe(200);
            expect(spa.getBody(), spaPath).toContain("spa fallback");
          }
        } finally {
          fixture.controller.abort();
          await lifecycle;
        }

        const released = await sendRequest(server, {
          path: "/a2a/v1/agent-card",
          headers: { accept: "*/*" },
        });
        expect(released.res.statusCode).toBe(200);
        expect(released.getBody()).toContain("spa fallback");
      },
    });
  });
});

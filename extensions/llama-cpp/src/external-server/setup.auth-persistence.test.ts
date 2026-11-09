import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ProviderAuthMethodNonInteractiveContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  useAutoCleanupTempDirTracker,
  withEnvAsync,
  withServer,
} from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { configureLlamaServerNonInteractive } from "./setup.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("does not complete setup when the discovered server credential cannot be saved", async () => {
  const root = tempDirs.make("llama-server-auth-persistence-");
  const blockedDirectory = path.join(root, "blocked");
  await fs.writeFile(blockedDirectory, "not a directory");
  const requests: string[] = [];
  const key = randomBytes(24).toString("hex");
  await withEnvAsync({ OPENCLAW_STATE_DIR: root }, async () => {
    await withServer(
      (request, response) => {
        requests.push(request.url ?? "");
        response.setHeader("content-type", "application/json");
        response.end(
          request.url === "/models"
            ? JSON.stringify({ data: [{ id: "local-model", status: { value: "loaded" } }] })
            : "{}",
        );
      },
      async (baseUrl) => {
        const ctx: ProviderAuthMethodNonInteractiveContext = {
          authChoice: "llama-cpp-existing-server",
          config: {},
          baseConfig: {},
          agentDir: path.join(blockedDirectory, "agent"),
          opts: { customBaseUrl: baseUrl, customApiKey: key },
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
          resolveApiKey: async () => ({ key, source: "flag" }),
          toApiKeyCredential: () => ({ type: "api_key", provider: "llama-cpp", key }),
        };

        await expect(configureLlamaServerNonInteractive(ctx)).rejects.toThrow();

        expect(requests).toContain("/models");
        expect(ctx.runtime.log).not.toHaveBeenCalled();
        expect(ctx.config).toEqual({});
        expect(await fs.readFile(blockedDirectory, "utf8")).toBe("not a directory");
      },
    );
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";

const setDiscordProviderEndpointDescriptor = vi.hoisted(() => vi.fn());

vi.mock("@openclaw/discord/provider-endpoint-api.js", () => ({
  setDiscordProviderEndpointDescriptor,
}));

import { CRABLINE_DISCORD_PROVIDER_ENDPOINT_ARTIFACT } from "./crabline-discord-provider-endpoint-artifact.js";
import { registerCrablineDiscordProviderEndpoint } from "./crabline-discord-provider-endpoint.js";

const QA_TEMP_ROOT_ENV = "OPENCLAW_QA_TEMP_ROOT";
const originalTempRoot = process.env[QA_TEMP_ROOT_ENV];

afterEach(() => {
  if (originalTempRoot === undefined) {
    delete process.env[QA_TEMP_ROOT_ENV];
  } else {
    process.env[QA_TEMP_ROOT_ENV] = originalTempRoot;
  }
  setDiscordProviderEndpointDescriptor.mockReset();
});

describe("Crabline Discord child provider endpoint", () => {
  it("loads the QA-owned artifact before startup and clears it during teardown", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qa-discord-endpoint-"));
    process.env[QA_TEMP_ROOT_ENV] = tempRoot;
    const descriptor = {
      restApiBaseUrl: "http://127.0.0.1:43123/api/v10",
      gatewayBotUrl: "http://127.0.0.1:43123/api/v10/gateway/bot",
      gatewayOrigin: "ws://127.0.0.1:43123",
    };
    fs.writeFileSync(
      path.join(tempRoot, CRABLINE_DISCORD_PROVIDER_ENDPOINT_ARTIFACT),
      `${JSON.stringify(descriptor)}\n`,
      { mode: 0o600 },
    );
    const registerRuntimeLifecycle = vi.fn();

    try {
      registerCrablineDiscordProviderEndpoint(
        createTestPluginApi({ registrationMode: "full", registerRuntimeLifecycle }),
      );

      expect(setDiscordProviderEndpointDescriptor).toHaveBeenCalledWith(descriptor);
      expect(registerRuntimeLifecycle).toHaveBeenCalledOnce();
      expect(setDiscordProviderEndpointDescriptor.mock.invocationCallOrder[0]).toBeLessThan(
        registerRuntimeLifecycle.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );

      const lifecycle = registerRuntimeLifecycle.mock.calls[0]?.[0];
      await lifecycle?.cleanup({ reason: "shutdown" });
      expect(setDiscordProviderEndpointDescriptor).toHaveBeenLastCalledWith(undefined);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not load the artifact during non-runtime registration", () => {
    process.env[QA_TEMP_ROOT_ENV] = "/does/not/exist";

    registerCrablineDiscordProviderEndpoint(createTestPluginApi({ registrationMode: "discovery" }));

    expect(setDiscordProviderEndpointDescriptor).not.toHaveBeenCalled();
  });

  it("rejects an artifact with fields outside the endpoint contract", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-qa-discord-endpoint-"));
    process.env[QA_TEMP_ROOT_ENV] = tempRoot;
    fs.writeFileSync(
      path.join(tempRoot, CRABLINE_DISCORD_PROVIDER_ENDPOINT_ARTIFACT),
      JSON.stringify({ apiRoot: "http://127.0.0.1:43123/api", version: 1 }),
      { mode: 0o600 },
    );

    try {
      expect(() =>
        registerCrablineDiscordProviderEndpoint(createTestPluginApi({ registrationMode: "full" })),
      ).toThrow("Crabline Discord provider endpoint artifact is invalid");
      expect(setDiscordProviderEndpointDescriptor).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

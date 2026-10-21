import { describe, expect, it } from "vitest";
import type { CodexAppServerRuntimeIdentity } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";
import {
  captureCodexConfiguredConnection as captureConnection,
  finalizeCodexConfiguredConnection as finalizeConnection,
  validateCodexConfiguredConnectionCapture as validateConnection,
} from "./runtime-artifact-connection.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

const start: CodexAppServerStartOptions = {
  transport: "websocket",
  command: "codex",
  args: [],
  url: "wss://codex.example.test/socket?token=endpoint-secret",
  authToken: "connection-secret",
  headers: { "x-service-token": "header-secret" },
};
const runtimeIdentity: CodexAppServerRuntimeIdentity = {
  serverVersion: CODEX_APP_SERVER_VERSION,
  userAgent: `codex-cli/${CODEX_APP_SERVER_VERSION}`,
  codexHome: "/remote/codex-home",
  platformFamily: "unix",
  platformOs: "linux",
};

function captureBinding(options = start, identity = runtimeIdentity) {
  return finalizeConnection({
    before: captureConnection(options),
    startOptions: options,
    runtimeIdentity: identity,
  });
}

function validates(options = start, binding = captureBinding()) {
  return validateConnection(binding, captureConnection(options));
}

describe("configured Codex connection verification", () => {
  it.each([
    { url: "wss://other.example.test/socket" },
    { authToken: "rotated-token" },
    { headers: { "x-service-token": "rotated-header" } },
    { transport: "unix" as const, url: "unix:///tmp/codex.sock" },
  ])("invalidates a verified connection when selection changes to %j", (change) => {
    expect(validates()).toBe(true);
    expect(validates({ ...start, ...change })).toBe(false);
  });

  it("ignores local launch settings that a remote service does not consume", () => {
    const binding = captureBinding();
    const capture = captureConnection({
      ...start,
      command: "/another/local/codex",
      args: ["app-server", "--another-local-option"],
      env: { PATH: "/another/local/path", CODEX_HOME: "/local/home" },
      codexHome: "/another/local/home",
    });
    expect(validateConnection(binding, capture)).toBe(true);
  });

  it("binds the home-resolved canonical Unix socket", () => {
    const canonical = {
      ...start,
      transport: "unix" as const,
      url: "unix://",
      env: { CODEX_HOME: "/remote/first-home" },
    };
    const binding = captureBinding(canonical);
    expect(validates({ ...canonical, env: { CODEX_HOME: "/remote/second-home" } }, binding)).toBe(
      false,
    );
    expect(
      validates(
        {
          ...canonical,
          url: "unix:///remote/first-home/app-server-control/app-server-control.sock",
          env: { CODEX_HOME: "/ignored" },
        },
        binding,
      ),
    ).toBe(true);
  });

  it.each([
    { serverVersion: "9.0.0" },
    { userAgent: "different codex" },
    { codexHome: "/remote/other-home" },
    { platformFamily: "windows" },
    { platformOs: "darwin" },
  ])("binds initialized identity changes %j", (change) => {
    expect(captureBinding(start, { ...runtimeIdentity, ...change })).not.toEqual(captureBinding());
  });

  it("rejects connection changes between capture and initialize", () => {
    expect(() =>
      finalizeConnection({
        before: captureConnection(start),
        startOptions: { ...start, authToken: "rotated-token" },
        runtimeIdentity,
      }),
    ).toThrow("Codex configured connection changed during startup");
  });

  it("requires an initialized identity and an explicit endpoint", () => {
    expect(() =>
      finalizeConnection({
        before: captureConnection(start),
        startOptions: start,
        runtimeIdentity: undefined,
      }),
    ).toThrow("did not report an initialized runtime identity");
    expect(() => captureConnection({ ...start, url: undefined })).toThrow(
      "configured socket endpoint",
    );
  });

  it("keeps endpoint and credential material out of the serialized binding", () => {
    const binding = captureBinding();
    const descriptor = Buffer.from(binding.id.split(":").at(-1)!, "base64url").toString("utf8");
    expect(JSON.parse(descriptor)).toEqual({
      kind: "configured-connection",
      transport: "websocket",
      selectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      runtimeIdentityFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("rejects corrupt and noncanonical bindings", () => {
    const binding = captureBinding();
    const capture = captureConnection(start);
    for (const invalid of [
      { ...binding, fingerprint: "0".repeat(64) },
      { ...binding, id: `${binding.id}=` },
      { ...binding, id: "codex-app-server:connection:v1:bad" },
      { ...binding, id: `codex-app-server:connection:v1:${"a".repeat(2048)}` },
    ]) {
      expect(validateConnection(invalid, capture)).toBe(false);
    }
  });
});

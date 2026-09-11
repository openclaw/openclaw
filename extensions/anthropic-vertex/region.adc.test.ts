// Anthropic Vertex tests cover region.adc plugin behavior.
import { platform } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { existsSyncMock, readFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: existsSyncMock,
    default: {
      ...actual,
      existsSync: existsSyncMock,
    },
  };
});

vi.mock("openclaw/plugin-sdk/secret-file-runtime", () => ({
  tryReadSecretFileSync: (pathname: string) => readFileSyncMock(pathname, "utf8"),
}));

import { hasAnthropicVertexAvailableAuth, resolveAnthropicVertexProjectId } from "./region.js";

describe("anthropic-vertex ADC reads", () => {
  beforeEach(() => {
    existsSyncMock.mockReset();
    readFileSyncMock.mockReset();
    // The secret-file fixture owns its contents, independently of unrelated fs imports.
    readFileSyncMock.mockImplementation((pathname) => {
      if (String(pathname) !== "/tmp/vertex-adc.json") {
        throw new Error(`unexpected ADC fixture path: ${String(pathname)}`);
      }
      return '{"project_id":"vertex-project"}';
    });
  });

  afterAll(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("reads explicit ADC credentials without an existsSync preflight", () => {
    const env = {
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/vertex-adc.json",
    } as NodeJS.ProcessEnv;

    existsSyncMock.mockClear();
    readFileSyncMock.mockClear();

    expect(resolveAnthropicVertexProjectId(env)).toBe("vertex-project");
    expect(hasAnthropicVertexAvailableAuth(env)).toBe(true);
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).toHaveBeenCalledWith("/tmp/vertex-adc.json", "utf8");
  });

  it("respects HOME when probing the default ADC path from a copied env snapshot", () => {
    const homeDir = "/tmp/vertex-home";
    const defaultAdcPath =
      platform() === "win32"
        ? path.join(homeDir, "AppData", "Roaming", "gcloud", "application_default_credentials.json")
        : path.join(homeDir, ".config", "gcloud", "application_default_credentials.json");
    const env = {
      HOME: homeDir,
    } as NodeJS.ProcessEnv;

    readFileSyncMock.mockImplementation((pathname, options) =>
      String(pathname) === defaultAdcPath
        ? '{"project_id":"vertex-project"}'
        : (() => {
            throw new Error(`unexpected readFileSync(${String(pathname)}, ${String(options)})`);
          })(),
    );

    expect(resolveAnthropicVertexProjectId(env)).toBe("vertex-project");
    expect(hasAnthropicVertexAvailableAuth(env)).toBe(true);
    expect(existsSyncMock).not.toHaveBeenCalled();
    expect(readFileSyncMock).toHaveBeenCalledWith(defaultAdcPath, "utf8");
  });
});

import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, expect, it, vi } from "vitest";
import pluginManifest from "../package.json" with { type: "json" };

const mocks = vi.hoisted(() => ({ inspect: vi.fn(() => ({ ok: true }) as const) }));
vi.mock("./driver-artifact-verification.js", () => ({
  inspectCuaDriverArtifacts: mocks.inspect,
  readPackageIdentity: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform === "linux").each([
  ["/usr/lib/x86_64-linux-gnu/libc.so.6", "gnu"],
  ["/lib/libc-2.31.so", "gnu"],
  ["/lib/ld-musl-aarch64.so.1", "musl"],
  ["unidentified runtime", undefined],
])("registers with %s without a diagnostic report", async (maps, linuxLibc) => {
  vi.resetModules();
  const report = vi.spyOn(process.report, "getReport").mockImplementation(() => {
    throw new Error("registration must not construct a native diagnostic report");
  });
  const { default: plugin } = await import("../index.js");
  vi.spyOn(fs, "readFileSync").mockReturnValueOnce(`${maps}\n`);
  const api = createTestPluginApi({ id: "cua-computer" });
  api.config = { plugins: { entries: { "cua-computer": { enabled: true } } } };
  plugin.register(api);
  expect(mocks.inspect).toHaveBeenLastCalledWith(
    expect.objectContaining({ linuxLibc, pluginManifest }),
  );
  expect(report).not.toHaveBeenCalled();
});

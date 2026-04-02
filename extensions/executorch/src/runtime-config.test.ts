import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeExecuTorchPath, resolveExecuTorchRuntimeConfig } from "./runtime-config.js";

describe("normalizeExecuTorchPath", () => {
  beforeEach(() => {
    vi.spyOn(os, "homedir").mockReturnValue("/mock/home");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expands ~/ to the OS home directory", () => {
    expect(normalizeExecuTorchPath("~/foo/bar")).toBe(path.resolve("/mock/home/foo/bar"));
  });

  it("expands lone ~", () => {
    expect(normalizeExecuTorchPath("~")).toBe(path.resolve("/mock/home"));
  });

  it("returns undefined for empty input", () => {
    expect(normalizeExecuTorchPath(undefined)).toBeUndefined();
    expect(normalizeExecuTorchPath("  ")).toBeUndefined();
  });

  it("does not treat ~username-style paths as home-relative", () => {
    expect(normalizeExecuTorchPath("~other/foo")).toBe(path.resolve("~other/foo"));
  });
});

describe("resolveExecuTorchRuntimeConfig", () => {
  const prevEnv = { ...process.env };

  beforeEach(() => {
    vi.spyOn(os, "homedir").mockReturnValue("/mock/home");
    vi.spyOn(os, "platform").mockReturnValue("darwin");
    process.env = { ...prevEnv };
    delete process.env.OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY;
    delete process.env.OPENCLAW_EXECUTORCH_MODEL_ROOT;
  });

  afterEach(() => {
    process.env = prevEnv;
    vi.restoreAllMocks();
  });

  it("expands tilde in runtimeLibraryPath override", () => {
    const resolved = resolveExecuTorchRuntimeConfig({
      modelPlugin: "parakeet",
      runtimeLibraryPath: "~/.openclaw/lib/libparakeet.dylib",
    });
    expect(resolved.runtimeLibraryPath).toBe(
      path.resolve("/mock/home/.openclaw/lib/libparakeet.dylib"),
    );
  });

  it("expands tilde in OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY", () => {
    process.env.OPENCLAW_EXECUTORCH_RUNTIME_LIBRARY = "~/lib/custom-runtime.dylib";
    const resolved = resolveExecuTorchRuntimeConfig({ modelPlugin: "parakeet" });
    expect(resolved.runtimeLibraryPath).toBe(path.resolve("/mock/home/lib/custom-runtime.dylib"));
  });

  it("expands tilde in OPENCLAW_EXECUTORCH_MODEL_ROOT", () => {
    process.env.OPENCLAW_EXECUTORCH_MODEL_ROOT = "~/.openclaw/models";
    const resolved = resolveExecuTorchRuntimeConfig({ modelPlugin: "parakeet" });
    expect(resolved.modelRoot).toBe(path.resolve("/mock/home/.openclaw/models"));
    expect(resolved.modelDir).toBe(path.join(resolved.modelRoot, "parakeet-tdt-metal"));
  });

  it("expands tilde in modelDir and derived default modelPath/tokenizerPath", () => {
    const resolved = resolveExecuTorchRuntimeConfig({
      modelPlugin: "parakeet",
      modelDir: "~/.openclaw/models/parakeet-tdt-metal",
    });
    const expectedDir = path.resolve("/mock/home/.openclaw/models/parakeet-tdt-metal");
    expect(resolved.modelDir).toBe(expectedDir);
    expect(resolved.modelPath).toBe(path.join(expectedDir, "model.pte"));
    expect(resolved.tokenizerPath).toBe(path.join(expectedDir, "tokenizer.model"));
  });

  it("expands tilde in explicit modelPath, tokenizerPath, and dataPath", () => {
    const resolved = resolveExecuTorchRuntimeConfig({
      modelPlugin: "parakeet",
      modelPath: "~/m/model.pte",
      tokenizerPath: "~/m/tokenizer.model",
      dataPath: "~/m/backend.dat",
    });
    expect(resolved.modelPath).toBe(path.resolve("/mock/home/m/model.pte"));
    expect(resolved.tokenizerPath).toBe(path.resolve("/mock/home/m/tokenizer.model"));
    expect(resolved.dataPath).toBe(path.resolve("/mock/home/m/backend.dat"));
  });
});

import fs from "node:fs/promises";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  createRunner: vi.fn(() => ({ runner: true })),
  destroyRunner: vi.fn(),
  transcribe: vi.fn(async () => "mock transcript"),
  ensureRuntimeLibraryLoadable: vi.fn(async () => {
    if (mockState.runtimeBarrier) {
      await mockState.runtimeBarrier;
    }
  }),
  runtimeBarrier: null as Promise<void> | null,
}));

vi.mock("./native-addon.js", () => ({
  loadNativeExecuTorchAddon: () => ({
    createRunner: mockState.createRunner,
    destroyRunner: mockState.destroyRunner,
    transcribe: mockState.transcribe,
  }),
}));

vi.mock("./runtime-library.js", () => ({
  ensureRuntimeLibraryLoadable: mockState.ensureRuntimeLibraryLoadable,
}));

import { RunnerManager } from "./runner-manager.js";

async function createRuntimeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-executorch-runner-"));
  const runtimeLibraryPath = path.join(dir, "libparakeet_tdt_runtime.dylib");
  const modelPath = path.join(dir, "model.pte");
  const tokenizerPath = path.join(dir, "tokenizer.model");
  await Promise.all([
    fs.writeFile(runtimeLibraryPath, "runtime"),
    fs.writeFile(modelPath, "model"),
    fs.writeFile(tokenizerPath, "tokenizer"),
  ]);
  return { dir, runtimeLibraryPath, modelPath, tokenizerPath };
}

async function waitForExpectation(assertion: () => void) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      if (attempt === 49) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("RunnerManager", () => {
  afterEach(() => {
    mockState.createRunner.mockClear();
    mockState.destroyRunner.mockClear();
    mockState.transcribe.mockClear();
    mockState.ensureRuntimeLibraryLoadable.mockClear();
    mockState.runtimeBarrier = null;
    vi.restoreAllMocks();
  });

  it("deduplicates concurrent ensureReady calls while launch is in flight", async () => {
    let releaseBarrier!: () => void;
    mockState.runtimeBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const fixture = await createRuntimeFixture();
    try {
      const manager = new RunnerManager({
        runtimeLibraryPath: fixture.runtimeLibraryPath,
        backend: "metal",
        modelPath: fixture.modelPath,
        tokenizerPath: fixture.tokenizerPath,
        logger: { info() {}, warn() {}, error() {} },
      });

      const first = manager.ensureReady();
      await waitForExpectation(() =>
        expect(mockState.ensureRuntimeLibraryLoadable).toHaveBeenCalledTimes(1),
      );
      const second = manager.ensureReady();

      releaseBarrier();
      await Promise.all([first, second]);

      expect(mockState.createRunner).toHaveBeenCalledTimes(1);
      expect(manager.state).toBe("ready");
    } finally {
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });

  it("does not re-check resolved model and tokenizer paths", async () => {
    const fixture = await createRuntimeFixture();
    const accessSpy = vi.spyOn(fsPromises, "access");

    try {
      const manager = new RunnerManager({
        runtimeLibraryPath: fixture.runtimeLibraryPath,
        backend: "metal",
        modelPath: fixture.modelPath,
        tokenizerPath: fixture.tokenizerPath,
        logger: { info() {}, warn() {}, error() {} },
      });

      await manager.ensureReady();

      const modelChecks = accessSpy.mock.calls.filter(
        ([checkedPath]) => checkedPath === fixture.modelPath,
      );
      const tokenizerChecks = accessSpy.mock.calls.filter(
        ([checkedPath]) => checkedPath === fixture.tokenizerPath,
      );

      expect(modelChecks).toHaveLength(1);
      expect(tokenizerChecks).toHaveLength(1);
    } finally {
      await fs.rm(fixture.dir, { recursive: true, force: true });
    }
  });
});

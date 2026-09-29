import { constants } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ensureCaptureBinary, inspectFaceTimeNativePackage } from "../src/plugin-paths.js";

describe("FaceTime native package lookup", () => {
  it("requires only the out-of-process capture executable", async () => {
    const access = vi.fn(async (path: string, mode: number) => {
      expect(path).toMatch(/facetime-audio-capture$/u);
      expect(mode).toBe(constants.X_OK);
    });
    await expect(inspectFaceTimeNativePackage({ access: access as never })).resolves.toBe(true);
    await expect(ensureCaptureBinary({ access: access as never })).resolves.toMatch(
      /facetime-audio-capture$/u,
    );
  });
});

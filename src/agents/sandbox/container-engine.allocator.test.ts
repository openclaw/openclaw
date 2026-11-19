import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { execContainerRaw } from "./container-engine.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.skipIf(process.platform === "win32").each([false, true])(
  "isolates raw engine allocator settings with captured environment=%s",
  async (captured) => {
    const root = tempDirs.make("engine-allocator-");
    fs.writeFileSync(
      path.join(root, "docker"),
      `#!${process.execPath}
process.stdout.write(JSON.stringify({ allocator: process.env.MALLOC_CONF ?? null, preload: process.env.LD_PRELOAD ?? null }));
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH}`);
    vi.stubEnv("MALLOC_CONF", "background_thread:true");
    vi.stubEnv("LD_PRELOAD", "/synthetic/libjemalloc.so.2");
    const baseEnv = captured ? { ...process.env } : undefined;
    const result = await execContainerRaw(
      { id: "docker", command: "docker", displayName: "Docker", baseEnv },
      ["version"],
    );
    expect(JSON.parse(result.stdout.toString())).toEqual({ allocator: null, preload: null });
    expect(result.stderr.toString()).toBe("");
    expect(process.env.MALLOC_CONF).toBe("background_thread:true");
    expect(baseEnv?.LD_PRELOAD).toBe(captured ? "/synthetic/libjemalloc.so.2" : undefined);
  },
);

import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { MuseCatalogReader } from "./verify-setup.js";

it.runIf(process.platform !== "win32")(
  "closes a catalog host cancelled during initialization",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "muse-catalog-"));
    const fixture = fileURLToPath(new URL("./test-support/fake-muse.mjs", import.meta.url));
    const reader = new MuseCatalogReader();
    const server = createServer();
    const initialized = new Promise<{ pid: number; resume: () => void }>((resolve) => {
      server.once("connection", (socket) => {
        socket.once("data", (data) =>
          resolve({ pid: Number(data.toString()), resume: () => socket.write("resume") }),
        );
      });
    });
    const gatePath = join(workspace, "initialize.sock");
    await new Promise<void>((resolve) => {
      server.listen(gatePath, resolve);
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", workspace);
    vi.stubEnv("MUSE_FIXTURE_INITIALIZE_GATE", gatePath);
    const controller = new AbortController();
    try {
      const verification = reader.verify({
        config: { plugins: { entries: { muse: { config: { binaryPath: fixture } } } } },
        workspaceDir: workspace,
        provider: "meta",
        modelId: "muse-spark-1.3",
        signal: controller.signal,
        assertCurrent: () => {},
      });
      const rejected = expect(verification).rejects.toThrow();
      const child = await initialized;
      controller.abort();
      child.resume();
      await rejected;
      expect(() => process.kill(child.pid, 0)).toThrow();
    } finally {
      await reader.dispose();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      vi.unstubAllEnvs();
      await rm(workspace, { recursive: true, force: true });
    }
  },
);

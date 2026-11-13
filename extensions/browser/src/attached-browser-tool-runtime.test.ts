import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBrowserTool: vi.fn().mockReturnValue({ name: "browser" }),
  startBrowserBridgeServer: vi.fn().mockResolvedValue({
    baseUrl: "http://127.0.0.1:18443",
    server: { marker: "bridge-server" },
  }),
  stopBrowserBridgeServer: vi.fn().mockResolvedValue(undefined),
  closePlaywrightBrowserConnection: vi.fn().mockResolvedValue(undefined),
}));

// mock-isolation: capture tool construction without loading the real browser execution graph.
vi.mock("./browser-tool.js", () => ({ createBrowserTool: mocks.createBrowserTool }));
vi.mock("./browser/bridge-server.js", () => ({
  startBrowserBridgeServer: mocks.startBrowserBridgeServer,
  stopBrowserBridgeServer: mocks.stopBrowserBridgeServer,
}));
vi.mock("./browser/pw-session.js", () => ({
  closePlaywrightBrowserConnection: mocks.closePlaywrightBrowserConnection,
}));

import { createAttachedBrowserToolRuntime as createRuntime } from "./attached-browser-tool-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const cdpUrl = "http://127.0.0.1:9222";
const defaults = { cdpUrl, ensureAttachTarget: async () => {}, workspaceDir: "/tmp/workspace" };

beforeEach(() => vi.clearAllMocks());

it("uses the authenticated attach-only bridge and preserves normalized artifact names", async () => {
  const ensureAttachTarget = vi.fn().mockResolvedValue(undefined);
  const workspaceDir = tempDirs.make("attached-workspace-");
  const context = { workspaceDir, agentSessionKey: "agent:w:s", agentDir: "/tmp/w" };
  await createRuntime({ ...defaults, ...context, ensureAttachTarget });

  const bridgeParams = mocks.startBrowserBridgeServer.mock.calls[0]?.[0];
  expect(bridgeParams.host).toBe("127.0.0.1");
  expect(bridgeParams.authToken).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
  expect(bridgeParams.resolved.defaultProfile).toBe("worker");
  expect(bridgeParams.resolved.profiles).toEqual({
    worker: { driver: "openclaw", attachOnly: true, cdpUrl },
  });

  await bridgeParams.onEnsureAttachTarget();
  expect(ensureAttachTarget).toHaveBeenCalledOnce();
  const toolParams = mocks.createBrowserTool.mock.calls[0]?.[0];
  expect(toolParams).toMatchObject({
    sandboxBridgeUrl: "http://127.0.0.1:18443",
    allowHostControl: false,
    ...context,
    screenshotResultMode: "path",
  });
  const persist = (sourcePath: string) => toolParams.persistScreenshot({ sourcePath, type: "png" });
  const sourcePath = path.join(workspaceDir, "source.jpg");
  await fs.writeFile(sourcePath, "screenshot-bytes");
  const artifactPath = await persist(sourcePath);
  expect(artifactPath.replaceAll("\\", "/")).toMatch(
    /\.artifacts\/cloud-worker-browser\/screenshot-[a-f0-9]{16}\.jpg$/u,
  );
  expect(await fs.readFile(artifactPath, "utf8")).toBe("screenshot-bytes");
  if (process.platform !== "win32") {
    expect((await fs.stat(artifactPath)).mode & 0o777).toBe(0o600);
  }
  const filesBeforeFailure = await fs.readdir(path.dirname(artifactPath));
  await expect(persist(path.join(workspaceDir, "missing.png"))).rejects.toThrow();
  expect(await fs.readdir(path.dirname(artifactPath))).toEqual(filesBeforeFailure);
});

it("retries exact Playwright CDP adapter disposal after a failed disconnect", async () => {
  const runtime = await createRuntime({ ...defaults, workspaceDir: tempDirs.make("attached-") });
  mocks.closePlaywrightBrowserConnection.mockRejectedValueOnce(new Error("disconnect failed"));

  await expect(runtime.dispose()).rejects.toThrow("disconnect failed");
  await expect(runtime.dispose()).resolves.toBeUndefined();

  expect(mocks.stopBrowserBridgeServer.mock.calls).toEqual([
    [{ marker: "bridge-server" }],
    [{ marker: "bridge-server" }],
  ]);
  expect(mocks.closePlaywrightBrowserConnection.mock.calls).toEqual([[{ cdpUrl }], [{ cdpUrl }]]);
});

it.runIf(process.platform !== "win32")("rejects artifact symlink escapes", async () => {
  const workspaceDir = tempDirs.make("attached-workspace-");
  const outsideDir = tempDirs.make("attached-browser-outside-");
  await fs.symlink(outsideDir, path.join(workspaceDir, ".artifacts"));
  await createRuntime({ ...defaults, workspaceDir });
  const toolParams = mocks.createBrowserTool.mock.calls.at(-1)?.[0];
  const sourcePath = path.join(workspaceDir, "source.png");
  await fs.writeFile(sourcePath, "screenshot-bytes");

  await expect(toolParams.persistScreenshot({ sourcePath, type: "png" })).rejects.toThrow();
  expect(await fs.readdir(outsideDir)).toEqual([]);
});

it.each([
  "http://localhost:9222",
  "https://127.0.0.1:9222",
  "http://127.0.0.1",
  "http://127.0.0.1:9222/devtools/browser/target",
])("rejects non-canonical raw CDP URL %s before starting a bridge", async (url) => {
  await expect(createRuntime({ ...defaults, cdpUrl: url })).rejects.toThrow(
    "loopback HTTP URL with an explicit port",
  );
  expect(mocks.startBrowserBridgeServer).not.toHaveBeenCalled();
});

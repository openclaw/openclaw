import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { QaMockProviderServer } from "./providers/index.js";
import { captureQaMockProviderRequests } from "./suite-provider-artifacts.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

const tempDirs = createTempDirHarness();
const { makeTempDir } = tempDirs;

afterEach(async () => {
  fetchWithSsrFGuardMock.mockReset();
  await tempDirs.cleanup();
});

it("retains mock provider requests in the QA artifact directory", async () => {
  const outputDir = await makeTempDir("qa-provider-artifacts-");
  const requests = [{ cursor: 1, model: "fixture-model", requestKind: "initial" }];
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValue({ response: Response.json(requests), release });

  await captureQaMockProviderRequests({
    outputDir,
    providerMode: "mock-openai",
    provider: { baseUrl: "http://127.0.0.1:18789" } as QaMockProviderServer,
  });

  expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
    url: "http://127.0.0.1:18789/debug/requests",
    maxRedirects: 0,
    timeoutMs: 15_000,
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-mock-provider-request-artifact",
  });
  expect(release).toHaveBeenCalledOnce();
  await expect(
    fs.readFile(path.join(outputDir, "artifacts", "mock-openai-requests.json"), "utf8"),
  ).resolves.toBe(`${JSON.stringify(requests, null, 2)}\n`);
});

it("does not request artifacts from live providers", async () => {
  await captureQaMockProviderRequests({
    outputDir: await makeTempDir("qa-live-provider-artifacts-"),
    providerMode: "live-frontier",
  });

  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { QaMockProviderServer } from "./providers/index.js";
import {
  captureQaMockProviderRequests,
  QA_MOCK_PROVIDER_REQUESTS_ARTIFACT,
} from "./suite-provider-artifacts.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const tempDirs = createTempDirHarness();
const { makeTempDir } = tempDirs;

afterEach(async () => {
  vi.unstubAllGlobals();
  await tempDirs.cleanup();
});

it("retains mock provider requests in the QA artifact directory", async () => {
  const outputDir = await makeTempDir("qa-provider-artifacts-");
  const requests = [{ cursor: 1, model: "fixture-model", requestKind: "initial" }];
  const fetchMock = vi.fn(async () => Response.json(requests));
  vi.stubGlobal("fetch", fetchMock);

  await captureQaMockProviderRequests({
    outputDir,
    providerMode: "mock-openai",
    provider: { baseUrl: "http://127.0.0.1:18789" } as QaMockProviderServer,
  });

  expect(fetchMock).toHaveBeenCalledWith(new URL("http://127.0.0.1:18789/debug/requests"));
  await expect(
    fs.readFile(path.join(outputDir, QA_MOCK_PROVIDER_REQUESTS_ARTIFACT), "utf8"),
  ).resolves.toBe(`${JSON.stringify(requests, null, 2)}\n`);
});

it("does not request artifacts from live providers", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);

  await captureQaMockProviderRequests({
    outputDir: await makeTempDir("qa-live-provider-artifacts-"),
    providerMode: "live-frontier",
  });

  expect(fetchMock).not.toHaveBeenCalled();
});

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
  ).resolves.toBe(JSON.stringify(requests));
});

it.each(["http", "stream"] as const)(
  "preserves the prior artifact when capture fails at the %s boundary",
  async (failure) => {
    const outputDir = await makeTempDir("qa-provider-artifact-failure-");
    const artifactDir = path.join(outputDir, "artifacts");
    const artifactPath = path.join(artifactDir, "mock-openai-requests.json");
    const previous = '[{"cursor":1,"raw":"retained evidence"}]\n';
    await fs.mkdir(artifactDir);
    await fs.writeFile(artifactPath, previous);
    let chunks = 0;
    const response =
      failure === "http"
        ? new Response("capture failed", { status: 500 })
        : new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (chunks++ === 0) {
                  controller.enqueue(new TextEncoder().encode('[{"cursor":2},'));
                } else {
                  controller.error(new Error("request stream interrupted"));
                }
              },
            }),
          );
    const release = vi.fn(async () => {});
    fetchWithSsrFGuardMock.mockResolvedValue({ response, release });

    await expect(
      captureQaMockProviderRequests({
        outputDir,
        providerMode: "mock-openai",
        provider: { baseUrl: "http://127.0.0.1:18789" } as QaMockProviderServer,
      }),
    ).rejects.toThrow(failure === "http" ? /HTTP 500/ : /stream interrupted/);
    await expect(fs.readFile(artifactPath, "utf8")).resolves.toBe(previous);
    await expect(fs.readdir(artifactDir)).resolves.toEqual(["mock-openai-requests.json"]);
    expect(release).toHaveBeenCalledOnce();
  },
);

it("does not request artifacts from live providers", async () => {
  await captureQaMockProviderRequests({
    outputDir: await makeTempDir("qa-live-provider-artifacts-"),
    providerMode: "live-frontier",
  });

  expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
});

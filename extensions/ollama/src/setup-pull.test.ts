import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { jsonResponse, withServer } from "openclaw/plugin-sdk/test-env";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  readOllamaModelShowInfo,
} from "./provider-models.js";
import { pullOllamaModel } from "./setup-pull.js";
import { checkOllamaCloudAuth } from "./setup.runtime.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const baseUrl = "http://127.0.0.1:11434";
const pull = (url: string) =>
  pullOllamaModel(
    url,
    "gemma4:e2b",
    createTestWizardPrompter({ progress: () => ({ update: vi.fn(), stop: vi.fn() }) }),
  );
const failedPull = async (url: string) => {
  await expect(pull(url)).resolves.toBe(false);
};
const unavailable = "ollama unavailable";
const diskFull = '{"error":"disk full"}\n';

async function waitForSocketClose(closed: Promise<void> | undefined): Promise<void> {
  if (!closed) {
    throw new Error("Ollama test server did not receive a request");
  }
  await raceWithTimeout(closed, 2_000, () => {
    throw new Error("Ollama response socket was not closed");
  });
}

afterEach(() => fetchWithSsrFGuardMock.mockReset());

describe("Ollama setup response cleanup", () => {
  it.each([
    [
      "model inspection error",
      unavailable,
      503,
      () => readOllamaModelShowInfo(baseUrl, "gemma4:e2b").catch(() => undefined),
    ],
    ["model discovery error", unavailable, 503, () => fetchOllamaModels(baseUrl)],
    ["auth probe fallback", unavailable, 503, () => checkOllamaCloudAuth(baseUrl)],
    ["pull response error", unavailable, 503, () => pull(baseUrl)],
    ["pull stream error", diskFull, 200, () => pull(baseUrl)],
  ] as const)(
    "releases a %s while capture retains a response clone",
    async (_name, body, status, run) => {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
        },
      });
      const response = new Response(source, { status });
      const captureClone = response.clone();
      const release = vi.fn(async () => {});
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response,
        finalUrl: "http://127.0.0.1:11434/api/test",
        release,
      });

      try {
        await raceWithTimeout<Awaited<ReturnType<typeof run>>, never>(run(), 500, () => {
          throw new Error("Ollama cleanup waited for a captured response clone");
        });
        expect(response.bodyUsed).toBe(true);
        expect(release).toHaveBeenCalledOnce();
      } finally {
        await captureClone.body?.cancel().catch(() => undefined);
      }
    },
  );

  it("joins sibling model-probe cleanup before rejecting with the original cancellation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("model discovery canceled");
    const firstCleanup = createDeferred<void>();
    const siblingCleanup = createDeferred<void>();
    const firstRelease = vi.fn(() => firstCleanup.promise);
    const siblingRelease = vi.fn(() => siblingCleanup.promise);
    for (const release of [firstRelease, siblingRelease]) {
      fetchWithSsrFGuardMock.mockResolvedValueOnce({
        response: jsonResponse({ capabilities: ["completion"] }),
        finalUrl: "http://127.0.0.1:11434/api/show",
        release,
      });
    }
    let settled = false;
    let failure: unknown;
    const completed = enrichOllamaModelsWithContext(
      "http://127.0.0.1:11434",
      [{ name: "first-model" }, { name: "sibling-model" }],
      { signal: controller.signal },
    ).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        failure = error;
        settled = true;
      },
    );
    try {
      await vi.waitFor(() => {
        expect(firstRelease).toHaveBeenCalledOnce();
        expect(siblingRelease).toHaveBeenCalledOnce();
      });
      controller.abort(cancellation);
      firstCleanup.reject(new Error("first request closed"));
      await nextTurn();
      expect(settled).toBe(false);

      siblingCleanup.reject(new Error("sibling request closed"));
      await completed;
      expect(settled).toBe(true);
      expect(failure).toBe(cancellation);
    } finally {
      firstCleanup.resolve();
      siblingCleanup.resolve();
      await completed;
    }
  });

  it.each([
    ["successful auth probe", "/api/me", 200, '{"status":"unused"}\n', checkOllamaCloudAuth],
    ["failed auth probe", "/api/me", 503, unavailable, checkOllamaCloudAuth],
    ["failed pull response", "/api/pull", 503, unavailable, failedPull],
    ["streamed pull error", "/api/pull", 200, diskFull, failedPull],
  ] as const)("closes the real socket after a %s", async (_name, path, status, body, run) => {
    let requestSocketClosed: Promise<void> | undefined;
    await withServer(
      (request, response) => {
        if (request.url !== path) {
          response.writeHead(404);
          response.end();
          return;
        }
        requestSocketClosed = new Promise<void>((resolve) => {
          request.socket.once("close", () => resolve());
        });
        response.writeHead(status, { "content-type": "application/json" });
        response.write(body);
      },
      async (url) => {
        fetchWithSsrFGuardMock.mockImplementation(
          async (params: { url: string; init?: RequestInit; signal?: AbortSignal }) => ({
            response: await globalThis.fetch(params.url, {
              ...params.init,
              ...(params.signal ? { signal: params.signal } : {}),
            }),
            finalUrl: params.url,
            release: async () => {},
          }),
        );

        await run(url);
        await waitForSocketClose(requestSocketClosed);
      },
    );
  });
});

function mockPull(body: BodyInit, update: () => void = vi.fn()) {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValue({ response: new Response(body), release });
  const progress = { update, stop: vi.fn() };
  const prompter = createTestWizardPrompter({ progress: () => progress });
  return async (ok: boolean, message: unknown = "Downloaded gemma4:e2b") => {
    await expect(pullOllamaModel(baseUrl, "gemma4:e2b", prompter)).resolves.toBe(ok);
    expect(progress.stop).toHaveBeenCalledWith(message);
    expect(release).toHaveBeenCalledOnce();
  };
}

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return { ...actual, fetchWithSsrFGuard: fetchWithSsrFGuardMock };
});

describe("Ollama onboarding model pulls", () => {
  it("uses the canonical Ollama model request field and requires its success terminal", async () => {
    const check = mockPull('{"status":"pulling manifest"}\n{"status":"success"}\n');
    await check(true);

    const request = fetchWithSsrFGuardMock.mock.calls[0]?.[0] as { init?: { body?: string } };
    expect(JSON.parse(request.init?.body ?? "null")).toEqual({ model: "gemma4:e2b" });
  });

  it.each([
    {
      label: "interrupted model layer",
      body: '{"status":"pulling abcdef123456","total":100,"completed":40}\n',
    },
    { label: "malformed stream", body: "not valid json\n" },
    { label: "incomplete trailing record", body: '{"status":"success"' },
  ])("does not report a completed model pull for an $label", async ({ body }) => {
    await mockPull(body)(false, "Failed to download gemma4:e2b: pull stream ended before success");
  });

  it.each([
    { label: "unterminated success", body: '{"status":"success"}' },
    {
      label: "malformed progress before success",
      body: 'null\nnot valid json\n{"status":"success"}',
    },
    {
      label: "tolerantly decoded progress before success",
      body: new Uint8Array([
        ...new TextEncoder().encode('{"status":"pulling '),
        0xff,
        ...new TextEncoder().encode('"}\n{"status":"success"}'),
      ]),
    },
  ])("accepts $label", async ({ body }) => {
    await mockPull(body)(true);
  });

  it.each([
    { status: "pulling manifest" },
    { status: "pulling abcdef123456", total: 100, completed: 40 },
  ])("reports progress failures instead of a successful pull for %j", async (chunk) => {
    const check = mockPull(
      `${JSON.stringify(chunk)}\n{"status":"success"}\n`,
      vi.fn(() => {
        throw new Error("progress display failed");
      }),
    );
    await check(false, "Failed to download gemma4:e2b: progress display failed");
  });

  it("coerces non-Error stream failures through the shared error contract", async () => {
    const check = mockPull(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error({ code: "OLLAMA_PULL_INTERRUPTED" });
        },
      }),
    );
    await check(
      false,
      expect.stringContaining("Failed to download gemma4:e2b: Non-Error rejection"),
    );
  });

  it("cancels an oversized unterminated pull record", async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let readCount = 0;
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        readCount += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    });
    await mockPull(body)(
      false,
      "Failed to download gemma4:e2b: Ollama NDJSON record exceeds 16777216 bytes",
    );

    expect(readCount).toBeGreaterThan(16);
    expect(readCount).toBeLessThan(32);
    expect(canceled).toBe(true);
    expect(body.locked).toBe(false);
  });
});

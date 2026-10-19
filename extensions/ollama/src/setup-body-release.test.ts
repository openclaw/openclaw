import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WizardPrompter } from "openclaw/plugin-sdk/setup";
import { jsonResponse, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  readOllamaModelShowInfo,
} from "./provider-models.js";
import { pullOllamaModel } from "./setup-pull.js";
import { checkOllamaCloudAuth } from "./setup.runtime.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

function createPullPrompter(): WizardPrompter {
  return {
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  } as unknown as WizardPrompter;
}

const baseUrl = "http://127.0.0.1:11434";
const pull = (url: string) => pullOllamaModel(url, "gemma4:e2b", createPullPrompter());
const failedPull = async (url: string) => {
  await expect(pull(url)).resolves.toBe(false);
};
const unavailable = "ollama unavailable";
const diskFull = '{"error":"disk full"}\n';

async function expectReleaseWithoutWaitingForCapture(params: {
  body: string;
  status: number;
  run: () => Promise<unknown>;
}): Promise<void> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(params.body));
    },
  });
  const response = new Response(source, { status: params.status });
  const captureClone = response.clone();
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response,
    finalUrl: "http://127.0.0.1:11434/api/test",
    release,
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      params.run(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Ollama cleanup waited for a captured response clone"));
        }, 500);
      }),
    ]);
    expect(response.bodyUsed).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await captureClone.body?.cancel().catch(() => undefined);
  }
}

async function waitForSocketClose(closed: Promise<void> | undefined): Promise<void> {
  if (!closed) {
    throw new Error("Ollama test server did not receive a request");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error("Ollama response socket was not closed"));
        }, 2_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

describe("Ollama setup response cleanup", () => {
  afterEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

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
      await expectReleaseWithoutWaitingForCapture({ body, run, status });
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

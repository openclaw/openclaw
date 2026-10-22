import { createTestWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pullOllamaModel } from "./setup-pull.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const baseUrl = "http://127.0.0.1:11434";

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
  afterEach(() => fetchWithSsrFGuardMock.mockReset());

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

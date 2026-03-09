import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { resolveImplicitProvidersForTest } from "./models-config.e2e-harness.js";

describe("provider discovery auth marker guardrails", () => {
  let originalVitest: string | undefined;
  let originalNodeEnv: string | undefined;
  let originalFetch: typeof globalThis.fetch | undefined;

  afterEach(() => {
    if (originalVitest !== undefined) {
      process.env.VITEST = originalVitest;
    } else {
      delete process.env.VITEST;
    }
    if (originalNodeEnv !== undefined) {
      process.env.NODE_ENV = originalNodeEnv;
    } else {
      delete process.env.NODE_ENV;
    }
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
  });

  function enableDiscovery() {
    originalVitest = process.env.VITEST;
    originalNodeEnv = process.env.NODE_ENV;
    originalFetch = globalThis.fetch;
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
  }

  it("does not send marker value as vLLM bearer token during discovery", async () => {
    enableDiscovery();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "vllm:default": {
              type: "api_key",
              provider: "vllm",
              keyRef: { source: "file", provider: "vault", id: "/vllm/apiKey" },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir, env: {} });
    expect(providers?.vllm?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    const request = fetchMock.mock.calls[0]?.[1] as
      | { headers?: Record<string, string> }
      | undefined;
    expect(request?.headers?.Authorization).toBeUndefined();
  });

  it("does not call Hugging Face discovery with marker-backed credentials", async () => {
    enableDiscovery();
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "huggingface:default": {
              type: "api_key",
              provider: "huggingface",
              keyRef: { source: "exec", provider: "vault", id: "providers/hf/token" },
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const providers = await resolveImplicitProvidersForTest({ agentDir, env: {} });
    expect(providers?.huggingface?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    const huggingfaceCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("router.huggingface.co"),
    );
    expect(huggingfaceCalls).toHaveLength(0);
  });

  it("keeps all-caps plaintext API keys for authenticated discovery", async () => {
    enableDiscovery();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "vllm/test-model" }] }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    await writeFile(
      join(agentDir, "auth-profiles.json"),
      JSON.stringify(
        {
          version: 1,
          profiles: {
            "vllm:default": {
              type: "api_key",
              provider: "vllm",
              key: "ALLCAPS_SAMPLE",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    await resolveImplicitProvidersForTest({ agentDir, env: {} });
    const vllmCall = fetchMock.mock.calls.find(([url]) => String(url).includes(":8000"));
    const request = vllmCall?.[1] as { headers?: Record<string, string> } | undefined;
    expect(request?.headers?.Authorization).toBe("Bearer ALLCAPS_SAMPLE");
  });
});

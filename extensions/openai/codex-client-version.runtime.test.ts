import fs from "node:fs";
import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolveOpenAICodexModelsEndpoint as ResolveEndpoint } from "./codex-client-version.runtime.js";

let resolveOpenAICodexModelsEndpoint: typeof ResolveEndpoint;

// The test owns this repository file; JSON.parse returns `any`, so the annotation is the shape.
const codexPackage: { dependencies: Record<string, string> } = JSON.parse(
  fs.readFileSync(new URL("../codex/package.json", import.meta.url), "utf8"),
);
const PINNED_VERSION = codexPackage.dependencies["@openai/codex"];

async function resolveClientVersion(
  params: Parameters<typeof resolveOpenAICodexModelsEndpoint>[0],
): Promise<string | null> {
  return new URL(await resolveOpenAICodexModelsEndpoint(params)).searchParams.get("client_version");
}

function npmGuard(responses: Response[]) {
  return vi.fn<LiveModelCatalogFetchGuard>(async (request) => ({
    response: responses.shift() ?? new Response("unexpected", { status: 500 }),
    finalUrl: request.url,
    release: async () => undefined,
  }));
}

describe("resolveOpenAICodexModelsEndpoint", () => {
  beforeEach(async () => {
    // The version cache is module state; each case loads a fresh module instance.
    vi.resetModules();
    ({ resolveOpenAICodexModelsEndpoint } = await import("./codex-client-version.runtime.js"));
  });

  it("reports the newest stable Codex release and reuses it within the cache window", async () => {
    let now = 1_000;
    const fetchGuard = npmGuard([
      Response.json({ version: "999.1.0" }),
      Response.json({ version: "999.2.0" }),
    ]);

    await expect(resolveClientVersion({ fetchGuard, now: () => now })).resolves.toBe("999.1.0");
    now += 60 * 60 * 1000;
    await expect(resolveClientVersion({ fetchGuard, now: () => now })).resolves.toBe("999.1.0");
    now += 6 * 60 * 60 * 1000;
    await expect(resolveClientVersion({ fetchGuard, now: () => now })).resolves.toBe("999.2.0");
    expect(fetchGuard).toHaveBeenCalledTimes(2);
    expect(fetchGuard.mock.calls[0]?.[0]).toMatchObject({
      url: "https://registry.npmjs.org/@openai/codex/latest",
      requireHttps: true,
    });
  });

  it("shares one npm request between concurrent discoveries", async () => {
    const fetchGuard = npmGuard([Response.json({ version: "999.1.0" })]);

    const versions = await Promise.all([
      resolveClientVersion({ fetchGuard }),
      resolveClientVersion({ fetchGuard }),
    ]);

    expect(versions).toEqual(["999.1.0", "999.1.0"]);
    expect(fetchGuard).toHaveBeenCalledOnce();
  });

  it.each([
    ["npm is unavailable", new Response("down", { status: 503 })],
    ["latest is a prerelease", Response.json({ version: "999.0.0-alpha.1" })],
    ["latest is older than the pin", Response.json({ version: "0.0.1" })],
  ])("keeps the pinned version when %s", async (_case, response) => {
    const fetchGuard = npmGuard([response]);

    await expect(resolveClientVersion({ fetchGuard })).resolves.toBe(PINNED_VERSION);
  });

  it("retries npm soon after a failure instead of pinning the fallback for hours", async () => {
    let now = 1_000;
    const fetchGuard = npmGuard([
      new Response("down", { status: 503 }),
      Response.json({ version: "999.1.0" }),
    ]);

    await expect(resolveClientVersion({ fetchGuard, now: () => now })).resolves.toBe(
      PINNED_VERSION,
    );
    await expect(resolveClientVersion({ fetchGuard, now: () => now })).resolves.toBe(
      PINNED_VERSION,
    );
    now += 5 * 60 * 1000 + 1;
    await expect(resolveClientVersion({ fetchGuard, now: () => now })).resolves.toBe("999.1.0");
    expect(fetchGuard).toHaveBeenCalledTimes(2);
  });

  it("keeps the last npm version when a later refresh fails", async () => {
    let now = 1_000;
    const fetchGuard = npmGuard([
      Response.json({ version: "999.1.0" }),
      new Response("down", { status: 503 }),
    ]);

    await expect(resolveClientVersion({ fetchGuard, now: () => now })).resolves.toBe("999.1.0");
    now += 6 * 60 * 60 * 1000 + 1;
    await expect(resolveClientVersion({ fetchGuard, now: () => now })).resolves.toBe("999.1.0");
    expect(fetchGuard).toHaveBeenCalledTimes(2);
  });
});

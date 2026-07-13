import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fetchWorkspaceGallery,
  installWorkspaceGalleryWidget,
  parseWorkspaceGalleryConfig,
  type WorkspaceGalleryFetch,
} from "./gallery.js";
import { resolveWidgetDir } from "./manifest.js";
import { WorkspaceStore } from "./store.js";

function guardedResponse(response: Response, finalUrl: string) {
  return { response, finalUrl, release: vi.fn(async () => {}) };
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function registry(bundleUrl = "https://gallery.example/widgets/weather.json") {
  return {
    schemaVersion: 1,
    apps: [
      {
        id: "weather",
        title: "Weather",
        description: "A forecast card",
        bundleUrl,
      },
    ],
  };
}

function bundle() {
  return {
    schemaVersion: 1,
    name: "weather",
    manifest: {
      schemaVersion: 1,
      name: "weather",
      title: "Weather",
      entrypoint: "index.html",
      bindings: [],
      capabilities: ["data:read"],
    },
    files: { "index.html": "<!doctype html><title>Weather</title>" },
  };
}

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-workspace-gallery-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("parseWorkspaceGalleryConfig", () => {
  it("accepts only explicit HTTPS origins", () => {
    expect(
      parseWorkspaceGalleryConfig({ gallery: { allowedOrigins: ["https://gallery.example"] } }),
    ).toEqual({ allowedOrigins: ["https://gallery.example"] });
    expect(() =>
      parseWorkspaceGalleryConfig({ gallery: { allowedOrigins: ["http://gallery.example"] } }),
    ).toThrow(/HTTPS origin/);
    expect(() =>
      parseWorkspaceGalleryConfig({
        gallery: { allowedOrigins: ["https://user@gallery.example"] },
      }),
    ).toThrow(/HTTPS origin/);
    expect(() =>
      parseWorkspaceGalleryConfig({
        gallery: { allowedOrigins: ["https://gallery.example/catalog"] },
      }),
    ).toThrow(/HTTPS origin/);
  });
});

describe("fetchWorkspaceGallery", () => {
  it("uses guarded credential-free fetches and returns a bounded registry", async () => {
    const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
      guardedResponse(jsonResponse(registry()), options.url),
    );
    await expect(
      fetchWorkspaceGallery("https://gallery.example/index.json", {
        allowedOrigins: ["https://gallery.example"],
        fetchGuard,
      }),
    ).resolves.toEqual(registry());
    expect(fetchGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://gallery.example/index.json",
        requireHttps: true,
        maxRedirects: 0,
        timeoutMs: 5_000,
        init: { method: "GET", headers: { Accept: "application/json" }, redirect: "manual" },
      }),
    );
  });

  it("rejects an unapproved redirect before making a second request", async () => {
    const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
      guardedResponse(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/registry.json" },
        }),
        options.url,
      ),
    );
    await expect(
      fetchWorkspaceGallery("https://gallery.example/index.json", {
        allowedOrigins: ["https://gallery.example"],
        fetchGuard,
      }),
    ).rejects.toThrow(/origin is not allowed/);
    expect(fetchGuard).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON and invalid or oversized registries", async () => {
    const nonJson = vi.fn<WorkspaceGalleryFetch>(async (options) =>
      guardedResponse(
        new Response("ok", { headers: { "content-type": "text/plain" } }),
        options.url,
      ),
    );
    await expect(
      fetchWorkspaceGallery("https://gallery.example/index.json", {
        allowedOrigins: ["https://gallery.example"],
        fetchGuard: nonJson,
      }),
    ).rejects.toThrow(/application\/json/);

    const badBundleUrl = vi.fn<WorkspaceGalleryFetch>(async (options) =>
      guardedResponse(jsonResponse(registry("https://evil.example/widget.json")), options.url),
    );
    await expect(
      fetchWorkspaceGallery("https://gallery.example/index.json", {
        allowedOrigins: ["https://gallery.example"],
        fetchGuard: badBundleUrl,
      }),
    ).rejects.toThrow(/origin is not allowed/);

    const oversized = vi.fn<WorkspaceGalleryFetch>(async (options) =>
      guardedResponse(
        new Response("x".repeat(256 * 1024 + 1), {
          headers: { "content-type": "application/json" },
        }),
        options.url,
      ),
    );
    await expect(
      fetchWorkspaceGallery("https://gallery.example/index.json", {
        allowedOrigins: ["https://gallery.example"],
        fetchGuard: oversized,
      }),
    ).rejects.toThrow(/exceeds 262144 bytes/);
  });
});

describe("installWorkspaceGalleryWidget", () => {
  it("installs validated files as pending without activating code", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
        guardedResponse(jsonResponse(bundle()), options.url),
      );
      const result = await installWorkspaceGalleryWidget(
        "https://gallery.example/widgets/weather.json",
        {
          allowedOrigins: ["https://gallery.example"],
          fetchGuard,
          stateDir,
          store,
          actor: "user",
        },
      );
      expect(result.registry).toEqual({ status: "pending", createdBy: "user" });
      expect(result.registry.status).not.toBe("approved");
      expect(
        await fs.readFile(path.join(resolveWidgetDir("weather", stateDir), "index.html"), "utf8"),
      ).toContain("Weather");
    });
  });

  it("rejects unsafe bundles without creating a registry entry", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const unsafe = { ...bundle(), files: { "index.html": "ok", "../escape.js": "bad" } };
      const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
        guardedResponse(jsonResponse(unsafe), options.url),
      );
      await expect(
        installWorkspaceGalleryWidget("https://gallery.example/widgets/weather.json", {
          allowedOrigins: ["https://gallery.example"],
          fetchGuard,
          stateDir,
          store,
          actor: "user",
        }),
      ).rejects.toThrow(/file path is invalid/);
      expect(store.read().widgetsRegistry.weather).toBeUndefined();
    });
  });

  it("rejects a missing manifest with a schema error", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
        guardedResponse(
          jsonResponse({
            schemaVersion: 1,
            name: "weather",
            files: { "index.html": "ok" },
          }),
          options.url,
        ),
      );
      await expect(
        installWorkspaceGalleryWidget("https://gallery.example/widgets/weather.json", {
          allowedOrigins: ["https://gallery.example"],
          fetchGuard,
          stateDir,
          store,
          actor: "user",
        }),
      ).rejects.toThrow(/manifest must be an object/);
    });
  });

  it("rejects oversized bundle responses before writing files", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
        guardedResponse(
          new Response("x".repeat(512 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          }),
          options.url,
        ),
      );
      await expect(
        installWorkspaceGalleryWidget("https://gallery.example/widgets/weather.json", {
          allowedOrigins: ["https://gallery.example"],
          fetchGuard,
          stateDir,
          store,
          actor: "user",
        }),
      ).rejects.toThrow(/exceeds 524288 bytes/);
      expect(store.read().widgetsRegistry.weather).toBeUndefined();
    });
  });
});

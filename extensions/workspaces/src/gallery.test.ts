import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolvePinnedHostnameWithPolicy,
  resolveSsrFPolicyForUrl,
  type LookupFn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  fetchWorkspaceGallery,
  installWorkspaceGalleryWidget,
  parseWorkspaceGalleryConfig,
  type WorkspaceGalleryFetch,
} from "./gallery.js";
import { resolveWidgetDir } from "./manifest.js";
import { scaffoldWorkspaceWidget } from "./scaffold.js";
import { WorkspaceStore } from "./store.js";
import { withWidgetInstallLock } from "./widget-install-lock.js";

function guardedResponse(response: Response, finalUrl: string) {
  return { response, finalUrl, release: vi.fn(async () => {}) };
}

function jsonResponse(value: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers,
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
  it("does not trust an allowlisted origin to resolve to a private address", async () => {
    const lookupFn = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }]) as unknown as LookupFn;
    const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) => {
      const url = new URL(options.url);
      await resolvePinnedHostnameWithPolicy(url.hostname, {
        lookupFn,
        policy: resolveSsrFPolicyForUrl(url, options.policy),
      });
      return guardedResponse(jsonResponse(registry()), options.url);
    });

    await expect(
      fetchWorkspaceGallery("https://gallery.example/index.json", {
        allowedOrigins: ["https://gallery.example"],
        fetchGuard,
      }),
    ).rejects.toThrow(/private|internal|blocked/i);
  });

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
  it("rejects a bundle name that resolves to the widgets root", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const unsafe = {
        ...bundle(),
        name: ".",
        manifest: { ...bundle().manifest, name: "." },
      };
      const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
        guardedResponse(jsonResponse(unsafe), options.url),
      );

      await expect(
        installWorkspaceGalleryWidget("https://gallery.example/widgets/root.json", {
          allowedOrigins: ["https://gallery.example"],
          fetchGuard,
          stateDir,
          store,
          actor: "user",
        }),
      ).rejects.toThrow(/name is invalid/);
    });
  });

  it("rejects a symlinked widgets root without writing through it", async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gallery-outside-"));
    try {
      await withTempStateDir(async (stateDir) => {
        const store = new WorkspaceStore({ stateDir });
        const widgetsRoot = path.join(stateDir, "workspaces", "widgets");
        await fs.symlink(outsideDir, widgetsRoot, "dir");
        const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
          guardedResponse(jsonResponse(bundle()), options.url),
        );

        await expect(
          installWorkspaceGalleryWidget("https://gallery.example/widgets/weather.json", {
            allowedOrigins: ["https://gallery.example"],
            fetchGuard,
            stateDir,
            store,
            actor: "user",
          }),
        ).rejects.toThrow(/unsafe|symbolic link|path alias/i);
        await expect(fs.stat(path.join(outsideDir, "weather"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        expect(store.read().widgetsRegistry.weather).toBeUndefined();
      });
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("never exposes a partially written final widget directory", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const files = Object.fromEntries(
        Array.from({ length: 64 }, (_, index) => [
          index === 0 ? "index.html" : `asset-${index}.js`,
          "x".repeat(4_096),
        ]),
      );
      const expectedFiles = [...Object.keys(files), "widget.json"];
      const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
        guardedResponse(jsonResponse({ ...bundle(), files }), options.url),
      );
      const widgetDir = resolveWidgetDir("weather", stateDir);
      let settled = false;
      let observedPartial = false;

      const install = installWorkspaceGalleryWidget(
        "https://gallery.example/widgets/weather.json",
        {
          allowedOrigins: ["https://gallery.example"],
          fetchGuard,
          stateDir,
          store,
          actor: "user",
        },
      ).finally(() => {
        settled = true;
      });
      for (;;) {
        if (settled) {
          break;
        }
        try {
          const observed = await fs.readdir(widgetDir, { recursive: true });
          if (!expectedFiles.every((file) => observed.includes(file))) {
            observedPartial = true;
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
        }
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      await install;

      expect(observedPartial).toBe(false);
      await expect(fs.readdir(widgetDir)).resolves.toEqual(expect.arrayContaining(expectedFiles));
    });
  });

  it("serializes gallery installation with scaffolding for the same widget name", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const widgetsRoot = path.join(stateDir, "workspaces", "widgets");
      await fs.mkdir(widgetsRoot, { recursive: true });
      let releaseReservation!: () => void;
      let reservationAcquired!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseReservation = resolve;
      });
      const acquired = new Promise<void>((resolve) => {
        reservationAcquired = resolve;
      });
      const reservation = withWidgetInstallLock("weather", stateDir, async () => {
        reservationAcquired();
        await release;
      });
      await acquired;

      let gallerySettled = false;
      let scaffoldSettled = false;
      const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
        guardedResponse(jsonResponse(bundle()), options.url),
      );
      const gallery = installWorkspaceGalleryWidget(
        "https://gallery.example/widgets/weather.json",
        {
          allowedOrigins: ["https://gallery.example"],
          fetchGuard,
          stateDir,
          store,
          actor: "user",
        },
      ).finally(() => {
        gallerySettled = true;
      });
      const scaffold = scaffoldWorkspaceWidget({
        name: "weather",
        title: "Scaffold Weather",
        stateDir,
        createdBy: "user",
      }).finally(() => {
        scaffoldSettled = true;
      });

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(gallerySettled).toBe(false);
      expect(scaffoldSettled).toBe(false);

      releaseReservation();
      await reservation;
      const results = await Promise.allSettled([gallery, scaffold]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const files = (await fs.readdir(resolveWidgetDir("weather", stateDir))).toSorted();
      expect([
        ["index.html", "widget.json"],
        ["README.md", "index.html", "widget.json"],
      ]).toContainEqual(files);
    });
  });

  it("removes staging directories after a nested file write fails", async () => {
    await withTempStateDir(async (stateDir) => {
      const store = new WorkspaceStore({ stateDir });
      const tooLongName = `${"x".repeat(256)}.js`;
      const fetchGuard = vi.fn<WorkspaceGalleryFetch>(async (options) =>
        guardedResponse(
          jsonResponse({
            ...bundle(),
            files: {
              "index.html": "<!doctype html><title>Weather</title>",
              [`nested/${tooLongName}`]: "export {};",
            },
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
      ).rejects.toThrow();

      await expect(fs.readdir(path.join(stateDir, "workspaces", "widgets"))).resolves.toEqual([]);
      expect(store.read().widgetsRegistry.weather).toBeUndefined();
    });
  });

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

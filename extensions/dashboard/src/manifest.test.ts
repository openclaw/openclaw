import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWidgetManifest, resolveWidgetDir, validateWidgetManifest } from "./manifest.js";

async function withTempStateDir<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dashboard-manifest-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function writeManifest(stateDir: string, name: string, manifest: unknown): Promise<void> {
  const dir = path.join(stateDir, "dashboard", "widgets", name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "widget.json"), JSON.stringify(manifest));
}

const VALID_MANIFEST = {
  schemaVersion: 1,
  name: "revenue-chart",
  title: "Revenue Chart",
  entrypoint: "index.html",
  bindings: [{ id: "rev", source: "file", path: "q3.json" }],
  capabilities: ["data:read"],
  preferredSize: { w: 6, h: 4 },
};

describe("validateWidgetManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(validateWidgetManifest(VALID_MANIFEST)).toEqual(VALID_MANIFEST);
  });

  it("rejects a future schemaVersion", () => {
    expect(() => validateWidgetManifest({ ...VALID_MANIFEST, schemaVersion: 2 })).toThrow(
      /schemaVersion must be 1/,
    );
  });

  it("rejects an invalid widget name charset", () => {
    expect(() => validateWidgetManifest({ ...VALID_MANIFEST, name: "../evil" })).toThrow(
      /name is invalid/,
    );
  });

  it("rejects an rpc binding whose method is not allowlisted", () => {
    expect(() =>
      validateWidgetManifest({
        ...VALID_MANIFEST,
        bindings: [{ id: "x", source: "rpc", method: "sessions.delete" }],
      }),
    ).toThrow(/not allowlisted/);
  });

  it("accepts an allowlisted rpc binding", () => {
    const manifest = validateWidgetManifest({
      ...VALID_MANIFEST,
      bindings: [{ id: "s", source: "rpc", method: "sessions.list" }],
    });
    expect(manifest.bindings[0]).toEqual({ id: "s", source: "rpc", method: "sessions.list" });
  });

  it("rejects a file binding path that traverses out of the data jail", () => {
    expect(() =>
      validateWidgetManifest({
        ...VALID_MANIFEST,
        bindings: [{ id: "x", source: "file", path: "../../etc/passwd" }],
      }),
    ).toThrow();
  });

  it("rejects an entrypoint that escapes the widget dir", () => {
    expect(() =>
      validateWidgetManifest({ ...VALID_MANIFEST, entrypoint: "../index.html" }),
    ).toThrow();
  });

  it("rejects an unknown capability", () => {
    expect(() =>
      validateWidgetManifest({ ...VALID_MANIFEST, capabilities: ["data:write"] }),
    ).toThrow(/capability is invalid/);
  });

  it("accepts the prompt:send capability", () => {
    const manifest = validateWidgetManifest({
      ...VALID_MANIFEST,
      capabilities: ["data:read", "prompt:send"],
    });
    expect(manifest.capabilities).toEqual(["data:read", "prompt:send"]);
  });

  it("rejects duplicate binding ids", () => {
    expect(() =>
      validateWidgetManifest({
        ...VALID_MANIFEST,
        bindings: [
          { id: "dup", source: "static", value: 1 },
          { id: "dup", source: "static", value: 2 },
        ],
      }),
    ).toThrow(/duplicate binding id/);
  });

  it("rejects unexpected top-level keys", () => {
    expect(() => validateWidgetManifest({ ...VALID_MANIFEST, extra: true })).toThrow(
      /is not allowed/,
    );
  });

  it("rejects a name that does not match the directory when expected", () => {
    expect(() => validateWidgetManifest(VALID_MANIFEST, "other-name")).toThrow(
      /does not match its directory/,
    );
  });
});

describe("resolveWidgetDir", () => {
  it("rejects a name with a path separator", () => {
    expect(() => resolveWidgetDir("a/b")).toThrow(/name is invalid/);
  });

  it("rejects a traversal name", () => {
    expect(() => resolveWidgetDir("..")).toThrow(/name is invalid/);
  });

  it("resolves a valid name under the widgets root", () => {
    const dir = resolveWidgetDir("revenue-chart", "/tmp/state");
    expect(dir).toBe(path.resolve("/tmp/state", "dashboard", "widgets", "revenue-chart"));
  });
});

describe("loadWidgetManifest", () => {
  it("loads and validates a manifest from disk", async () => {
    await withTempStateDir(async (stateDir) => {
      await writeManifest(stateDir, "revenue-chart", VALID_MANIFEST);
      const manifest = await loadWidgetManifest("revenue-chart", { stateDir });
      expect(manifest?.name).toBe("revenue-chart");
    });
  });

  it("returns null when the manifest is absent", async () => {
    await withTempStateDir(async (stateDir) => {
      expect(await loadWidgetManifest("missing", { stateDir })).toBeNull();
    });
  });

  it("throws when the manifest name does not match its directory", async () => {
    await withTempStateDir(async (stateDir) => {
      await writeManifest(stateDir, "revenue-chart", { ...VALID_MANIFEST, name: "spoofed" });
      await expect(loadWidgetManifest("revenue-chart", { stateDir })).rejects.toThrow(
        /does not match its directory/,
      );
    });
  });

  it("throws on invalid JSON", async () => {
    await withTempStateDir(async (stateDir) => {
      const dir = path.join(stateDir, "dashboard", "widgets", "broken");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "widget.json"), "{ not json");
      await expect(loadWidgetManifest("broken", { stateDir })).rejects.toThrow(/not valid JSON/);
    });
  });
});

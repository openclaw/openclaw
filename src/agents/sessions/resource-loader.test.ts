// Resource loader tests cover prompt loading and bounded reads.
import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearExtensionCache } from "./extensions/loader.js";
import { DefaultResourceLoader } from "./resource-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ExtensionCacheTestState = {
  factoryRuns: number;
  moduleLoads: number;
};

function extensionCacheTestState(): ExtensionCacheTestState {
  return (
    globalThis as typeof globalThis & { openclawExtensionCacheTestState: ExtensionCacheTestState }
  ).openclawExtensionCacheTestState;
}

function extensionSource(command: string): string {
  return `
const state = (globalThis.openclawExtensionCacheTestState ??= { factoryRuns: 0, moduleLoads: 0 });
state.moduleLoads += 1;

export default function extension(api) {
  state.factoryRuns += 1;
  api.registerCommand(${JSON.stringify(command)}, {
    description: "cache probe",
    handler() {},
  });
}
`;
}

afterEach(() => {
  clearExtensionCache();
  Reflect.deleteProperty(globalThis, "openclawExtensionCacheTestState");
});

describe("DefaultResourceLoader", () => {
  it("reuses extension modules between loaders and refreshes them on reload", async () => {
    const root = tempDirs.make("openclaw-resource-loader-extension-");
    const extensionPath = path.join(root, "extension.ts");
    await writeFile(extensionPath, extensionSource("before-reload"));
    const createLoader = () =>
      new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        additionalExtensionPaths: [extensionPath],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

    const firstLoader = createLoader();
    await firstLoader.reload();
    const secondLoader = createLoader();
    await secondLoader.reload();

    expect(extensionCacheTestState()).toEqual({ factoryRuns: 2, moduleLoads: 1 });
    expect(secondLoader.getExtensions().extensions[0]?.commands.has("before-reload")).toBe(true);

    await writeFile(extensionPath, extensionSource("after-reload"));
    await secondLoader.reload();

    expect(extensionCacheTestState()).toEqual({ factoryRuns: 3, moduleLoads: 2 });
    expect(secondLoader.getExtensions().extensions[0]?.commands.has("after-reload")).toBe(true);
  });

  it("does not use unreadable prompt file paths as prompt content", async () => {
    const root = tempDirs.make("openclaw-resource-loader-");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: root,
        appendSystemPrompt: [root],
      });

      await loader.reload();

      expect(loader.getSystemPrompt()).toBeUndefined();
      expect(loader.getAppendSystemPrompt()).toEqual([]);
      // readTextFileSafely logs once for each non-regular-file path (2 calls).
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("rejects oversized system prompt files", async () => {
    const root = tempDirs.make("openclaw-resource-loader-");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    // Write a file exceeding the 10 MiB prompt input limit.
    const oversizedPath = path.join(root, "SYSTEM.md");
    fs.writeFileSync(oversizedPath, Buffer.alloc(11 * 1024 * 1024));

    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: oversizedPath,
      });

      await loader.reload();

      // Oversized file should not be read — system prompt remains undefined.
      expect(loader.getSystemPrompt()).toBeUndefined();
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("File too large"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("accepts system prompt files within the byte limit", async () => {
    const root = tempDirs.make("openclaw-resource-loader-");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const promptPath = path.join(root, "SYSTEM.md");
    const promptContent = "You are a helpful assistant.";
    fs.writeFileSync(promptPath, promptContent, "utf8");

    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: promptPath,
      });

      await loader.reload();

      expect(loader.getSystemPrompt()).toBe(promptContent);
      expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("File too large"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("loads large AGENTS.md files during context file loading", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = tempDirs.make("openclaw-resource-loader-ctx-");

    // Write an AGENTS.md larger than 1 MiB — project-context files are loaded
    // without a size cap to preserve existing project instructions.
    const agentsPath = path.join(root, "AGENTS.md");
    const largeContent = Buffer.alloc(2 * 1024 * 1024);
    const marker = Buffer.from("# Large project rules\n");
    marker.copy(largeContent, 0);
    fs.writeFileSync(agentsPath, largeContent);

    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: false,
      });

      await loader.reload();

      // The large AGENTS.md should be loaded (no size cap for context files).
      const foundOversized = loader.getAgentsFiles().agentsFiles.some((f) => f.path === agentsPath);
      expect(foundOversized).toBe(true);
      // The "File too large" warning should NOT appear for context files.
      expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("File too large"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("loads AGENTS.md files within the byte limit", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = tempDirs.make("openclaw-resource-loader-ctx-");

    const agentsContent = "# Project rules\n\nBe helpful.";
    const agentsPath = path.join(root, "AGENTS.md");
    fs.writeFileSync(agentsPath, agentsContent, "utf8");

    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: false,
      });

      await loader.reload();

      const found = loader.getAgentsFiles().agentsFiles.find((f) => f.path === agentsPath);
      expect(found).toBeDefined();
      expect(found!.content).toBe(agentsContent);
      expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("File too large"));
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not warn when context file candidates are missing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = tempDirs.make("openclaw-resource-loader-ctx-");

    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: false,
      });

      await loader.reload();

      // The ancestor walk probes AGENTS.md/CLAUDE.md candidates in every parent
      // directory; missing files must be skipped silently, matching the previous
      // existsSync-gated behavior (no "Could not read" warning spam at startup).
      const couldNotReadCalls = consoleError.mock.calls.filter((call) =>
        call.some((arg) => typeof arg === "string" && arg.includes("Could not read")),
      );
      expect(couldNotReadCalls).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

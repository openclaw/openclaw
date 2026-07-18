// Resource loader tests cover prompt loading and transforms.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { DefaultResourceLoader } from "./resource-loader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("DefaultResourceLoader", () => {
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
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });
});

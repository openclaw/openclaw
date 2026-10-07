import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { prepareHarnessContextMedia } from "./context-media-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("prepareHarnessContextMedia", () => {
  it("marks an unrestorable historical image neutrally instead of asking for a resend", async () => {
    const workspaceDir = tempDirs.make("openclaw-context-media-");
    const message = {
      role: "user" as const,
      content: "what is this?",
      timestamp: 1,
      __openclaw: {
        media: [{ path: path.join(workspaceDir, "gone.png"), contentType: "image/png" }],
      },
    };

    const result = await prepareHarnessContextMedia({
      message,
      maxChars: 10_000,
      workspaceDir,
      modelInput: ["text", "image"],
      assertCurrent: () => {},
    });

    expect(result.images).toEqual([]);
    expect(result.text?.split("\n\n").at(-1)).toBe(
      "[1 referenced image not included in this context]",
    );
  });
});

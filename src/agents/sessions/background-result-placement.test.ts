import { queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import { resolveGlobalSet } from "../../shared/global-singleton.js";
import { createTestSession } from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { createBackgroundResultPlacement } from "./background-result-placement.js";
import { SessionManager } from "./session-manager.js";

const listeners = resolveGlobalSet(
  Symbol.for("openclaw.internalSessionTranscriptListeners"),
  "close-and-restart",
);

it("does not register a transcript listener when session construction fails", async () => {
  const baseline = new Set(listeners);
  const resourceLoader = await createResourceLoader();
  vi.spyOn(resourceLoader, "getExtensions").mockImplementation(() => {
    throw new Error("extension runtime unavailable");
  });
  try {
    await expect(createTestSession({ resourceLoader })).rejects.toThrow(
      "extension runtime unavailable",
    );
    expect(listeners.size).toBe(baseline.size);
  } finally {
    for (const listener of listeners) {
      if (!baseline.has(listener)) {
        listeners.delete(listener);
      }
    }
  }
});

it("does not retain a transcript manager through an abandoned placement listener", () => {
  const baseline = queryObjects(SessionManager);
  const disposers = Array.from(
    { length: 8 },
    () => createBackgroundResultPlacement(SessionManager.inMemory()).dispose,
  );
  try {
    expect(queryObjects(SessionManager)).toBe(baseline);
  } finally {
    disposers.forEach((dispose) => dispose());
  }
});

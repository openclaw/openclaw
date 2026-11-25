import { onTestFinished } from "vitest";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import type { CodexCatalogIndexOptions } from "./session-catalog-index-contract.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";

export function catalogClient(
  respond?: (request: { method: string; params: CodexThreadListParams }) => unknown,
) {
  const harness = createClientHarness({
    onWrite(line, send) {
      const request = JSON.parse(line);
      const result = respond?.(request);
      if (result !== undefined) {
        send({ id: request.id, result });
      }
    },
  });
  onTestFinished(async () => {
    await harness.client.closeAndWait();
  });
  return harness;
}

export function catalogIndex(options: Omit<CodexCatalogIndexOptions, "assertCurrent">) {
  const index = new CodexCatalogIndex({ ...options, assertCurrent: () => {} });
  onTestFinished(() => index.close());
  return index;
}

export function catalogThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: "thread-1",
    projectId: null,
    source: "cli",
    updatedAt: 100,
    recencyAt: 100,
    status: { type: "idle" },
    ...overrides,
  };
}

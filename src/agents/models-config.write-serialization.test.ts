import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUSTOM_PROXY_MODELS_CONFIG,
  installModelsConfigTestHooks,
  withModelsTempHome,
} from "./models-config.e2e-harness.js";
import { readGeneratedModelsJson } from "./models-config.test-utils.js";

const { planMullusiModelsJsonMock } = vi.hoisted(() => ({
  planMullusiModelsJsonMock: vi.fn(),
}));

vi.mock("./models-config.plan.js", () => ({
  planMullusiModelsJson: (...args: unknown[]) => planMullusiModelsJsonMock(...args),
}));

installModelsConfigTestHooks();

let ensureMullusiModelsJson: typeof import("./models-config.js").ensureMullusiModelsJson;

beforeEach(async () => {
  vi.resetModules();
  planMullusiModelsJsonMock.mockImplementation(
    async (params: { cfg?: typeof CUSTOM_PROXY_MODELS_CONFIG }) => ({
      action: "write",
      contents: `${JSON.stringify({ providers: params.cfg?.models?.providers ?? {} }, null, 2)}\n`,
    }),
  );
  ({ ensureMullusiModelsJson } = await import("./models-config.js"));
});

describe("models-config write serialization", () => {
  it("serializes concurrent models.json writes to avoid overlap", async () => {
    await withModelsTempHome(async () => {
      const first = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const second = structuredClone(CUSTOM_PROXY_MODELS_CONFIG);
      const firstModel = first.models?.providers?.["custom-proxy"]?.models?.[0];
      const secondModel = second.models?.providers?.["custom-proxy"]?.models?.[0];
      if (!firstModel || !secondModel) {
        throw new Error("custom-proxy fixture missing expected model entries");
      }
      firstModel.name = "Proxy A";
      secondModel.name = "Proxy B with longer name";

      const originalWriteFile = fs.writeFile.bind(fs);
      let inFlightWrites = 0;
      let maxInFlightWrites = 0;
      const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
        const targetArg = args[0];
        const targetPath =
          typeof targetArg === "string"
            ? targetArg
            : targetArg instanceof URL
              ? targetArg.pathname
              : undefined;
        const isModelsTempWrite =
          typeof targetPath === "string" &&
          path.basename(targetPath).startsWith("models.json.") &&
          targetPath.endsWith(".tmp");
        if (isModelsTempWrite) {
          inFlightWrites += 1;
          if (inFlightWrites > maxInFlightWrites) {
            maxInFlightWrites = inFlightWrites;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        try {
          return await originalWriteFile(...args);
        } finally {
          if (isModelsTempWrite) {
            inFlightWrites -= 1;
          }
        }
      });

      try {
        await Promise.all([ensureMullusiModelsJson(first), ensureMullusiModelsJson(second)]);
      } finally {
        writeSpy.mockRestore();
      }

      expect(maxInFlightWrites).toBe(1);
      const parsed = await readGeneratedModelsJson<{
        providers: { "custom-proxy"?: { models?: Array<{ name?: string }> } };
      }>();
      expect(parsed.providers["custom-proxy"]?.models?.[0]?.name).toBe("Proxy B with longer name");
    });
  }, 60_000);
});

import type { ToolResultObject } from "@github/copilot-sdk";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { convertOpenClawToolToSdkToolForTest, runSdkTool } from "./tool-bridge.test-support.js";

// Synthetic, non-usable credential fixture for model-visible redaction coverage.
const SYNTHETIC_BEARER_CREDENTIAL = "bearer-model-visible-credential-1234567890";

type FakeTool = AnyAgentTool & {
  execute: ReturnType<typeof vi.fn>;
};

function makeTool(
  overrides: Partial<FakeTool> = {},
  result: { content?: unknown; details: unknown } = {
    content: [{ text: "done", type: "text" }],
    details: null,
  },
): FakeTool {
  return {
    description: "A fake tool",
    execute: vi.fn(async () => result),
    label: "Fake Tool",
    name: "tool-a",
    parameters: {
      properties: { value: { type: "string" } },
      type: "object",
    } as never,
    ...overrides,
  } as unknown as FakeTool;
}

function getError(result: ToolResultObject): string | undefined {
  return result.error;
}

describe("model-visible Copilot tool-bridge redaction", () => {
  it("redacts credentials from model-visible successful tool-bridge results", async () => {
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool(
        {},
        {
          content: [
            {
              type: "text",
              text: `Deployment finished.\nAuthorization: Bearer ${SYNTHETIC_BEARER_CREDENTIAL}`,
            },
            { data: "base64-data", mimeType: "image/png", type: "image" },
          ],
          details: null,
        },
      ),
      {},
    );

    const result = (await runSdkTool(sdkTool, {})) as ToolResultObject;

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(result.textResultForLlm).toContain("Authorization: Bearer");
    expect(result.textResultForLlm).toContain("Deployment finished.");
    expect(result.binaryResultsForLlm).toEqual([
      {
        data: "base64-data",
        mimeType: "image/png",
        type: "image",
      },
    ]);
  });

  it("redacts credentials split across adjacent model-visible tool text items", async () => {
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool(
        {},
        {
          content: [
            { type: "text", text: "Deployment finished.\nAuthorization: Bearer " },
            { type: "text", text: SYNTHETIC_BEARER_CREDENTIAL },
            { type: "text", text: "\nArtifacts remain available." },
          ],
          details: null,
        },
      ),
      {},
    );

    const result = (await runSdkTool(sdkTool, {})) as ToolResultObject;

    expect(result.resultType).toBe("success");
    expect(result.textResultForLlm).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(result.textResultForLlm).toContain("Authorization: Bearer");
    expect(result.textResultForLlm).toContain("Artifacts remain available.");
  });

  it("redacts credentials from model-visible failed tool-bridge results", async () => {
    const sdkTool = await convertOpenClawToolToSdkToolForTest(
      makeTool({
        execute: vi.fn(async () => {
          throw new Error(`Upstream failed: Authorization: Bearer ${SYNTHETIC_BEARER_CREDENTIAL}`);
        }),
      }),
      {},
    );

    const result = (await runSdkTool(sdkTool, {})) as ToolResultObject;

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(getError(result)).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
    expect(result.textResultForLlm).toContain("Authorization: Bearer");
    expect(result.textResultForLlm).toContain("[copilot-tool-bridge] tool 'tool-a' failed:");
  });

  it("keeps an own __proto__ resource key as data instead of promoting inherited blob fields", async () => {
    const { sanitizeModelVisibleToolContent } =
      await import("./tool-bridge-model-visible-sanitize.js");
    const resourcePayload: Record<string, unknown> = {
      text: `Authorization: Bearer ${SYNTHETIC_BEARER_CREDENTIAL}`,
    };
    Object.defineProperty(resourcePayload, "__proto__", {
      value: { blob: "evil-blob", mimeType: "image/png" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    expect(Object.hasOwn(resourcePayload, "__proto__")).toBe(true);
    const sanitized = sanitizeModelVisibleToolContent([
      { type: "resource", resource: resourcePayload },
    ]);
    const resource = (sanitized as Array<Record<string, unknown>>)[0]?.resource as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(resource, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(resource)).toBe(Object.prototype);
    expect(Object.hasOwn(resource, "blob")).toBe(false);
    expect(typeof resource.text).toBe("string");
    expect(String(resource.text)).not.toContain(SYNTHETIC_BEARER_CREDENTIAL);
  });
});

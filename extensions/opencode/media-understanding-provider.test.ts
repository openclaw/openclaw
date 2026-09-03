// Opencode tests cover media understanding provider plugin behavior.
import { describe, expect, it } from "vitest";
import { opencodeMediaUnderstandingProvider } from "./media-understanding-provider.js";

async function applyImagePayloadTransform(payload: Record<string, unknown>): Promise<void> {
  await opencodeMediaUnderstandingProvider.imagePayloadTransform?.(payload, {} as never);
}

describe("opencode media understanding provider", () => {
  it("strips disabled Responses reasoning payloads", async () => {
    const payload = {
      reasoning: { effort: "none" },
      include: ["reasoning.encrypted_content"],
      store: false,
    };

    await applyImagePayloadTransform(payload);

    expect(payload).toEqual({
      include: ["reasoning.encrypted_content"],
      store: false,
    });
  });

  it("keeps supported Responses reasoning payloads", async () => {
    const payload = {
      reasoning: { effort: "low" },
      store: false,
    };

    await applyImagePayloadTransform(payload);

    expect(payload).toEqual({
      reasoning: { effort: "low" },
      store: false,
    });
  });

  it("declares OpenCode image understanding support", () => {
    expect(opencodeMediaUnderstandingProvider.id).toBe("opencode");
    expect(opencodeMediaUnderstandingProvider.capabilities).toEqual(["image"]);
    expect(opencodeMediaUnderstandingProvider.defaultModels).toEqual({ image: "gpt-5-nano" });
    // Hooks come from registry hydration so the transform covers all of them.
    expect(opencodeMediaUnderstandingProvider.describeImage).toBeUndefined();
    expect(typeof opencodeMediaUnderstandingProvider.imagePayloadTransform).toBe("function");
  });
});

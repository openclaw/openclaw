// Discord tests cover agent component reply diagnostics behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { replySilently } from "./agent-components-reply.js";
import type { AgentComponentInteraction } from "./agent-components.types.js";

function createMockInteraction(throws: boolean): AgentComponentInteraction {
  return {
    reply: vi.fn(async () => {
      if (throws) throw new Error("Unknown interaction (expired)");
    }),
  } as unknown as AgentComponentInteraction;
}

describe("replySilently", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it("calls interaction.reply and does not warn on success", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const interaction = createMockInteraction(false);

    await replySilently(interaction, { content: "ok" });

    expect(interaction.reply).toHaveBeenCalledWith({ content: "ok" });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("logs console.warn when interaction.reply throws", async () => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const interaction = createMockInteraction(true);

    await replySilently(interaction, { content: "will fail" });

    expect(warnSpy).toHaveBeenCalledWith(
      "discord component reply failed",
      "Unknown interaction (expired)",
    );
  });
});

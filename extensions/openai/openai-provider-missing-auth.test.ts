import { afterEach, describe, expect, it, vi } from "vitest";

const FUTURE_DEFAULT_MODEL = "openai/gpt-next-default";

describe("OpenAI missing auth message", () => {
  afterEach(() => {
    vi.doUnmock("./model-default-refs.js");
    vi.resetModules();
  });

  it("uses the common OpenAI default model in the ChatGPT/Codex OAuth hint", async () => {
    vi.resetModules();
    vi.doMock("./model-default-refs.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./model-default-refs.js")>()),
      OPENAI_DEFAULT_MODEL: FUTURE_DEFAULT_MODEL,
      OPENAI_CODEX_DEFAULT_MODEL: FUTURE_DEFAULT_MODEL,
    }));

    const { buildOpenAIProvider } = await import("./openai-provider.js");
    const provider = buildOpenAIProvider();
    const message = provider.buildMissingAuthMessage?.({
      provider: "openai",
      listProfileIds: (providerId: string) => (providerId === "openai" ? ["openai:codex"] : []),
    } as never);

    expect(message).toContain(`Use ${FUTURE_DEFAULT_MODEL} with the ChatGPT/Codex OAuth profile`);
  });
});

import { describe, expect, it, vi } from "vitest";
import { emitModelTransportDebug } from "./model-transport-debug.js";

describe("emitModelTransportDebug", () => {
  function createLogger() {
    return {
      info: vi.fn(),
      debug: vi.fn(),
    } as unknown as Parameters<typeof emitModelTransportDebug>[0];
  }

  it("emits model-fetch metadata at info level by default", () => {
    const log = createLogger();

    emitModelTransportDebug(
      log,
      "[model-fetch] response provider=openai api=chat model=gpt status=200 latencyMs=42",
    );

    expect(log.info).toHaveBeenCalledWith(
      "[model-fetch] response provider=openai api=chat model=gpt status=200 latencyMs=42",
    );
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("keeps non-model-fetch transport diagnostics at debug level by default", () => {
    const log = createLogger();

    emitModelTransportDebug(log, "[model-sse] event type=response.output_text.delta");

    expect(log.debug).toHaveBeenCalledWith("[model-sse] event type=response.output_text.delta");
    expect(log.info).not.toHaveBeenCalled();
  });
});

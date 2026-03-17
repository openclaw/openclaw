import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { deliverAgentCommandResult } from "./delivery.js";

describe("deliverAgentCommandResult silent completion", () => {
  it("keeps silent completions out of local logs when no payload is produced", async () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;

    await deliverAgentCommandResult({
      cfg: {} as never,
      deps: {} as never,
      runtime,
      opts: {
        message: "hello",
        deliver: false,
      } as never,
      outboundSession: undefined,
      sessionEntry: undefined,
      result: {
        payloads: [],
        meta: {
          durationMs: 1,
          silentCompletion: true,
        },
      } as never,
      payloads: [],
    });

    expect(runtime.log).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { castAgentMessages } from "./test-helpers/agent-message-fixtures.js";

const warnMock = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => {
  const makeLogger = () => ({
    subsystem: "agent/embedded",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: () => makeLogger(),
  });
  return { createSubsystemLogger: () => makeLogger() };
});

import { sanitizeSessionMessagesImages } from "./pi-embedded-helpers.js";

describe("sanitizeSessionMessagesImages logging", () => {
  beforeEach(() => {
    warnMock.mockClear();
  });

  it("warns when dropping unrecognized assistant replay object content", async () => {
    const input = castAgentMessages([
      {
        role: "assistant",
        content: { type: 42, payload: "unexpected-shape" },
        stopReason: "error",
        timestamp: 1,
      },
    ]);

    await sanitizeSessionMessagesImages(input, "test-replay");

    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(warnMock.mock.calls[0]?.[0]).toContain(
      "dropping unrecognized assistant replay content object during session sanitization",
    );
    expect(warnMock.mock.calls[0]?.[1]).toMatchObject({
      label: "test-replay",
      contentKeys: ["type", "payload"],
      typeType: "number",
      textType: "undefined",
    });
  });
});

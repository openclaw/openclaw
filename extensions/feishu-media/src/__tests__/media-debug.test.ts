import { describe, it, expect, vi } from "vitest";
import { createMediaDebugLogger } from "../media-debug.js";

describe("createMediaDebugLogger", () => {
  it("logs attachments with truncated paths", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createMediaDebugLogger();
    logger.logAttachments([
      { path: "/very/long/path/that/should/be/truncated/file.jpg", mime: "image/jpeg", index: 0 },
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0]!;
    expect(args[0]).toContain("[DEBUG-MU]");
    expect(args[1]).toContain("file.jpg");
    spy.mockRestore();
  });

  it("logs media config", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createMediaDebugLogger("[TEST]");
    logger.logMediaConfig({ audio: { enabled: true } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("[TEST]");
    spy.mockRestore();
  });

  it("logs provider registry keys", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createMediaDebugLogger();
    logger.logProviderRegistry(["groq", "deepgram"]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toContain("providerRegistry");
    spy.mockRestore();
  });
});

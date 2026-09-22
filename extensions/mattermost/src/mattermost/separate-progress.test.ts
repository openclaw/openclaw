import { describe, expect, it, vi } from "vitest";
import { createMattermostSeparateProgressController } from "./separate-progress.js";

function createController(params?: {
  enabled?: boolean;
  successfulFinal?: boolean;
  retainTerminalText?: (text: string) => Promise<boolean>;
}) {
  let successfulFinal = params?.successfulFinal ?? false;
  const retainTerminalText = vi.fn(params?.retainTerminalText ?? (async () => true));
  const logVerboseMessage = vi.fn();
  const controller = createMattermostSeparateProgressController({
    enabled: params?.enabled ?? true,
    pinnedLabel: "Progress",
    draftStream: { retainTerminalText },
    hasSuccessfulFinal: () => successfulFinal,
    logVerboseMessage,
  });
  return {
    controller,
    retainTerminalText,
    logVerboseMessage,
    markSuccessful: () => {
      successfulFinal = true;
    },
  };
}

describe("createMattermostSeparateProgressController", () => {
  it("owns one sanitized terminal failure update across final and turn settlement", async () => {
    const { controller, retainTerminalText } = createController();

    await controller.prepareFinal(true);
    await controller.settleFinal({ visibleReplySent: true }, true);
    await controller.settleTurnError();

    expect(retainTerminalText).toHaveBeenCalledExactlyOnceWith("Progress\n\nFailed.");
  });

  it("defers successful-final truth to the core lifecycle", async () => {
    const { controller, retainTerminalText, markSuccessful } = createController();

    markSuccessful();
    await controller.settleFinal({ visibleReplySent: true }, false);
    await controller.settleTurnError();

    expect(retainTerminalText).not.toHaveBeenCalled();
  });

  it("surfaces a missing terminal status when no visible final exists", async () => {
    const { controller } = createController({ retainTerminalText: async () => false });

    await expect(controller.settleFinal({ visibleReplySent: false }, false)).rejects.toThrow(
      "terminal progress was not retained",
    );
  });
});

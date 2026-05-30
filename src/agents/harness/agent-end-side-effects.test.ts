import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSkillWorkshopAutoCapture } from "../../skills/workshop/autocapture.js";
import { awaitAgentEndSideEffects, runAgentEndSideEffects } from "./agent-end-side-effects.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

vi.mock("../../skills/workshop/autocapture.js", () => ({
  runSkillWorkshopAutoCapture: vi.fn(),
}));

vi.mock("./lifecycle-hook-helpers.js", () => ({
  awaitAgentHarnessAgentEndHook: vi.fn(),
  runAgentHarnessAgentEndHook: vi.fn(),
}));

const mockAutoCapture = vi.mocked(runSkillWorkshopAutoCapture);
const mockAwaitAgentEndHook = vi.mocked(awaitAgentHarnessAgentEndHook);
const mockRunAgentEndHook = vi.mocked(runAgentHarnessAgentEndHook);

describe("agent end side effects", () => {
  beforeEach(() => {
    mockAutoCapture.mockReset();
    mockAwaitAgentEndHook.mockReset();
    mockRunAgentEndHook.mockReset();
  });

  it("fires plugin agent_end hooks without waiting for Skill Workshop auto-capture", async () => {
    let resolveCapture: (() => void) | undefined;
    mockAutoCapture.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCapture = resolve;
      }),
    );

    runAgentEndSideEffects({
      event: {
        messages: [],
        success: true,
      },
      ctx: {
        runId: "run-1",
        workspaceDir: "/workspace",
        config: {
          skills: {
            workshop: {
              autonomous: {
                enabled: true,
              },
            },
          },
        },
      },
    });

    expect(mockRunAgentEndHook).toHaveBeenCalledTimes(1);
    expect(mockAutoCapture).toHaveBeenCalledWith({
      event: {
        messages: [],
        success: true,
      },
      ctx: {
        runId: "run-1",
        workspaceDir: "/workspace",
        config: {
          skills: {
            workshop: {
              autonomous: {
                enabled: true,
              },
            },
          },
        },
      },
      config: {
        skills: {
          workshop: {
            autonomous: {
              enabled: true,
            },
          },
        },
      },
    });

    resolveCapture?.();
  });

  it("still runs agent_end hooks when Skill Workshop auto-capture fails", async () => {
    mockAutoCapture.mockRejectedValueOnce(new Error("capture failed"));

    await awaitAgentEndSideEffects({
      event: {
        messages: [],
        success: true,
      },
      ctx: {
        runId: "run-1",
        workspaceDir: "/workspace",
      },
    });

    expect(mockAutoCapture).toHaveBeenCalledWith({
      event: {
        messages: [],
        success: true,
      },
      ctx: {
        runId: "run-1",
        workspaceDir: "/workspace",
      },
    });
    expect(mockAwaitAgentEndHook).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { simulateDraftPlaybook } from "./draft-sandbox-simulator.js";

describe("simulateDraftPlaybook", () => {
  it("优先使用 proposal test_payload 作为 simulate 输入", async () => {
    const trigger = vi.fn(async (_pid, event, opts) => {
      expect(event).toEqual({ type: "draft.review.custom_test_playbook" });
      expect(opts?.variables).toEqual(
        expect.objectContaining({
          sensor_id: "line-1",
          value: 42,
          _simulate: true,
          _sandbox: true,
          _draft_review: true,
        }),
      );
      return { steps: [], status: "completed" as const };
    });

    const runtime = {
      playbookEngine: {
        load: vi.fn(),
        unload: vi.fn(),
        trigger,
      },
    };

    const yaml = [
      "id: custom_test_playbook",
      "trigger:",
      "  kind: event",
      "  pattern: sensor.reading_received",
      "steps: []",
    ].join("\n");

    const result = await simulateDraftPlaybook(runtime as never, {
      playbookYaml: yaml,
      playbookId: "custom_test_playbook",
      proposalId: "evolved_custom",
      testPayload: { sensor_id: "line-1", value: 42 },
    });

    expect(result.passed).toBe(true);
    expect(trigger).toHaveBeenCalled();
  });
});

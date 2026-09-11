import { describe, expect, it, vi } from "vitest";
import { isAcpOwnerRepairRequired } from "../acp/control-plane/manager.runtime-owner.js";
import { runSpawnPipeline } from "./spawn-pipeline.js";

describe("runSpawnPipeline", () => {
  it("preserves primary and fatal cleanup failures while releasing admission", async () => {
    const primary = new Error("primary initialization failure");
    const ownerRepair = Object.assign(new Error("repair ACP session ownership"), {
      detailCode: "SESSION_OWNER_MIGRATION_REQUIRED",
    });
    const release = vi.fn();

    const result = await runSpawnPipeline({
      adapter: {
        initialize: async () => {
          throw primary;
        },
        dispatchTurn: async () => ({ runId: "unreachable" }),
        cleanupOnFailure: async () => {
          throw ownerRepair;
        },
      },
      admissionReservation: { release },
      buildRegistration: () => {
        throw new Error("unreachable");
      },
      progressSessionKey: "agent:main:main",
    });

    expect(result).toMatchObject({ ok: false, phase: "initialize" });
    if (result.ok) {
      throw new Error("expected pipeline failure");
    }
    expect(result.error).toBeInstanceOf(AggregateError);
    expect((result.error as AggregateError).errors).toEqual([primary, ownerRepair]);
    expect(String(result.error)).toContain("primary initialization failure");
    expect(String(result.error)).toContain("repair ACP session ownership");
    expect(isAcpOwnerRepairRequired(result.error)).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});

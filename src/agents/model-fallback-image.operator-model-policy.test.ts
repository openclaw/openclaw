import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import { runWithImageModelFallback } from "./model-fallback-image.js";
import { prepareOperatorModelPolicy } from "./operator-model-policy.js";

const cfg: OpenClawConfig = {
  plugins: { enabled: false },
  agents: {
    entries: { main: {} },
    defaults: {
      model: "test-provider/allowed",
      models: { "test-provider/blocked": { alias: "blocked-alias" } },
      imageModel: {
        primary: "test-provider/blocked",
        fallbacks: ["test-provider/allowed", "test-provider/also-blocked", "test-provider/backup"],
      },
    },
  },
};

function operator(assertCurrent: () => void = () => {}) {
  return createAdmittedRunOperatorAuthority({
    profileId: "image-reader",
    scopes: ["operator.write"],
    assertCurrent,
    modelPolicy: prepareOperatorModelPolicy({
      cfg,
      policy: { sourceAgent: "main", allow: ["test-provider/allowed", "test-provider/backup"] },
      manifestPlugins: [],
    }),
  });
}

describe("operator model policy on image fallback", () => {
  it.each(["blocked-alias", "test-provider/blocked"])(
    "rejects explicit %s without trying a provider",
    async (modelOverride) => {
      const run = vi.fn();
      await expect(
        runWithImageModelFallback({
          cfg,
          manifestPlugins: [],
          operatorAuthority: operator(),
          modelOverride,
          run,
        }),
      ).rejects.toThrow("cannot use this model");
      expect(run).not.toHaveBeenCalled();
    },
  );

  it("keeps permitted configured fallbacks in order", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("try the next candidate"))
      .mockResolvedValueOnce("answer");
    await expect(
      runWithImageModelFallback({ cfg, manifestPlugins: [], operatorAuthority: operator(), run }),
    ).resolves.toMatchObject({ result: "answer", model: "backup" });
    expect(run.mock.calls).toEqual([
      ["test-provider", "allowed"],
      ["test-provider", "backup"],
    ]);
  });

  it("stops the chain when the original requester retires", async () => {
    let active = true;
    const authority = operator(() => {
      if (!active) {
        throw new Error("requester retired");
      }
    });
    const run = vi.fn(async () => {
      active = false;
      throw new Error("provider unavailable");
    });
    await expect(
      runWithImageModelFallback({ cfg, manifestPlugins: [], operatorAuthority: authority, run }),
    ).rejects.toThrow(/retired|no longer active/);
    expect(run).toHaveBeenCalledOnce();
  });

  it("preserves the configured default for an unrestricted operator", async () => {
    const run = vi.fn(async () => "answer");
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "staff-reader",
      scopes: ["operator.write"],
      assertCurrent: () => {},
    });
    await expect(
      runWithImageModelFallback({ cfg, manifestPlugins: [], operatorAuthority: authority, run }),
    ).resolves.toMatchObject({ result: "answer", model: "blocked" });
    expect(run).toHaveBeenCalledExactlyOnceWith("test-provider", "blocked");
  });
});

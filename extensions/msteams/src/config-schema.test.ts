import { describe, expect, it } from "vitest";
import { MSTeamsConfigSchema } from "../config-api.js";

describe("msteams config schema", () => {
  it("accepts replyStyle at global/team/channel levels", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "top-level",
      teams: {
        team123: {
          replyStyle: "thread",
          channels: {
            chan456: { replyStyle: "top-level" },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.replyStyle).toBe("top-level");
      expect(res.data.teams?.team123?.replyStyle).toBe("thread");
      expect(res.data.teams?.team123?.channels?.chan456?.replyStyle).toBe("top-level");
    }
  });

  it("rejects invalid replyStyle", () => {
    const res = MSTeamsConfigSchema.safeParse({
      replyStyle: "nope",
    });

    expect(res.success).toBe(false);
  });
});

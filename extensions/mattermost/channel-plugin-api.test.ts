import { describe, expect, it } from "vitest";

describe("mattermost bundled api seam", () => {
  it("loads the narrow channel plugin api", async () => {
    const mod = await import("./channel-plugin-api.js");

    expect(Object.keys(mod).toSorted()).toEqual(["mattermostPlugin", "mattermostSetupPlugin"]);
    expect(mod.mattermostPlugin.id).toBe("mattermost");
    expect(mod.mattermostSetupPlugin.id).toBe("mattermost");
  });
});

import { describe, expect, it } from "vitest";

import {
  type AuthProfileStore,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";

describe("resolveAuthProfileOrder", () => {
  const store: AuthProfileStore = {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-default",
      },
      "anthropic:work": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-work",
      },
    },
  };

  it("prioritizes preferred profiles", () => {
    const order = resolveAuthProfileOrder({
      store,
      provider: "anthropic",
      preferredProfile: "anthropic:work",
    });
    expect(order[0]).toBe("anthropic:work");
    expect(order).toContain("anthropic:default");
  });

  it("prioritizes last-good profile when no preferred override", () => {
    const order = resolveAuthProfileOrder({
      store: { ...store, lastGood: { anthropic: "anthropic:work" } },
      provider: "anthropic",
    });
    expect(order[0]).toBe("anthropic:work");
  });
});

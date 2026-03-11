import { describe, expect, it } from "vitest";
import { AgentEntrySchema } from "../../config/zod-schema.agent-runtime.js";
import { resolveAuthProfileOrder } from "./order.js";
import type { AuthProfileStore } from "./types.js";

describe("resolveAuthProfileOrder", () => {
  it("accepts base-provider credentials for volcengine-plan auth lookup", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "volcengine:default": {
          type: "api_key",
          provider: "volcengine",
          key: "sk-test",
        },
      },
    };

    const order = resolveAuthProfileOrder({
      store,
      provider: "volcengine-plan",
    });

    expect(order).toEqual(["volcengine:default"]);
  });

  it("places per-agent preferredProfile first in the order", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:account1": {
          type: "api_key",
          provider: "openai",
          key: "sk-1",
        },
        "openai:account2": {
          type: "api_key",
          provider: "openai",
          key: "sk-2",
        },
      },
    };

    const order = resolveAuthProfileOrder({
      store,
      provider: "openai",
      preferredProfile: "openai:account2",
    });

    // The preferred profile should be first in the ordering
    expect(order[0]).toBe("openai:account2");
    expect(order).toContain("openai:account1");
  });

  it("ignores preferredProfile that does not exist in store", () => {
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:account1": {
          type: "api_key",
          provider: "openai",
          key: "sk-1",
        },
      },
    };

    const order = resolveAuthProfileOrder({
      store,
      provider: "openai",
      preferredProfile: "openai:nonexistent",
    });

    expect(order).toEqual(["openai:account1"]);
  });

  it("per-agent binding overrides session-level profile via effectivePreferredProfile", () => {
    // Simulates the integration scenario where a per-agent binding (account2)
    // should take priority over a session-level preferred profile (account1).
    const store: AuthProfileStore = {
      version: 1,
      profiles: {
        "openai:account1": {
          type: "api_key",
          provider: "openai",
          key: "sk-1",
        },
        "openai:account2": {
          type: "api_key",
          provider: "openai",
          key: "sk-2",
        },
      },
    };

    // Session requests account1, but per-agent config binds to account2.
    const sessionPreferred = "openai:account1";
    const agentAuthBinding = "openai:account2";
    const effectivePreferred = agentAuthBinding || sessionPreferred;

    const order = resolveAuthProfileOrder({
      store,
      provider: "openai",
      preferredProfile: effectivePreferred,
    });

    // Per-agent binding (account2) must come first, not the session override (account1)
    expect(order[0]).toBe("openai:account2");
    expect(order).toContain("openai:account1");
  });
});

describe("AgentEntrySchema auth field", () => {
  it("accepts an agent entry with per-agent auth bindings", () => {
    const result = AgentEntrySchema.safeParse({
      id: "my-agent",
      auth: {
        openai: "openai:account2",
        anthropic: "anthropic:team-key",
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auth).toEqual({
        openai: "openai:account2",
        anthropic: "anthropic:team-key",
      });
    }
  });

  it("accepts an agent entry without auth field (backward compat)", () => {
    const result = AgentEntrySchema.safeParse({
      id: "my-agent",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.auth).toBeUndefined();
    }
  });

  it("rejects auth field with non-string values", () => {
    const result = AgentEntrySchema.safeParse({
      id: "my-agent",
      auth: {
        openai: 123,
      },
    });

    expect(result.success).toBe(false);
  });
});

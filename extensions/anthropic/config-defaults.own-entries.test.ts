import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { applyAnthropicConfigDefaults } from "./config-defaults.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type AgentModelEntryConfig = NonNullable<AgentDefaults["models"]>[string];

const inheritedRef = "anthropic/claude-sonnet-5";

function applyDefaultsWithInheritedModelRef(descriptor: PropertyDescriptor) {
  const priorDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, inheritedRef);
  Reflect.defineProperty(Object.prototype, inheritedRef, {
    configurable: true,
    ...descriptor,
  });

  try {
    const models = {
      "anthropic/claude-opus-4-6": {
        params: { cacheRetention: "short" },
      },
      "anthropic/claude-sonnet-4-6": {
        alias: "keep-own",
        params: { cacheRetention: "long" },
      },
    } satisfies Record<string, AgentModelEntryConfig>;

    return applyAnthropicConfigDefaults({
      config: {
        auth: {
          profiles: {
            "anthropic:default": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
        },
        agents: {
          defaults: {
            models,
          },
        },
      },
      env: {},
    }).agents?.defaults?.models;
  } finally {
    if (priorDescriptor) {
      Reflect.defineProperty(Object.prototype, inheritedRef, priorDescriptor);
    } else {
      Reflect.deleteProperty(Object.prototype, inheritedRef);
    }
  }
}

function expectSeededOwnEntry(nextModels: NonNullable<AgentDefaults["models"]> | undefined): void {
  expect(Object.hasOwn(nextModels ?? {}, inheritedRef)).toBe(true);
  expect(nextModels?.[inheritedRef]).toEqual({
    params: { cacheRetention: "short" },
  });
  expect(nextModels?.["anthropic/claude-sonnet-4-6"]).toEqual({
    alias: "keep-own",
    params: { cacheRetention: "long" },
  });
}

describe("Anthropic API-key default model own entries", () => {
  it.each([
    {
      descriptor: {
        value: { params: { cacheRetention: "long" } } satisfies AgentModelEntryConfig,
        writable: true,
      },
      name: "writable data descriptor",
    },
    {
      descriptor: {
        value: { params: { cacheRetention: "long" } } satisfies AgentModelEntryConfig,
        writable: false,
      },
      name: "non-writable data descriptor",
    },
    {
      descriptor: {
        get: () => ({ params: { cacheRetention: "long" } }) satisfies AgentModelEntryConfig,
      },
      name: "getter-only accessor",
    },
  ])("seeds an own allowlist entry over an inherited $name", ({ descriptor }) => {
    expectSeededOwnEntry(applyDefaultsWithInheritedModelRef(descriptor));
  });

  it("seeds an own allowlist entry without invoking an inherited setter", () => {
    let setterCalled = false;

    const nextModels = applyDefaultsWithInheritedModelRef({
      set: () => {
        setterCalled = true;
      },
    });

    expectSeededOwnEntry(nextModels);
    expect(setterCalled).toBe(false);
  });
});

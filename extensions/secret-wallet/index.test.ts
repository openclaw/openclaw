import { describe, expect, it } from "vitest";
import register from "./index.js";

type Registered = {
  optional?: boolean;
  tool: { name: string } | null;
};

function collectRegisteredTools(
  config: {
    allowWriteTools?: boolean;
    allowInjectTool?: boolean;
    binaryPath?: string;
  } = {},
) {
  const registered: Registered[] = [];
  const api = {
    pluginConfig: config,
    registerTool(
      factory: (ctx: { sandboxed?: boolean }) => { name: string } | null,
      options?: { optional?: boolean },
    ) {
      registered.push({
        optional: options?.optional,
        tool: factory({ sandboxed: false }),
      });
    },
  };

  register(api as never);
  return registered;
}

describe("secret-wallet plugin registration", () => {
  it("registers read tools by default", () => {
    const registered = collectRegisteredTools();
    const names = registered.map((entry) => entry.tool?.name).filter(Boolean);
    expect(names).toEqual(["secret_wallet_status", "secret_wallet_list", "secret_wallet_get"]);
    expect(registered.every((entry) => entry.optional === undefined)).toBe(true);
  });

  it("registers all gated tools when enabled", () => {
    const registered = collectRegisteredTools({
      allowWriteTools: true,
      allowInjectTool: true,
    });
    const names = registered.map((entry) => entry.tool?.name).filter(Boolean);
    expect(names).toContain("secret_wallet_add");
    expect(names).toContain("secret_wallet_remove");
    expect(names).toContain("secret_wallet_inject");
    expect(
      registered
        .filter((entry) =>
          ["secret_wallet_add", "secret_wallet_remove", "secret_wallet_inject"].includes(
            entry.tool?.name ?? "",
          ),
        )
        .every((entry) => entry.optional === true),
    ).toBe(true);
  });

  it("returns null tools in sandbox mode", () => {
    const collected: Array<{ name: string } | null> = [];
    const api = {
      pluginConfig: { allowWriteTools: true, allowInjectTool: true },
      registerTool(factory: (ctx: { sandboxed?: boolean }) => { name: string } | null) {
        collected.push(factory({ sandboxed: true }));
      },
    };

    register(api as never);
    expect(collected.every((tool) => tool === null)).toBe(true);
  });
});

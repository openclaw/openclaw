import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

describe("spec-center plugin", () => {
  it("registers the /spec command", () => {
    const registerCommand = vi.fn();
    plugin.register({
      id: "spec-center",
      name: "Spec Center",
      source: "bundled",
      registrationMode: "full",
      config: {},
      pluginConfig: {},
      runtime: {
        state: {
          resolveStateDir: () => "/tmp/openclaw-spec-center",
        },
      },
      logger: console,
      registerCommand,
    } as never);

    expect(registerCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "spec",
        acceptsArgs: true,
      }),
    );
  });
});

import { describe, expect, it } from "vitest";
import { resolveAotuiAgentAppNames, resolveAotuiRegistryEntries } from "./policy.js";

describe("AOTUI policy resolver", () => {
  it("maps OpenClaw config entries into runtime registry entries", () => {
    const entries = resolveAotuiRegistryEntries({
      aotui: {
        apps: {
          ide: {
            source: "npm:@agentina/aotui-ide",
            whatItIs: "IDE",
            whenToUse: "When code navigation is needed",
          },
        },
      },
    });

    expect(entries).toEqual([
      {
        name: "ide",
        source: "npm:@agentina/aotui-ide",
        enabled: true,
        whatItIs: "IDE",
        whenToUse: "When code navigation is needed",
      },
    ]);
  });

  it("uses per-agent AOTUI app overrides when present", () => {
    const names = resolveAotuiAgentAppNames(
      {
        agents: {
          defaults: {
            aotui: { apps: ["ide"] },
          },
          list: [
            {
              id: "reviewer",
              aotui: { apps: ["ide", "diff"] },
            },
          ],
        },
      },
      "reviewer",
    );

    expect(names).toEqual(["ide", "diff"]);
  });

  it("falls back to agent defaults when no per-agent selection exists", () => {
    const names = resolveAotuiAgentAppNames(
      {
        agents: {
          defaults: {
            aotui: { apps: ["ide", "terminal"] },
          },
          list: [{ id: "main" }],
        },
      },
      "main",
    );

    expect(names).toEqual(["ide", "terminal"]);
  });
});

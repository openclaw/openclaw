import { describe, expect, it } from "vitest";
import { hermesCase } from "./test/hermes-case.js";
import { useHermesFixture } from "./test/migration-fixture.js";

const fixture = useHermesFixture();

describe("Hermes MCP policy migration", () => {
  it.each([
    [false, false, { exclude: ["*"] }],
    [false, true, { include: ["prompts_list", "prompts_get"] }],
    [true, false, { include: ["resources_list", "resources_read"] }],
    [true, true, { include: ["resources_list", "resources_read", "prompts_list", "prompts_get"] }],
  ])(
    "preserves an empty native allowlist with resources=%s and prompts=%s",
    async (resources, prompts, toolFilter) => {
      const h = hermesCase(fixture.paths.root);
      await h.write("config.yaml", {
        mcp_servers: {
          acme: { command: "acme-mcp", tools: { include: [], resources, prompts } },
        },
      });
      const { items } = await h.plan();
      expect(items.find((item) => item.id === "config:mcp-server:acme")?.details?.value).toEqual({
        acme: { command: "acme-mcp", toolFilter },
      });
    },
  );

  it("preserves an empty string native allowlist", async () => {
    const h = hermesCase(fixture.paths.root);
    await h.write("config.yaml", {
      mcp_servers: {
        acme: {
          command: "acme-mcp",
          tools: { include: "", resources: false, prompts: false },
        },
      },
    });
    const { items } = await h.plan();
    expect(items.find((item) => item.id === "config:mcp-server:acme")?.details?.value).toEqual({
      acme: { command: "acme-mcp", toolFilter: { exclude: ["*"] } },
    });
  });

  it.each(["delete_?", "delete_[ab]"])(
    "requires review before activating an unsupported exclusion %s",
    async (pattern) => {
      const h = hermesCase(fixture.paths.root);
      await h.write("config.yaml", {
        mcp_servers: { acme: { command: "acme-mcp", tools: { exclude: [pattern] } } },
      });
      const { items } = await h.plan();
      expect(
        items.find((item) => item.id === "config:mcp-server:acme")?.details?.value,
      ).toMatchObject({
        acme: { enabled: false },
      });
      expect(
        items.find((item) => item.id === "manual:mcp-server-tool-patterns:acme"),
      ).toMatchObject({
        kind: "manual",
        message: expect.stringContaining("disabled"),
      });
    },
  );

  it("keeps the supported subset of an include policy without broadening its tool surface", async () => {
    const h = hermesCase(fixture.paths.root);
    await h.write("config.yaml", {
      mcp_servers: {
        acme: {
          command: "acme-mcp",
          tools: {
            include: ["read_*", "find_?"],
            exclude: ["delete_?"],
            resources: false,
            prompts: false,
          },
        },
      },
    });
    const { items } = await h.plan();
    expect(items.find((item) => item.id === "config:mcp-server:acme")?.details?.value).toEqual({
      acme: { command: "acme-mcp", toolFilter: { include: ["read_*"] } },
    });
    expect(items.find((item) => item.id === "manual:mcp-server-tool-patterns:acme")?.kind).toBe(
      "manual",
    );
  });
});

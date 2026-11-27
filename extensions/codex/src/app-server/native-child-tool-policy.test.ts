import {
  createOwnerBackedContractTool,
  textToolResult,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import { readCodexPluginConfig } from "./config.js";
import { createTool } from "./dynamic-tools.test-support.js";
import { resolveNativeChildToolCatalog } from "./native-child-tool-policy.js";

const availableTools = [createTool("read"), createTool("skills_read")];

describe("nativeChildTools", () => {
  it("keeps Codex session controls out of exact and wildcard grants without blocking sibling tools", () => {
    const controls = ["codex_session_interrupt", "codex_session_send", "codex_threads"];
    const names = [...controls, "codex_plugins"];
    const owned = (name: string, pluginId: string) =>
      createOwnerBackedContractTool({ name, pluginId, result: textToolResult("") });
    for (const allow of [names, ["codex_*"], ["*"]]) {
      const { tools } = resolveNativeChildToolCatalog({
        policy: { allow },
        availableTools: names.map((name) => owned(name, "codex")),
      });
      expect(tools.filter((row) => row.status === "unsupported").map((row) => row.name)).toEqual(
        controls,
      );
      expect(tools.filter((row) => row.status === "allowed").map((row) => row.name)).toEqual([
        "codex_plugins",
      ]);
    }
    expect(
      resolveNativeChildToolCatalog({
        policy: { allow: ["codex_threads"] },
        availableTools: [owned("codex_threads", "fixture")],
      }).tools[0]?.status,
    ).toBe("allowed");
  });

  it("normalizes exact aliases on both sides without granting an unsupported core implementation", () => {
    const shellAlias = createOwnerBackedContractTool({
      name: "bash",
      pluginId: "fixture",
      result: textToolResult(""),
    });
    const statuses = (allow: string[], deny?: string[]) =>
      resolveNativeChildToolCatalog({
        availableTools: [shellAlias, createTool("exec")],
        policy: { allow, deny },
      }).tools.map(({ status }) => status);
    expect(statuses([" EXEC "])).toEqual(["allowed", "unsupported"]);
    expect(statuses(["bash"])).toEqual(["allowed", "unsupported"]);
    expect(statuses(["*"], ["exec"])).toEqual(["denied", "unsupported"]);
  });

  it("makes media generation eligible without granting it by default or overriding denies", () => {
    const names = ["image_generate", "music_generate", "video_generate"];
    const generators = names.map((name) => createTool(name));
    const statuses = (policy: { allow?: string[]; deny?: string[] }) =>
      resolveNativeChildToolCatalog({ availableTools: generators, policy }).tools.map(
        (tool) => tool.status,
      );
    expect(statuses({})).toEqual(["denied", "denied", "denied"]);
    expect(statuses({ allow: names })).toEqual(["allowed", "allowed", "allowed"]);
    const otherOwner = createOwnerBackedContractTool({
      name: "image_generate",
      pluginId: "fixture",
      result: textToolResult(""),
    });
    expect(
      resolveNativeChildToolCatalog({ policy: { allow: names }, availableTools: [otherOwner] })
        .tools[0]?.status,
    ).toBe("unsupported");
    expect(statuses({ allow: ["*_generate"], deny: ["video_generate"] })).toEqual([
      "allowed",
      "allowed",
      "denied",
    ]);
  });

  it.each([{}, { nativeChildTools: {} }, { nativeChildTools: { allow: [] } }])(
    "does not grant host authority by default",
    (config) => {
      const { tools } = resolveNativeChildToolCatalog({
        policy: readCodexPluginConfig(config).nativeChildTools,
        availableTools,
      });
      expect(tools.map((tool) => tool.status)).toEqual(["denied", "denied"]);
    },
  );

  it("rejects malformed exclusions instead of interpreting the allowlist alone", () => {
    expect(() =>
      readCodexPluginConfig({ nativeChildTools: { allow: ["*"], deny: "read" } }),
    ).toThrow(/nativeChildTools/);
  });

  it("matches canonical tool names, not plugin, wrapper, implied sibling or group grants", () => {
    const available = [
      ...availableTools,
      ...[
        "lookup",
        "research__get_doc",
        "research__get_secret",
        "research__list",
        "Research__get_new",
      ].map((name) =>
        createOwnerBackedContractTool({ name, pluginId: "research", result: textToolResult("") }),
      ),
    ];
    const { tools, unmatchedAllow, unmatchedDeny } = resolveNativeChildToolCatalog({
      policy: readCodexPluginConfig({
        nativeChildTools: {
          allow: [
            " READ ",
            "research__get_*",
            "research__get_doc",
            "research",
            "openclaw__lookup",
            "group:fs",
          ],
          deny: ["research__*secret", "other__*"],
        },
      }).nativeChildTools,
      availableTools: available,
    });
    expect(tools.filter((row) => row.status === "allowed").map((row) => row.name)).toEqual([
      "Research__get_new",
      "read",
      "research__get_doc",
    ]);
    expect(tools).toContainEqual(
      expect.objectContaining({
        name: "research__get_secret",
        status: "denied",
        owner: "research",
        reason: expect.stringContaining(".deny"),
      }),
    );
    expect(unmatchedAllow).toEqual(["research", "openclaw__lookup", "group:fs"]);
    expect(unmatchedDeny).toEqual(["other__*"]);
  });

  it("a broad grant cannot restore withheld tools, grant new core controls, or invoke a tool during inspection", () => {
    const tool = createOwnerBackedContractTool({
      name: "better_patch",
      pluginId: "editing",
      result: textToolResult("unexpected execution"),
    });
    const catalog = resolveNativeChildToolCatalog({
      policy: { allow: ["*"] },
      availableTools: [
        tool,
        createTool("sessions_yield"),
        createTool("read"),
        createTool("message"),
      ],
      registeredNames: [tool.name, "message", "sessions_yield", "edit"],
    });
    expect(catalog.tools.map(({ name, status }) => [name, status])).toEqual([
      ["better_patch", "allowed"],
      ["edit", "unavailable"],
      ["message", "unsupported"],
      ["read", "unavailable"],
      ["sessions_yield", "unsupported"],
    ]);
    expect(catalog.tools.find((row) => row.name === "edit")?.owner).toBeUndefined();
    expect(tool.execute).not.toHaveBeenCalled();
  });
});

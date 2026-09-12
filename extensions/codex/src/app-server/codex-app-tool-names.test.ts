import { describe, expect, it } from "vitest";
import type { CodexAppServerTool } from "./app-tool-inventory.js";
import {
  resolveCodexAppModelToolNamesByConnector,
  resolveCodexNativeMcpServerNamespace,
} from "./codex-app-tool-names.js";

function tool(
  name: string,
  connectorId: string,
  connectorName?: string,
  modelVisible?: boolean,
): CodexAppServerTool {
  return {
    name,
    connectorId,
    ...(connectorName ? { connectorName } : {}),
    ...(modelVisible === false ? { modelVisible } : {}),
  };
}

/** Model-visible names per connector id, computed over the whole inventory. */
function modelNames(tools: readonly CodexAppServerTool[]): Map<string, string[]> {
  const byConnector = new Map<string, CodexAppServerTool[]>();
  for (const entry of tools) {
    byConnector.set(entry.connectorId, [...(byConnector.get(entry.connectorId) ?? []), entry]);
  }
  return new Map(
    [...resolveCodexAppModelToolNamesByConnector(byConnector)].map(([connectorId, app]) => [
      connectorId,
      app.modelToolNames,
    ]),
  );
}

/** The single model-visible name of a one-tool connector. */
function modelName(tools: readonly CodexAppServerTool[], connectorId: string): string {
  const names = modelNames(tools).get(connectorId);
  expect(names).toHaveLength(1);
  return names![0]!;
}

/** The connector namespace Codex derives from a connector display name. */
function namespaceFor(connectorName: string): string {
  const entry = tool("x.list", "asdk_app_x", connectorName);
  const grouped = resolveCodexAppModelToolNamesByConnector(new Map([["asdk_app_x", [entry]]]));
  const namespaces = grouped.get("asdk_app_x")?.namespaces;
  expect(namespaces).toHaveLength(1);
  return namespaces![0]!;
}

describe("connector name sanitizing", () => {
  it("matches Codex sanitize_name", () => {
    expect(namespaceFor("Delta Tools")).toBe("mcp__codex_apps__delta_tools");
    expect(namespaceFor("  Gamma-Mail!  ")).toBe("mcp__codex_apps__gamma_mail");
    expect(namespaceFor("***")).toBe("mcp__codex_apps__app");
  });
});

describe("resolveCodexNativeMcpServerNamespace", () => {
  it("prefixes and sanitizes the native server key the way Codex names its tools", () => {
    expect(resolveCodexNativeMcpServerNamespace("codex-apps")).toBe("mcp__codex_apps__");
    expect(resolveCodexNativeMcpServerNamespace("alpha")).toBe("mcp__alpha__");
    expect(resolveCodexNativeMcpServerNamespace("mcp__codex_apps__gamma")).toBe(
      "mcp__codex_apps__gamma__",
    );
  });
});

describe("resolveCodexAppModelToolNamesByConnector", () => {
  it("names connector-prefixed tools the way Codex exposes them to the model", () => {
    const delta = tool("delta_tools.list_things", "asdk_app_delta", "Delta Tools");
    expect(modelName([delta], "asdk_app_delta")).toBe("mcp__codex_apps__delta_tools_list_things");
  });

  it("strips the connector id prefix when the name prefix is absent", () => {
    const byId = tool("connector_gamma.send", "connector_gamma", "Gamma Mail");
    expect(modelName([byId], "connector_gamma")).toBe("mcp__codex_apps__gamma_mail_send");
  });

  it("keeps an unprefixed raw name and appends it to the namespace", () => {
    // Mirrors the codex-rs fixture: raw `capture_file_upload` under connector `Gmail`
    // keeps its callable name, and the namespace becomes `codex_apps__gmail`.
    const gmail = tool("capture_file_upload", "connector_gmail", "Gmail");
    expect(modelName([gmail], "connector_gmail")).toBe("mcp__codex_apps__gmailcapture_file_upload");
  });

  it("hashes colliding namespaces and colliding tool names", () => {
    const first = tool("gamma.list", "asdk_app_one", "Gamma");
    const second = tool("gamma.list", "asdk_app_two", "Gamma");
    const names = modelNames([first, second]);
    const firstName = names.get("asdk_app_one")![0]!;
    const secondName = names.get("asdk_app_two")![0]!;
    expect(firstName).not.toBe(secondName);
    expect(firstName).toMatch(/^mcp__codex_apps__gamma_[0-9a-f]{12}_list$/);
    expect(secondName).toMatch(/^mcp__codex_apps__gamma_[0-9a-f]{12}_list$/);
  });

  it("fits over-long names into 128 bytes with a hash suffix", () => {
    const long = tool(`delta.${"x".repeat(150)}`, "asdk_app_delta", "Delta");
    const name = modelName([long], "asdk_app_delta");
    expect(name.length + 2).toBeLessThanOrEqual(128);
    expect(name).toMatch(/_[0-9a-f]{12}$/);
  });

  it("groups model names by connector id over the whole inventory", () => {
    const grouped = resolveCodexAppModelToolNamesByConnector(
      new Map([
        ["asdk_app_delta", [tool("delta.list_things", "asdk_app_delta", "Delta")]],
        [
          "asdk_app_gamma",
          [
            tool("gamma.list_items", "asdk_app_gamma", "Gamma"),
            tool("gamma.send_item", "asdk_app_gamma", "Gamma"),
          ],
        ],
      ]),
    );
    expect([...grouped]).toEqual([
      [
        "asdk_app_delta",
        {
          namespaces: ["mcp__codex_apps__delta"],
          modelToolNames: ["mcp__codex_apps__delta_list_things"],
        },
      ],
      [
        "asdk_app_gamma",
        {
          namespaces: ["mcp__codex_apps__gamma"],
          modelToolNames: ["mcp__codex_apps__gamma_list_items", "mcp__codex_apps__gamma_send_item"],
        },
      ],
    ]);
  });

  it("keeps hidden tools out of the model names but inside collision hashing", () => {
    // Codex normalizes every listed tool before it filters model visibility, so a
    // hidden tool still forces the hash suffix onto the visible tool it collides with.
    const visible = tool("gamma.list", "asdk_app_gamma", "Gamma");
    const hidden = tool("gamma.list", "asdk_app_gamma_widgets", "Gamma", false);
    const grouped = resolveCodexAppModelToolNamesByConnector(
      new Map([
        ["asdk_app_gamma", [visible]],
        ["asdk_app_gamma_widgets", [hidden]],
      ]),
    );
    const gamma = grouped.get("asdk_app_gamma")!;
    expect(gamma.modelToolNames).toHaveLength(1);
    expect(gamma.modelToolNames[0]).not.toBe("mcp__codex_apps__gamma_list");
    expect(gamma.modelToolNames[0]).toMatch(/^mcp__codex_apps__gamma_[0-9a-f]{12}_list$/);
    const widgets = grouped.get("asdk_app_gamma_widgets")!;
    expect(widgets.modelToolNames).toEqual([]);
    expect(widgets.namespaces).toHaveLength(1);
    expect(widgets.namespaces[0]).toMatch(/^mcp__codex_apps__gamma/);
    expect(widgets.namespaces[0]).not.toBe(gamma.namespaces[0]);
  });
});

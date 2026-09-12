import { describe, expect, it } from "vitest";
import {
  createCodexAppDenyGate,
  normalizeCodexDeniedAppPatterns,
  readCodexAppModelToolsForDenies,
} from "./app-policy-deny.js";
import type { CodexAppModelTools } from "./codex-app-tool-names.js";

const APP_ID = "asdk_app_under_test";

/** The gate's per-app verdict, read back through its public `apply` contract. */
function resolveCodexAppDenyDecision(params: {
  app: CodexAppModelTools | undefined;
  patterns: readonly string[];
}): "allowed" | "denied" | "unenforceable" {
  const gate = createCodexAppDenyGate<"unenforceable">({
    modelToolsByApp: new Map(params.app ? [[APP_ID, params.app]] : []),
    patterns: params.patterns,
    onDenied: () => {},
    failClosed: () => "unenforceable",
  });
  const result = gate.apply(APP_ID);
  return result === true ? "denied" : result === false ? "allowed" : result;
}

function findUnmatchedCodexAppDenyPatterns(params: {
  modelToolsByApp: ReadonlyMap<string, CodexAppModelTools>;
  patterns: readonly string[];
}): string[] {
  return createCodexAppDenyGate<never>({
    ...params,
    onDenied: () => {},
    failClosed: () => {
      throw new Error("not expected");
    },
  }).unmatched;
}

describe("normalizeCodexDeniedAppPatterns", () => {
  it("keeps only well-formed namespace patterns, lowercased, unique, sorted", () => {
    expect(
      normalizeCodexDeniedAppPatterns([
        " MCP__codex_apps__Gamma_* ",
        "mcp__codex_apps__gamma_*",
        "mcp__codex_apps__epsilon_*",
        "mcp__codex_apps__*",
        "mcp__codex_apps__x_*_y_*",
        "mcp__codex_apps__gamma_?*",
        "mcp__codex_apps__exact_tool",
        "alpha__*",
      ]),
    ).toEqual(["mcp__codex_apps__*", "mcp__codex_apps__epsilon_*", "mcp__codex_apps__gamma_*"]);
    expect(normalizeCodexDeniedAppPatterns(undefined)).toEqual([]);
  });
});

describe("createCodexAppDenyGate apply decisions", () => {
  const patterns = ["mcp__codex_apps__gamma_*"];
  const gamma = {
    namespaces: ["mcp__codex_apps__gamma"],
    modelToolNames: ["mcp__codex_apps__gamma_list_items", "mcp__codex_apps__gamma_send_item"],
  };
  const delta = {
    namespaces: ["mcp__codex_apps__delta"],
    modelToolNames: ["mcp__codex_apps__delta_list_things"],
  };

  it("allows apps no pattern covers", () => {
    expect(resolveCodexAppDenyDecision({ app: delta, patterns })).toBe("allowed");
    expect(resolveCodexAppDenyDecision({ app: undefined, patterns: [] })).toBe("allowed");
  });

  it("denies apps whose every tool a pattern covers", () => {
    expect(resolveCodexAppDenyDecision({ app: gamma, patterns })).toBe("denied");
    expect(resolveCodexAppDenyDecision({ app: gamma, patterns: ["mcp__codex_apps__gam*"] })).toBe(
      "denied",
    );
    expect(resolveCodexAppDenyDecision({ app: gamma, patterns: ["mcp__codex_apps__*"] })).toBe(
      "denied",
    );
  });

  it("denies the whole app by namespace when a callable carries no separator", () => {
    // Raw `capture_file_upload` under connector `Gmail` is named
    // `mcp__codex_apps__gmailcapture_file_upload`; the advertised `<app>_*` form
    // still denies the app because it names the namespace.
    const gmail = {
      namespaces: ["mcp__codex_apps__gmail"],
      modelToolNames: ["mcp__codex_apps__gmailcapture_file_upload", "mcp__codex_apps__gmail_send"],
    };
    expect(
      resolveCodexAppDenyDecision({ app: gmail, patterns: ["mcp__codex_apps__gmail_*"] }),
    ).toBe("denied");
    expect(resolveCodexAppDenyDecision({ app: gmail, patterns: ["mcp__codex_apps__gmail*"] })).toBe(
      "denied",
    );
    expect(
      resolveCodexAppDenyDecision({ app: gmail, patterns: ["mcp__codex_apps__gmail_send*"] }),
    ).toBe("unenforceable");
  });

  it("denies a nameless connector only through the global pattern", () => {
    // Without a connector name Codex names the tools under the bare server
    // namespace, so no `<app>_*` form can address the app.
    const nameless = {
      namespaces: ["mcp__codex_apps"],
      modelToolNames: ["mcp__codex_apps_list_things"],
    };
    expect(resolveCodexAppDenyDecision({ app: nameless, patterns: ["mcp__codex_apps__*"] })).toBe(
      "denied",
    );
    expect(resolveCodexAppDenyDecision({ app: nameless, patterns })).toBe("allowed");
  });

  it("ignores tools Codex hides from the model", () => {
    const hiddenOnly = { namespaces: ["mcp__codex_apps__gamma"], modelToolNames: [] };
    expect(resolveCodexAppDenyDecision({ app: hiddenOnly, patterns })).toBe("denied");
    expect(resolveCodexAppDenyDecision({ app: hiddenOnly, patterns: ["mcp__codex_apps__*"] })).toBe(
      "denied",
    );
    expect(
      resolveCodexAppDenyDecision({ app: hiddenOnly, patterns: ["mcp__codex_apps__gam*"] }),
    ).toBe("denied");
    expect(
      resolveCodexAppDenyDecision({ app: hiddenOnly, patterns: ["mcp__codex_apps__gamma_send_*"] }),
    ).toBe("allowed");
  });

  it("fails closed for partial coverage or unreadable tools", () => {
    expect(
      resolveCodexAppDenyDecision({ app: gamma, patterns: ["mcp__codex_apps__gamma_send_*"] }),
    ).toBe("unenforceable");
    expect(resolveCodexAppDenyDecision({ app: undefined, patterns })).toBe("unenforceable");
  });
});

describe("readCodexAppModelToolsForDenies", () => {
  it("returns namespaces and model-visible names grouped by connector id", async () => {
    const names = await readCodexAppModelToolsForDenies({
      patterns: ["mcp__codex_apps__gamma_*"],
      request: async (method) => {
        expect(method).toBe("mcpServerStatus/list");
        return {
          data: [
            { name: "other", tools: { "other.tool": {} } },
            {
              name: "codex_apps",
              tools: {
                "delta.list_things": {
                  _meta: { connector_id: "asdk_app_delta", connector_display_name: "Delta" },
                },
                "gamma.list_items": {
                  _meta: { connector_id: "asdk_app_gamma", connector_name: "Gamma" },
                },
                "gamma.send_item": {
                  _meta: { connector_id: "asdk_app_gamma", connector_name: "Gamma" },
                },
                "gamma.widget_helper": {
                  _meta: {
                    connector_id: "asdk_app_gamma",
                    connector_name: "Gamma",
                    ui: { visibility: ["app"] },
                  },
                },
                orphan: {},
              },
            },
          ],
          nextCursor: null,
        };
      },
    });
    expect([...(names ?? [])]).toEqual([
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

  it("skips the read without patterns and fails closed when the read throws", async () => {
    expect(
      await readCodexAppModelToolsForDenies({
        patterns: [],
        request: async () => {
          throw new Error("must not be called");
        },
      }),
    ).toEqual(new Map());
    expect(
      await readCodexAppModelToolsForDenies({
        patterns: ["mcp__codex_apps__gamma_*"],
        request: async () => {
          throw new Error("unavailable");
        },
      }),
    ).toBeUndefined();
  });
});

describe("createCodexAppDenyGate unmatched patterns", () => {
  const modelToolsByApp = new Map([
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
    ["asdk_app_hidden", { namespaces: ["mcp__codex_apps__hidden"], modelToolNames: [] }],
  ]);

  it("returns only patterns that touch no known app namespace or tool", () => {
    expect(
      findUnmatchedCodexAppDenyPatterns({
        modelToolsByApp,
        patterns: [
          "mcp__codex_apps__gamma_*",
          "mcp__codex_apps__gamma_send_*",
          "mcp__codex_apps__hidden_*",
          "mcp__codex_apps__*",
          "mcp__codex_apps__zeta_*",
          "mcp__codex_apps__gamma__*",
        ],
      }),
    ).toEqual(["mcp__codex_apps__zeta_*", "mcp__codex_apps__gamma__*"]);
    expect(findUnmatchedCodexAppDenyPatterns({ modelToolsByApp, patterns: [] })).toEqual([]);
  });
});

describe("createCodexAppDenyGate", () => {
  it("admits, skips, or fails closed per app and records deny diagnostics", () => {
    const diagnostics: unknown[] = [];
    const gate = createCodexAppDenyGate<string>({
      modelToolsByApp: new Map([
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
            modelToolNames: [
              "mcp__codex_apps__gamma_list_items",
              "mcp__codex_apps__gamma_send_item",
            ],
          },
        ],
      ]),
      patterns: ["mcp__codex_apps__gamma_*"],
      onDenied: (diagnostic) => diagnostics.push(diagnostic),
      failClosed: (appId) => `closed:${appId}`,
    });
    expect(gate.unmatched).toEqual([]);
    expect(gate.apply("asdk_app_delta")).toBe(false);
    expect(gate.apply("asdk_app_gamma")).toBe(true);
    expect(gate.apply("asdk_app_unknown")).toBe("closed:asdk_app_unknown");
    expect(diagnostics).toEqual([
      { code: "app_denied_by_policy", message: "asdk_app_gamma is denied by tool policy." },
    ]);
  });
});

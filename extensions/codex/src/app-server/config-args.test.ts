import { describe, expect, it } from "vitest";
import { resolveCodexAppServerRuntimeOptions } from "./config-runtime.js";

describe("Codex app-server arguments", () => {
  it.each([
    {
      source: "config",
      raw: String.raw`app-server -c log_dir=/tmp/openclaw\logs --listen stdio://`,
      expected: [
        "app-server",
        "-c",
        String.raw`log_dir=/tmp/openclaw\logs`,
        "--listen",
        "stdio://",
      ],
    },
    {
      source: "env",
      raw: 'app-server --listen "stdio://',
      expected: ["app-server", "--listen", "stdio://"],
    },
  ])("preserves shipped $source string parsing: $raw", ({ source, raw, expected }) => {
    const runtime = resolveCodexAppServerRuntimeOptions({
      pluginConfig: {
        appServer: { mode: "yolo", ...(source === "config" ? { args: raw } : {}) },
      },
      env: source === "env" ? { OPENCLAW_CODEX_APP_SERVER_ARGS: raw } : {},
      requirementsToml: null,
      codexConfigToml: null,
    });
    expect(runtime.start.args).toEqual(expected);
  });
});

it("preserves literal array values and existing whitespace normalization", () => {
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: {
      appServer: {
        mode: "yolo",
        args: [
          " app-server ",
          "-c",
          'model="gpt-5.6-luna"',
          "-c",
          String.raw`log_dir=/tmp/openclaw\logs`,
          "",
        ],
      },
    },
    env: { OPENCLAW_CODEX_APP_SERVER_ARGS: "ignored" },
    requirementsToml: null,
    codexConfigToml: null,
  });
  expect(runtime.start.args).toEqual([
    "app-server",
    "-c",
    'model="gpt-5.6-luna"',
    "-c",
    String.raw`log_dir=/tmp/openclaw\logs`,
  ]);
});

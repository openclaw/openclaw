import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it } from "vitest";
import { buildGoogleGeminiCliBackend } from "./cli-backend.js";
import setupEntry from "./setup-api.js";

describe("google setup entry", () => {
  it("registers setup runtime providers declared by the manifest", () => {
    const providerIds: string[] = [];
    const cliBackends: CliBackendPlugin[] = [];

    setupEntry.register({
      registerProvider: (provider: ProviderPlugin) => providerIds.push(provider.id),
      registerCliBackend: (backend: CliBackendPlugin) => cliBackends.push(backend),
    } as never);

    expect(providerIds).toEqual(["google-vertex"]);
    expect(cliBackends.map((backend) => backend.id)).toEqual(["google-gemini-cli"]);
    expect(cliBackends[0]?.config.reliability?.watchdog?.resume).toBeUndefined();
  });
});

describe("google gemini cli backend config", () => {
  it.each([
    {
      phase: "fresh",
      key: "args" as const,
      expected: [
        "--skip-trust",
        "--approval-mode",
        "auto_edit",
        "--output-format",
        "stream-json",
        "--prompt",
        "{prompt}",
      ],
    },
    {
      phase: "resume",
      key: "resumeArgs" as const,
      expected: [
        "--skip-trust",
        "--approval-mode",
        "auto_edit",
        "--resume",
        "{sessionId}",
        "--output-format",
        "stream-json",
        "--prompt",
        "{prompt}",
      ],
    },
  ])("preserves the legacy $phase command bytes in plugin code", ({ key, expected }) => {
    const backend = buildGoogleGeminiCliBackend();

    expect(backend.config.command).toBe("gemini");
    expect(backend.config[key]).toEqual(expected);
    expect(backend.config.env).toBeUndefined();
    expect(backend.config.clearEnv).toBeUndefined();
  });

  it("declares its bundled package implementation boundary", () => {
    const backend = buildGoogleGeminiCliBackend();
    expect(backend.runtimeArtifact).toEqual({
      kind: "bundled-package-tree",
      packageName: "@google/gemini-cli",
      entrypoint: "command",
      exactToolAvailabilityVersionPolicy: {
        stableMinimum: "0.39.1",
        prereleaseMinimums: {
          preview: "0.40.0-preview.3",
          nightly: "0.41.0-nightly.20260427.g42587de73",
        },
      },
    });
    expect(backend.nativeToolMode).toBe("selectable");
    expect(backend.toolAvailabilityEnforcement).toBe("prepare-execution");
  });

  it("enforces exact MCP server availability with a per-run argv override", () => {
    const backend = buildGoogleGeminiCliBackend();
    const promptArgs = ["--prompt", "{prompt}"];
    const positionalArgs = ["--", "--allowed-mcp-server-names", "positional-hostile"];
    const baseContext = {
      workspaceDir: "/tmp/openclaw-gemini-test",
      provider: "google-gemini-cli",
      modelId: "gemini-3.1-pro-preview",
      useResume: false,
      baseArgs: [
        "--allowedMcpServerNames",
        "camel-hostile",
        "--allowed_mcp_server_names=snake-hostile",
        "--allowed-mcp-server-names",
        "hostile",
        "--allowed-mcp-server-names=also-hostile",
        ...promptArgs,
        ...positionalArgs,
      ],
    };

    const restrictedArgs = backend.resolveExecutionArgs?.({
      ...baseContext,
      toolAvailability: { native: [], openClaw: ["read"] },
    });
    expect(restrictedArgs).toEqual([
      ...promptArgs,
      "--allowed-mcp-server-names",
      "openclaw",
      ...positionalArgs,
    ]);

    const emptyArgs = backend.resolveExecutionArgs?.({
      ...baseContext,
      toolAvailability: { native: [], openClaw: [] },
    });
    expect(emptyArgs?.slice(0, -4)).toEqual(["--prompt", "{prompt}", "--allowed-mcp-server-names"]);
    expect(emptyArgs?.at(-4)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(emptyArgs?.slice(-3)).toEqual(positionalArgs);
  });

  it.each([
    ["--output-format", "json", "json", undefined],
    ["-o", "stream-json", "jsonl", "gemini-stream-json"],
  ] as const)(
    "normalizes %s %s for initial and resumed output",
    (flag, format, output, dialect) => {
      const backend = buildGoogleGeminiCliBackend();
      const promptArgs = ["--prompt", "{prompt}"];
      const normalized = backend.normalizeConfig?.({
        ...backend.config,
        args: ["--skip-trust", flag, format, ...promptArgs],
        resumeArgs: ["--skip-trust", "--resume", "{sessionId}", `${flag}=${format}`, ...promptArgs],
      });

      expect(normalized?.output).toBe(output);
      expect(normalized?.resumeOutput).toBe(output);
      expect(normalized?.jsonlDialect).toBe(dialect);
    },
  );
});

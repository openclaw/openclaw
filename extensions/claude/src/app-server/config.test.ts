import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_APP_SERVER_CONFIG_KEYS,
  CLAUDE_DYNAMIC_TOOLS_CONFIG_KEYS,
  DEFAULT_CLAUDE_APP_SERVER_APPROVAL_POLICY,
  DEFAULT_CLAUDE_APP_SERVER_PROGRESS_IDLE_TIMEOUT_MS,
  DEFAULT_CLAUDE_APP_SERVER_SUBAGENT_PROGRESS_IDLE_TIMEOUT_MS,
  DEFAULT_CLAUDE_APP_SERVER_TURN_IDLE_TIMEOUT_MS,
  DEFAULT_CLAUDE_APP_SERVER_TURN_TIMEOUT_MS,
  DEFAULT_CLAUDE_BRIDGE_COMMAND,
  resolveClaudeAppServerConfig,
} from "./config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.resolve(HERE, "../../openclaw.plugin.json");

type ManifestConfigObject = {
  properties?: Record<string, ManifestConfigObject>;
};

describe("resolveClaudeAppServerConfig", () => {
  it("applies runtime defaults for missing config", () => {
    expect(resolveClaudeAppServerConfig(undefined)).toEqual({
      appServer: {
        command: DEFAULT_CLAUDE_BRIDGE_COMMAND,
        commandSource: "managed",
        approvalPolicy: DEFAULT_CLAUDE_APP_SERVER_APPROVAL_POLICY,
        sandbox: { type: "dangerFullAccess" },
        turnTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_TURN_TIMEOUT_MS,
        turnIdleTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_TURN_IDLE_TIMEOUT_MS,
        progressIdleTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_PROGRESS_IDLE_TIMEOUT_MS,
        subagentProgressIdleTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_SUBAGENT_PROGRESS_IDLE_TIMEOUT_MS,
      },
      dynamicTools: {
        excludeNames: [],
      },
    });
  });

  it("normalizes configured app-server and dynamic-tool options", () => {
    expect(
      resolveClaudeAppServerConfig({
        appServer: {
          command: "node",
          args: ["server.js", "--debug"],
          env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0" },
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
          turnTimeoutMs: 1234,
          turnIdleTimeoutMs: 567,
          progressIdleTimeoutMs: 890,
          subagentProgressIdleTimeoutMs: 4321,
        },
        dynamicTools: {
          exclude: ["image", "read"],
        },
      }),
    ).toEqual({
      appServer: {
        command: "node",
        commandSource: "config",
        args: ["server.js", "--debug"],
        env: { CLAUDE_CODE_ENABLE_TELEMETRY: "0" },
        approvalPolicy: "on-request",
        sandbox: { type: "workspaceWrite" },
        turnTimeoutMs: 1234,
        turnIdleTimeoutMs: 567,
        progressIdleTimeoutMs: 890,
        subagentProgressIdleTimeoutMs: 4321,
      },
      dynamicTools: {
        excludeNames: ["image", "read"],
      },
    });
  });

  it("rejects malformed optional values instead of casting them into runtime config", () => {
    expect(
      resolveClaudeAppServerConfig({
        appServer: {
          args: ["ok", 42],
          env: { OK: "yes", BAD: 1 },
          approvalPolicy: "always",
          sandbox: "invalid",
          turnTimeoutMs: 0,
          turnIdleTimeoutMs: Number.NaN,
        },
        dynamicTools: {
          exclude: ["read", false],
        },
      }),
    ).toEqual({
      appServer: {
        command: DEFAULT_CLAUDE_BRIDGE_COMMAND,
        commandSource: "managed",
        approvalPolicy: DEFAULT_CLAUDE_APP_SERVER_APPROVAL_POLICY,
        sandbox: { type: "dangerFullAccess" },
        turnTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_TURN_TIMEOUT_MS,
        turnIdleTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_TURN_IDLE_TIMEOUT_MS,
        progressIdleTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_PROGRESS_IDLE_TIMEOUT_MS,
        subagentProgressIdleTimeoutMs: DEFAULT_CLAUDE_APP_SERVER_SUBAGENT_PROGRESS_IDLE_TIMEOUT_MS,
      },
      dynamicTools: {
        excludeNames: [],
      },
    });
  });
});

describe("Claude manifest config alignment", () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    configSchema: ManifestConfigObject;
  };

  it("keeps appServer parser keys aligned with the manifest schema", () => {
    const appServerSchema = manifest.configSchema.properties?.appServer;
    expect(Object.keys(appServerSchema?.properties ?? {}).toSorted()).toEqual(
      [...CLAUDE_APP_SERVER_CONFIG_KEYS].toSorted(),
    );
  });

  it("keeps dynamicTools parser keys aligned with the manifest schema", () => {
    const dynamicToolsSchema = manifest.configSchema.properties?.dynamicTools;
    expect(Object.keys(dynamicToolsSchema?.properties ?? {}).toSorted()).toEqual(
      [...CLAUDE_DYNAMIC_TOOLS_CONFIG_KEYS].toSorted(),
    );
  });
});

import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../src/config/types.js";
import { resolveSecretRefValues } from "../../../src/secrets/resolve.js";
import {
  applyResolvedAssignments,
  createResolverContext,
} from "../../../src/secrets/runtime-shared.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";

const INACTIVE_CODE = "SECRETS_REF_IGNORED_INACTIVE_SURFACE";

function envRef(id: string) {
  return { source: "env" as const, provider: "default", id };
}

describe("slack secret contract registry", () => {
  it("exports 8 entries covering top-level and per-account tokens + secrets", () => {
    const ids = secretTargetRegistryEntries.map((entry) => entry.id).toSorted();
    expect(ids).toEqual([
      "channels.slack.accounts.*.appToken",
      "channels.slack.accounts.*.botToken",
      "channels.slack.accounts.*.signingSecret",
      "channels.slack.accounts.*.userToken",
      "channels.slack.appToken",
      "channels.slack.botToken",
      "channels.slack.signingSecret",
      "channels.slack.userToken",
    ]);
    for (const entry of secretTargetRegistryEntries) {
      expect(entry.secretShape).toBe("secret_input");
      expect(entry.expectedResolvedValue).toBe("string");
      expect(entry.includeInPlan).toBe(true);
      expect(entry.includeInConfigure).toBe(true);
      expect(entry.includeInAudit).toBe(true);
      expect(entry.pathPattern).toBe(entry.targetType);
    }
  });
});

describe("slack secret contract runtime assignments", () => {
  it("no-ops when the config has no slack channel", () => {
    const sourceConfig = { channels: {} } satisfies OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({ sourceConfig, env: {} });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

    expect(context.assignments).toEqual([]);
    expect(context.warnings).toEqual([]);
  });

  it("resolves top-level botToken and userToken SecretRefs when slack channel is enabled", async () => {
    const sourceConfig = {
      channels: {
        slack: {
          enabled: true,
          botToken: envRef("SLACK_BOT_TOKEN"),
          userToken: envRef("SLACK_USER_TOKEN"),
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        SLACK_BOT_TOKEN: "xoxb-bot",
        SLACK_USER_TOKEN: "xoxp-user",
      },
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });
    const resolved = await resolveSecretRefValues(
      context.assignments.map((assignment) => assignment.ref),
      { config: sourceConfig, env: context.env, cache: context.cache },
    );
    applyResolvedAssignments({ assignments: context.assignments, resolved });

    const slack = resolvedConfig.channels?.slack;
    expect(slack?.botToken).toBe("xoxb-bot");
    expect(slack?.userToken).toBe("xoxp-user");
    expect(context.warnings).toEqual([]);
  });

  it("defaults baseMode to socket: top-level appToken is active, signingSecret is inactive", () => {
    const sourceConfig = {
      channels: {
        slack: {
          enabled: true,
          appToken: envRef("SLACK_APP_TOKEN"),
          signingSecret: envRef("SLACK_SIGNING_SECRET"),
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        SLACK_APP_TOKEN: "xapp-token",
        SLACK_SIGNING_SECRET: "signing-secret",
      },
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

    const assignedPaths = context.assignments.map((assignment) => assignment.path).toSorted();
    expect(assignedPaths).toEqual(["channels.slack.appToken"]);
    // signingSecret is inactive under default (socket) baseMode.
    expect(context.warnings).toContainEqual(
      expect.objectContaining({
        code: INACTIVE_CODE,
        path: "channels.slack.signingSecret",
      }),
    );
  });

  it("treats baseMode=http as inverting top-level appToken vs signingSecret activity", () => {
    const sourceConfig = {
      channels: {
        slack: {
          enabled: true,
          mode: "http",
          appToken: envRef("SLACK_APP_TOKEN"),
          signingSecret: envRef("SLACK_SIGNING_SECRET"),
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        SLACK_APP_TOKEN: "xapp-token",
        SLACK_SIGNING_SECRET: "signing-secret",
      },
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

    const assignedPaths = context.assignments.map((assignment) => assignment.path).toSorted();
    expect(assignedPaths).toEqual(["channels.slack.signingSecret"]);
    expect(context.warnings).toContainEqual(
      expect.objectContaining({
        code: INACTIVE_CODE,
        path: "channels.slack.appToken",
      }),
    );
  });

  it("activates a per-account appToken only when the account resolves to socket mode", () => {
    const sourceConfig = {
      channels: {
        slack: {
          enabled: true,
          // baseMode absent → socket.
          accounts: {
            socketAccount: {
              enabled: true,
              mode: "socket",
              appToken: envRef("SLACK_SOCKET_APP_TOKEN"),
              signingSecret: envRef("SLACK_SOCKET_SIGNING_SECRET"),
            },
            httpAccount: {
              enabled: true,
              mode: "http",
              appToken: envRef("SLACK_HTTP_APP_TOKEN"),
              signingSecret: envRef("SLACK_HTTP_SIGNING_SECRET"),
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        SLACK_SOCKET_APP_TOKEN: "xapp-socket",
        SLACK_SOCKET_SIGNING_SECRET: "signing-socket",
        SLACK_HTTP_APP_TOKEN: "xapp-http",
        SLACK_HTTP_SIGNING_SECRET: "signing-http",
      },
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

    const assignedPaths = context.assignments.map((assignment) => assignment.path).toSorted();
    expect(assignedPaths).toEqual([
      "channels.slack.accounts.httpAccount.signingSecret",
      "channels.slack.accounts.socketAccount.appToken",
    ]);
    // Opposite-mode surfaces for each account should have emitted inactive warnings.
    const inactivePaths = context.warnings
      .filter((w) => w.code === INACTIVE_CODE)
      .map((w) => w.path)
      .toSorted();
    expect(inactivePaths).toContain("channels.slack.accounts.httpAccount.appToken");
    expect(inactivePaths).toContain("channels.slack.accounts.socketAccount.signingSecret");
  });

  it("inherits baseMode for accounts without an explicit mode", () => {
    const sourceConfig = {
      channels: {
        slack: {
          enabled: true,
          mode: "http",
          accounts: {
            inherits: {
              enabled: true,
              // mode absent → inherits baseMode=http.
              appToken: envRef("SLACK_APP_TOKEN"),
              signingSecret: envRef("SLACK_SIGNING_SECRET"),
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        SLACK_APP_TOKEN: "xapp-token",
        SLACK_SIGNING_SECRET: "signing-secret",
      },
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

    const assignedPaths = context.assignments.map((assignment) => assignment.path).toSorted();
    expect(assignedPaths).toEqual(["channels.slack.accounts.inherits.signingSecret"]);
    expect(context.warnings).toContainEqual(
      expect.objectContaining({
        code: INACTIVE_CODE,
        path: "channels.slack.accounts.inherits.appToken",
      }),
    );
  });

  it("skips account-level assignments when the account is disabled", () => {
    const sourceConfig = {
      channels: {
        slack: {
          enabled: true,
          accounts: {
            offline: {
              enabled: false,
              mode: "socket",
              botToken: envRef("SLACK_OFFLINE_BOT_TOKEN"),
              appToken: envRef("SLACK_OFFLINE_APP_TOKEN"),
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig: OpenClawConfig = structuredClone(sourceConfig);
    const context = createResolverContext({
      sourceConfig,
      env: {
        SLACK_OFFLINE_BOT_TOKEN: "xoxb-offline",
        SLACK_OFFLINE_APP_TOKEN: "xapp-offline",
      },
    });

    collectRuntimeConfigAssignments({
      config: resolvedConfig,
      defaults: undefined,
      context,
    });

    expect(context.assignments).toEqual([]);
    const inactivePaths = context.warnings
      .filter((w) => w.code === INACTIVE_CODE)
      .map((w) => w.path)
      .toSorted();
    expect(inactivePaths).toContain("channels.slack.accounts.offline.botToken");
    expect(inactivePaths).toContain("channels.slack.accounts.offline.appToken");
  });
});

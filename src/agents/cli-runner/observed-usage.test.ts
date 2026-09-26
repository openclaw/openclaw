import { afterEach, describe, expect, it } from "vitest";
import {
  claudeCodeSessionRanOnHostLogin,
  clearObservedProviderUsageWindows,
  readClaudeCodeUsageSnapshot,
} from "../../infra/provider-usage.observed.js";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";
import { shouldRecordObservedClaudeUsage } from "./observed-usage.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

afterEach(() => {
  supervisorSpawnMock.mockReset();
  clearObservedProviderUsageWindows();
});

type TurnSetup = {
  backend?: NonNullable<Parameters<typeof buildPreparedCliRunContext>[0]>["backend"];
  effectiveAuthProfileId?: string;
};

describe("Claude subscription windows observed from CLI turns", () => {
  it.each<[string, TurnSetup, boolean]>([
    ["the host Claude login", {}, true],
    ["an OpenClaw-selected auth profile", { effectiveAuthProfileId: "anthropic:work" }, false],
    // The Anthropic backend clears this variable, then applies configured env.
    [
      "a configured backend credential override",
      { backend: { clearEnv: ["ANTHROPIC_OAUTH_TOKEN"], env: { ANTHROPIC_OAUTH_TOKEN: "x" } } },
      false,
    ],
  ])("records Claude subscription windows from a turn under %s", async (_name, run, recorded) => {
    clearObservedProviderUsageWindows();
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = (args[0] ?? {}) as { onStdout?: (chunk: string) => void };
      input.onStdout?.(
        [
          JSON.stringify({ type: "init", session_id: "session-limits" }),
          JSON.stringify({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "allowed",
              unifiedWindows: {
                five_hour: { utilization: 0.03, resetsAt: 1790305200 },
                seven_day: { utilization: 0.48, resetsAt: 1790784000 },
              },
            },
            session_id: "session-limits",
          }),
          JSON.stringify({ type: "result", session_id: "session-limits", result: "ok" }),
        ].join("\n") + "\n",
      );
      return createManagedRun(createSuccessfulProcessExit());
    });
    const context = buildPreparedCliRunContext({
      sessionKey: "agent:main:observed",
      ...(run.backend ? { backend: run.backend } : {}),
    });
    context.effectiveAuthProfileId = run.effectiveAuthProfileId;

    const result = await executePreparedCliRun(context);

    expect(result.text).toBe("ok");
    expect(readClaudeCodeUsageSnapshot(0)?.windows).toEqual(
      recorded
        ? [
            { label: "5h", usedPercent: 3, resetAt: 1790305200_000 },
            { label: "Week", usedPercent: 48, resetAt: 1790784000_000 },
          ]
        : undefined,
    );
    // /status shows the host login's windows only to sessions the runner admitted.
    expect(claudeCodeSessionRanOnHostLogin("agent:main:observed")).toBe(recorded);
  });

  it("records Claude subscription windows only for the Gateway host's own login", () => {
    const hostRun = {
      backendId: "claude-cli",
      effectiveAuthProfileId: undefined,
      nodePlacement: null,
      runEnv: {},
      gatewayClaudeConfigDir: undefined,
      skillEnvKeys: new Set<string>(),
      backendArgs: ["-p", "--setting-sources", "user"],
    };
    expect(shouldRecordObservedClaudeUsage(hostRun)).toBe(true);
    expect(shouldRecordObservedClaudeUsage({ ...hostRun, backendId: "local-cli" })).toBe(false);
    expect(
      shouldRecordObservedClaudeUsage({
        ...hostRun,
        nodePlacement: {} as NonNullable<
          Parameters<typeof shouldRecordObservedClaudeUsage>[0]["nodePlacement"]
        >,
      }),
    ).toBe(false);
    expect(
      shouldRecordObservedClaudeUsage({
        ...hostRun,
        runEnv: { CLAUDE_CONFIG_DIR: "/srv/other-claude" },
      }),
    ).toBe(false);
    for (const settings of [
      ["--settings", "/srv/other.json"],
      ["--settings={}"],
      ["--managed-settings", "/srv/other.json"],
    ]) {
      expect(
        shouldRecordObservedClaudeUsage({ ...hostRun, backendArgs: ["-p", ...settings] }),
      ).toBe(false);
    }
    // A skill that sets the directory changes both sides of the comparison.
    expect(
      shouldRecordObservedClaudeUsage({
        ...hostRun,
        runEnv: { CLAUDE_CONFIG_DIR: "/srv/other-claude" },
        gatewayClaudeConfigDir: "/srv/other-claude",
        skillEnvKeys: new Set(["CLAUDE_CONFIG_DIR"]),
      }),
    ).toBe(false);
    // Windows environment names are case-insensitive.
    expect(
      shouldRecordObservedClaudeUsage({
        ...hostRun,
        runEnv: { claude_config_dir: "/srv/other-claude" },
        gatewayClaudeConfigDir: "/srv/other-claude",
        skillEnvKeys: new Set(["claude_config_dir"]),
      }),
    ).toBe(false);
    expect(
      shouldRecordObservedClaudeUsage({ ...hostRun, runEnv: { Claude_Config_Dir: "/srv/other" } }),
    ).toBe(false);
    // Feature switches do not change the account.
    expect(
      shouldRecordObservedClaudeUsage({
        ...hostRun,
        runEnv: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" },
      }),
    ).toBe(true);
    for (const key of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
      "ANTHROPIC_OAUTH_TOKEN",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      // Unknown Anthropic variables fail closed.
      "ANTHROPIC_FUTURE_CREDENTIAL",
      "ANTHROPIC_API_KEY_OLD",
      // Windows environment names are case-insensitive.
      "anthropic_base_url",
      "Claude_Code_OAuth_Token",
    ]) {
      expect(shouldRecordObservedClaudeUsage({ ...hostRun, runEnv: { [key]: "x" } }), key).toBe(
        false,
      );
    }
    // Model selectors, OpenClaw's Admin API and key-rotation variables, Vertex
    // settings without CLAUDE_CODE_USE_VERTEX and empty values do not change
    // the account.
    expect(
      shouldRecordObservedClaudeUsage({
        ...hostRun,
        runEnv: {
          ANTHROPIC_MODEL: "claude-haiku-4-5",
          ANTHROPIC_ADMIN_KEY: "admin",
          ANTHROPIC_ADMIN_API_KEY: "admin",
          ANTHROPIC_API_KEYS: "a,b",
          ANTHROPIC_API_KEY_2: "b",
          ANTHROPIC_VERTEX_PROJECT_ID: "project",
          ANTHROPIC_VERTEX_USE_GCP_METADATA: "1",
          ANTHROPIC_AUTH_TOKEN: "",
        },
      }),
    ).toBe(true);
  });
});

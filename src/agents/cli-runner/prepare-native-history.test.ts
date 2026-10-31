// Proves preparation seeds saved history into a fresh Claude CLI session only for the native login that owns it.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockClaudeManagedSettings } from "../../../test/helpers/claude-managed-settings.js";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  buildDefaultTestCliBackend,
  createCliRunnerPrepareFixture,
  createTestMcpLoopbackServer,
} from "../cli-runner.test-helpers.js";
import { prepareCliHistoryBoundary } from "./history-boundary.js";
import {
  mockCliMcpPreparation,
  createJsonlStdinBackendConfig,
  setRawCliBackendForPrepareTest,
} from "./prepare-mcp.test-support.js";
import { prepareCliRunContext } from "./prepare.js";
import { resetCliRunnerPrepareTestDeps } from "./prepare.test-support.js";

// mock-isolation: preparation here needs an empty runtime config, not the host's.
vi.mock("../../config/config.js", async () => ({
  getRuntimeConfig: vi.fn(() => ({})),
  resolveGatewayPort: (await import("../../config/paths.js")).resolveGatewayPort,
}));
// mock-isolation: no sandbox may be provisioned for the temp workspace.
vi.mock("../sandbox.js", () => ({ ensureSandboxWorkspaceForSession: vi.fn(async () => null) }));
// mock-isolation: no global hook runner may observe or alter the prepared run.
vi.mock("../../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: vi.fn(() => null) }));

// The operator's opt-in to sending the native token to Anthropic's profile endpoint.
const attestNativeLogin: OpenClawConfig = {
  plugins: { entries: { anthropic: { config: { historyRecovery: { attestNativeLogin: true } } } } },
};

describe("native Claude login history on preparation", () => {
  let fixture: ReturnType<typeof createCliRunnerPrepareFixture>;
  // The synthetic token names its account to the stub profile endpoint.
  const login = (expiresAt = Date.parse("2030-01-01T00:00:00Z")) => {
    const dir = path.join(fixture.session.dir, "claude-config");
    const writeJson = (name: string, value: unknown) =>
      fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.rmSync(path.join(dir, ".credentials.json"), { force: true });
    writeJson(".claude.json", { oauthAccount: { accountUuid: "uuid:account-a" } });
    writeJson(".credentials.json", {
      claudeAiOauth: { accessToken: `synthetic-token-for-uuid:account-a-${expiresAt}`, expiresAt },
    });
  };
  const profile = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const bearer = new Headers(init?.headers).get("authorization") ?? "";
    const match = /^Bearer synthetic-token-for-(.+)-[^-]+$/u.exec(bearer);
    return match
      ? Response.json({ account: { uuid: match[1] }, organization: { uuid: "org" } })
      : new Response("{}", { status: 401 });
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", profile);
    setRawCliBackendForPrepareTest({
      ...buildDefaultTestCliBackend(),
      id: "claude-cli",
      pluginId: "anthropic",
      authEpochMode: "profile-only",
      autoSelectAuthProfile: false,
      config: {
        ...createJsonlStdinBackendConfig("claude"),
        reseedFromRawTranscriptWhenUncompacted: true,
      },
    });
    mockCliMcpPreparation({
      getActiveMcpLoopbackRuntime: vi.fn(() => undefined),
      ensureMcpLoopbackServer: vi.fn(createTestMcpLoopbackServer),
      resolveMcpLoopbackPolicyTools: vi.fn(() => ({ agentId: "main", tools: [] })),
      resolveMcpLoopbackScopedTools: vi.fn(() => ({ agentId: "main", tools: [] })),
    });
    fixture = createCliRunnerPrepareFixture((params) =>
      prepareCliRunContext({ skillsSnapshot: { prompt: "", skills: [] }, ...params }),
    );
    mockClaudeManagedSettings(path.join(fixture.session.dir, "managed"));
  });

  afterEach(async () => {
    await fixture.settle();
    cliBackendsTesting.resetDepsForTest();
    resetCliRunnerPrepareTestDeps();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await fixture.cleanup();
  });

  async function prepareAfterTurn(
    nextConfig: OpenClawConfig = attestNativeLogin,
    expiresAt?: number,
  ) {
    const { dir, sessionTarget } = fixture.session;
    const runId = "native-history-run";
    const params = {
      runId,
      provider: "claude-cli",
      model: "sonnet",
      sessionKey: sessionTarget.sessionKey,
    };
    await patchSessionEntryCore(sessionTarget, (entry) => ({ ...entry, activeWriterRunId: runId }));
    const admission = prepareSystemAgentRunAdmission({}, runId, "main", "native-history");
    try {
      login();
      const writer = await prepareCliHistoryBoundary(
        {
          admittedRunContext: await admission.admit("embedded"),
          ...params,
          config: attestNativeLogin,
          agentDir: path.join(dir, "agents", "main", "agent"),
          prompt: "seed",
          workspaceDir: dir,
          timeoutMs: 1000,
          sessionId: sessionTarget.sessionId,
          sessionFile: sessionTarget.sessionKey,
          sessionTarget,
        },
        { preparedBackend: { backend: { command: "claude" } } },
      );
      expect(writer).toBeDefined();
      await runWithCliHistoryWriter(writer, async () =>
        fixture.appendTranscript({
          id: "prior",
          parentId: null,
          timestamp: "2020-01-01T00:00:00.000Z",
          message: { role: "user", content: "native canary", timestamp: 1 },
        }),
      );
      login(expiresAt);
      profile.mockClear();
      const context = await fixture.prepare({
        config: nextConfig,
        ...params,
        preparedRunAdmission: admission,
      });
      // Releases the session sharing read the prepared backend retains.
      await context.preparedBackend.cleanup?.();
      return context;
    } finally {
      admission.close();
    }
  }

  it("seeds saved history for the same native login with no auth profile", async () => {
    const context = await prepareAfterTurn();
    expect(context.cliHistoryWriter).toBeDefined();
    expect(context.openClawHistoryPrompt).toContain("native canary");
  });

  it("never sends the native token to Anthropic unless the operator opted in", async () => {
    // A token this process never attested, so only the missing opt-in keeps it off the network.
    const context = await prepareAfterTurn({}, Date.parse("2031-01-01T00:00:00Z"));
    expect(context.cliHistoryWriter).toBeUndefined();
    expect(context.openClawHistoryPrompt).toBeUndefined();
    expect(profile).not.toHaveBeenCalled();
  });

  it("keeps coverage but sends no saved history while the CLI is about to rotate the token", async () => {
    const context = await prepareAfterTurn(attestNativeLogin, Date.now() + 60_000);
    expect(context.cliHistoryWriter?.replaysHistory).toBe(false);
    expect(context.openClawHistoryPrompt).toBeUndefined();
  });
});

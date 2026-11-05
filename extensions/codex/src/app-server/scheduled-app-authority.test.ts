import { describe, expect, it, vi } from "vitest";
import {
  buildPluginAppPolicyContext,
  type CodexPluginThreadConfig,
} from "./plugin-thread-config.js";
import { preparePluginThreadConfigForTest } from "./plugin-thread-config.test-helpers.js";
import {
  buildLegacyScheduledCodexAppRecoveryPrompt,
  buildScheduledCodexAppAuthorityInputFingerprint,
  captureScheduledCodexAppAuthority,
  intersectCodexPluginThreadConfigWithScheduledAuthority,
  readCurrentCodexScheduledAppPolicy,
  resolveScheduledCodexAppCreatorCaptureDecision,
} from "./scheduled-app-authority.js";
import { scheduledAppApprovalPolicyCases } from "./scheduled-app-authority.test-support.js";
import { readCodexManagedRequirementsFingerprint } from "./thread-requests.js";

function appPolicy(
  appName: string,
  destructiveApprovalMode: "allow" | "ask" | "deny" | "auto" = "allow",
  allow = true,
) {
  return {
    source: "account" as const,
    appName,
    allowDestructiveActions: allow,
    allowOpenWorld: allow,
    destructiveApprovalMode,
    mcpServerNames: [],
  };
}

function policyContext() {
  return buildPluginAppPolicyContext(
    { calendar: appPolicy("Calendar"), disabled: appPolicy("Disabled", "deny", false) },
    {},
  );
}

const preparedAuth = {
  kind: "prepared-profile" as const,
  profileId: "openai:work",
  accountId: "acct-1",
};

function capture(
  request: (
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<unknown>,
  options: Partial<Omit<Parameters<typeof captureScheduledCodexAppAuthority>[0], "client">> = {},
) {
  return captureScheduledCodexAppAuthority({
    client: { request } as never,
    threadId: "thread-final",
    policyContext: policyContext(),
    auth: preparedAuth,
    ...options,
  });
}

function toolsByApp(...tools: string[]) {
  return new Map([["calendar", new Map(tools.map((tool) => [tool, {}]))]]);
}

function expectCalendarTools(config: CodexPluginThreadConfig, tools: Record<string, unknown>) {
  expect(config.configPatch).toMatchObject({ apps: { calendar: { tools } } });
}

function connectorTool(destructiveHint?: boolean, openWorldHint?: boolean) {
  return {
    _meta: { connector_id: "calendar" },
    ...(destructiveHint === undefined ? {} : { annotations: { destructiveHint, openWorldHint } }),
  };
}

function toolConfig(default_tools_enabled: boolean, tools: Record<string, unknown> = {}) {
  return { default_tools_enabled, tools };
}

function policyClient({
  tools = {},
  config = {},
  requirements,
  apps = [{ id: "calendar", enabled: true, callable: true }],
  observe = () => {},
}: {
  tools?: Record<string, unknown>;
  config?: Record<string, unknown>;
  requirements?: unknown;
  apps?: Array<{ id: string; enabled: boolean; callable: boolean }>;
  observe?: (method: string, params: unknown, options?: { timeoutMs?: number }) => void;
} = {}) {
  return vi.fn(async (method: string, params: unknown, options?: { timeoutMs?: number }) => {
    observe(method, params, options);
    switch (method) {
      case "app/installed":
        return { apps };
      case "mcpServerStatus/list":
        return { data: [{ name: "codex_apps", tools }], nextCursor: null };
      case "config/read":
        return { config };
      case "configRequirements/read":
        if (requirements === undefined) {
          throw new Error(`unexpected method ${method}`);
        }
        return { requirements };
      default:
        throw new Error(`unexpected method ${method}`);
    }
  });
}

function scheduledProvider(request: Parameters<typeof capture>[0], requestTimeoutMs = 2_000) {
  return preparePluginThreadConfigForTest(
    {},
    "account-1",
    authority(),
  )({
    requestTimeoutMs,
    signal: new AbortController().signal,
    client: { request } as never,
    scheduledRuntimeAuthority: authority(),
  });
}

function capturedApp(
  tools: Record<string, string> = { list: "auto", edit: "approve" },
  allow = true,
  destructiveApprovalMode = "allow",
) {
  return {
    id: "calendar",
    allowDestructiveActions: allow,
    allowOpenWorld: allow,
    destructiveApprovalMode,
    tools,
  };
}

function authority(overrides?: Record<string, unknown>) {
  return {
    version: 1 as const,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload: {
      version: 1,
      auth: { profileId: "openai:work", accountId: "acct-1" },
      apps: [capturedApp()],
      ...overrides,
    },
  };
}

function threadConfig(unrestricted = false): CodexPluginThreadConfig {
  const context = buildPluginAppPolicyContext(
    {
      calendar: appPolicy("Calendar", "ask", false),
      newly_connected: appPolicy("New"),
    },
    {},
  );
  return {
    enabled: true,
    fingerprint: "current-fingerprint",
    inputFingerprint: "current-input",
    configPatch: { apps: {} },
    provisionalAppIds: ["calendar", "newly_connected"],
    policyContext: unrestricted ? policyContext() : context,
    diagnostics: [],
  };
}

function intersect(
  config: Record<string, unknown> = {},
  {
    thread = threadConfig(),
    tools = toolsByApp("edit"),
  }: {
    thread?: CodexPluginThreadConfig;
    tools?: NonNullable<
      Parameters<typeof intersectCodexPluginThreadConfigWithScheduledAuthority>[2]
    >["toolsByApp"];
  } = {},
) {
  return intersectCodexPluginThreadConfigWithScheduledAuthority(thread, authority(), {
    config,
    toolsByApp: tools,
  });
}

describe("scheduled Codex app authority", () => {
  it.each([
    [{ authenticatedScheduledMode: true }, "scheduled Codex continuation"],
    [{ usesSupervisionConnection: true }, "supervised connection"],
    [{ homeScope: "user" }, "user-home runtime"],
    [{ hasPreparedAccountIdentity: false }, "configured app-server identity"],
  ] as const)("refuses creator capture for %j before mutation", (overrides, message) => {
    const decision = resolveScheduledCodexAppCreatorCaptureDecision({
      appsMayBeVisible: true,
      authenticatedScheduledMode: false,
      usesSupervisionConnection: false,
      homeScope: "agent",
      hasPreparedAccountIdentity: true,
      hasConfiguredAppServerIdentity: false,
      ...overrides,
    });

    expect(decision).toMatchObject({ required: true, supported: false });
    expect(decision.unavailableReason).toContain(message);
    expect(decision.unavailableReason).toContain("no automation changes were saved");
  });

  it.each([
    ["prepared profile", true, false],
    ["configured app-server", false, true],
  ])("supports creator capture with a %s identity", (_name, prepared, configured) => {
    expect(
      resolveScheduledCodexAppCreatorCaptureDecision({
        appsMayBeVisible: true,
        authenticatedScheduledMode: false,
        usesSupervisionConnection: false,
        homeScope: "agent",
        hasPreparedAccountIdentity: prepared,
        hasConfiguredAppServerIdentity: configured,
      }),
    ).toEqual({ required: true, supported: true });
  });

  it.each(["prepared profile", "configured server", "no connector"] as const)(
    "captures exact-thread authority with %s",
    async (kind) => {
      const configured = kind === "configured server";
      const request = policyClient({
        apps: [
          { id: "calendar", enabled: true, callable: true },
          ...(configured ? [] : [{ id: "disabled", enabled: false, callable: true }]),
        ],
        tools:
          kind === "no connector"
            ? {}
            : configured
              ? { list: connectorTool() }
              : {
                  list: { title: "List events", ...connectorTool() },
                  create: connectorTool(),
                  unrelated: { _meta: { connector_id: "other" } },
                },
        config: configured
          ? {}
          : { apps: { calendar: { tools: { "List events": { approval_mode: "writes" } } } } },
        requirements: configured
          ? { hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command" }] }] } }
          : undefined,
        observe: (method, params) => {
          if (method === "app/installed" || method === "mcpServerStatus/list") {
            expect(params).toMatchObject({ threadId: "thread-final" });
          }
        },
      });
      const auth = configured
        ? {
            kind: "configured-app-server" as const,
            connectionFingerprint: "configured-connection",
          }
        : preparedAuth;
      const managedRequirementsFingerprint = configured
        ? await readCodexManagedRequirementsFingerprint({ request } as never)
        : undefined;
      const captured = await capture(request, { auth, configCwd: "/workspace" });
      if (kind === "no connector") {
        expect(captured).toBeUndefined();
      } else {
        expect(captured).toEqual(
          authority({
            apps: [
              capturedApp(configured ? { list: "approve" } : { create: "approve", list: "writes" }),
            ],
            ...(configured ? { auth: { ...auth, managedRequirementsFingerprint } } : {}),
          }),
        );
      }
      expect(request).toHaveBeenCalledWith(
        "config/read",
        { includeLayers: false, cwd: "/workspace" },
        expect.any(Object),
      );
    },
  );

  it.each(["page deadline", "RPC timeout", "clock rewind"] as const)(
    "bounds creator capture under %s",
    async (scenario) => {
      const clock = scenario === "clock rewind";
      const budget = clock ? 5_000 : 100;
      let wallClockReads = 0;
      const monotonic = clock ? vi.spyOn(performance, "now").mockReturnValue(500) : undefined;
      const wall = clock
        ? vi.spyOn(Date, "now").mockImplementation(() => (wallClockReads++ === 0 ? 500 : -89_500))
        : undefined;
      const timeouts: number[] = [];
      const base = policyClient({
        apps:
          scenario === "page deadline" ? [{ id: "calendar", enabled: true, callable: true }] : [],
        observe: (method, _params, options) => {
          if (method === "app/installed") {
            timeouts.push(options?.timeoutMs ?? -1);
          }
        },
      });
      let page = 0;
      const request = vi.fn(
        async (method: string, params: unknown, options?: { timeoutMs?: number }) => {
          if (method === "mcpServerStatus/list" && !clock) {
            if (scenario === "RPC timeout") {
              throw Object.assign(new Error("mcpServerStatus/list timed out"), {
                code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
                reason: "timed out",
                mayHaveWritten: false,
              });
            }
            if (++page === 1) {
              return { data: [], nextCursor: "page-2" };
            }
            return await new Promise<never>(() => {});
          }
          return base(method, params, options);
        },
      );
      const started = clock ? 0 : Date.now();
      try {
        const operation = capture(request, { timeoutMs: budget });
        if (clock) {
          await expect(operation).resolves.toBeUndefined();
          expect(timeouts).toEqual([budget]);
        } else {
          await expect(operation).rejects.toThrow("No automation changes were saved");
          if (scenario === "page deadline") {
            expect(page).toBe(2);
            expect(Date.now() - started).toBeLessThan(1_000);
          }
        }
      } finally {
        monotonic?.mockRestore();
        wall?.mockRestore();
      }
    },
  );

  it.each([
    { current: "ask", captured: "allow" },
    { current: "allow", captured: "ask" },
  ] as const)(
    "keeps link approvals with the user for current $current and captured $captured policy",
    ({ current, captured }) => {
      const config = threadConfig();
      config.policyContext.apps.calendar = appPolicy("Calendar", current);
      const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
        config,
        authority({
          apps: [capturedApp({ edit: "approve", blocked: "approve" }, true, captured)],
        }),
        {
          config: {
            apps: {
              calendar: {
                enabled: true,
                links: {
                  account: {
                    approvals_reviewer: "auto_review",
                    default_tools_approval_mode: "approve",
                  },
                },
                tools: {
                  edit: { approval_mode: "approve" },
                  blocked: { enabled: false, approval_mode: "approve" },
                },
              },
              newly_connected: { enabled: true },
            },
          },
          toolsByApp: toolsByApp("edit", "blocked"),
        },
      );

      expect(intersected.provisionalAppIds).toEqual(["calendar"]);
      expect(intersected.configPatch).toMatchObject({
        apps: {
          calendar: {
            approvals_reviewer: "user",
            links: {
              account: { approvals_reviewer: "user", default_tools_approval_mode: "auto" },
            },
            tools: {
              edit: { enabled: true, approval_mode: "prompt" },
              blocked: { enabled: false, approval_mode: "prompt" },
            },
          },
          newly_connected: { enabled: false },
          _default: { enabled: false, destructive_enabled: false, open_world_enabled: false },
        },
      });
    },
  );

  it.each<[string, Record<string, unknown>, boolean]>([
    ["tool deny", toolConfig(true, { edit: { enabled: false } }), false],
    ["default deny", toolConfig(false), false],
    ["destructive hint", { destructive_enabled: false }, false],
    ["open-world hint", { open_world_enabled: false }, false],
    ["tool over default", toolConfig(false, { edit: { enabled: true } }), true],
    [
      "tool over hints",
      { destructive_enabled: false, open_world_enabled: false, tools: { edit: { enabled: true } } },
      true,
    ],
    ["title allow", toolConfig(false, { "Edit event": { enabled: true } }), true],
    ["title deny", toolConfig(true, { "Edit event": { enabled: false } }), false],
    [
      "name over title",
      toolConfig(true, { edit: { enabled: false }, "Edit event": { enabled: true } }),
      false,
    ],
    [
      "name entry shadows title",
      toolConfig(false, { edit: { approval_mode: "prompt" }, "Edit event": { enabled: true } }),
      false,
    ],
  ])("preserves %s from current config", (_name, appConfig, enabled) => {
    expectCalendarTools(
      intersect(
        { apps: { calendar: appConfig } },
        {
          thread: threadConfig(true),
          tools: new Map([["calendar", new Map([["edit", { title: "Edit event" }]])]]),
        },
      ),
      { edit: { enabled } },
    );
  });

  it.each(["stored", "current"] as const)(
    "keeps %s app caps authoritative over explicit tool enablement",
    async (owner) => {
      const config = threadConfig();
      if (owner === "stored") {
        config.policyContext = policyContext();
      }
      const stored = authority();
      if (owner === "stored") {
        for (const app of stored.payload.apps) {
          app.allowDestructiveActions = false;
          app.allowOpenWorld = false;
        }
      }
      const currentPolicy = await readCurrentCodexScheduledAppPolicy({
        request: policyClient({
          config: {
            apps: {
              calendar: { default_tools_enabled: true, tools: { destructive: { enabled: true } } },
            },
          },
          tools: {
            newly_benign: connectorTool(false, false),
            destructive: connectorTool(true, false),
            open_world: connectorTool(false, true),
            unannotated: connectorTool(),
          },
        }),
      });

      const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
        config,
        stored,
        currentPolicy,
      );

      expectCalendarTools(intersected, {
        newly_benign: { enabled: true },
        destructive: { enabled: false },
        open_world: { enabled: false },
        unannotated: { enabled: false },
      });
    },
  );

  it.each(scheduledAppApprovalPolicyCases)(
    "preserves approval $name during capture and continuation",
    async ({ app, expected, toolMetadata }) => {
      const request = policyClient({
        config: { apps: { _default: { default_tools_approval_mode: "prompt" }, calendar: app } },
        tools: {
          edit: { title: "Edit event", _meta: { connector_id: "calendar", ...toolMetadata } },
        },
      });
      const captured = await capture(request);
      expect(captured).toMatchObject({ payload: { apps: [{ tools: { edit: expected } }] } });

      const config = threadConfig(true);
      const currentPolicy = await readCurrentCodexScheduledAppPolicy({ request });
      const intersected = intersectCodexPluginThreadConfigWithScheduledAuthority(
        config,
        authority(),
        currentPolicy,
      );
      expectCalendarTools(intersected, { edit: { approval_mode: expected } });
      const relaxed = intersectCodexPluginThreadConfigWithScheduledAuthority(config, captured, {
        ...currentPolicy,
        config: { apps: { calendar: { default_tools_approval_mode: "approve" } } },
      });
      expectCalendarTools(relaxed, { edit: { approval_mode: expected } });
    },
  );

  it("removes tools missing from current inventory and rotates the fingerprint", () => {
    const full = intersect({}, { tools: toolsByApp("list", "edit") });
    const narrowed = intersect({}, { tools: toolsByApp("list") });

    expectCalendarTools(narrowed, { list: expect.any(Object) });
    const narrowedApps = narrowed.configPatch?.apps as
      | Record<string, { tools?: unknown }>
      | undefined;
    expect(narrowedApps?.calendar?.tools).not.toHaveProperty("edit");
    expect(narrowed.fingerprint).not.toBe(full.fingerprint);
  });

  it("fails before execution when a captured app has no current connector tools", () => {
    expect(() =>
      intersectCodexPluginThreadConfigWithScheduledAuthority(threadConfig(), authority(), {
        config: {},
        toolsByApp: new Map(),
      }),
    ).toThrow("Scheduled Codex apps are unavailable under the current policy or account: calendar");
  });

  it("caps headless tools at the current app's auto approval mode", () => {
    const thread = threadConfig(true);
    thread.policyContext.apps.calendar = appPolicy("Calendar", "auto");
    expectCalendarTools(intersect({}, { thread }), {
      edit: { enabled: true, approval_mode: "auto" },
    });
  });

  it("rotates the input fingerprint when the stored cap changes", () => {
    const first = buildScheduledCodexAppAuthorityInputFingerprint("base", authority());
    const second = buildScheduledCodexAppAuthorityInputFingerprint(
      "base",
      authority({
        apps: [capturedApp({}, false, "deny")],
      }),
    );

    expect(first).not.toBe("base");
    expect(second).not.toBe(first);
    expect(buildScheduledCodexAppAuthorityInputFingerprint("base", undefined)).toBe("base");
  });

  it("fails closed for unknown or malformed Codex authority", () => {
    expect(() =>
      intersectCodexPluginThreadConfigWithScheduledAuthority(threadConfig(), {
        ...authority(),
        namespace: "codex.unknown",
      }),
    ).toThrow(/Unsupported Codex scheduled authority namespace/);
    expect(() =>
      intersectCodexPluginThreadConfigWithScheduledAuthority(
        threadConfig(),
        authority({ apps: [{ id: "calendar" }] }),
      ),
    ).toThrow(/Stored Codex app authority is invalid/);
  });

  it("reports captured app ids omitted by current policy without exposing the envelope", () => {
    const config = threadConfig();
    delete config.policyContext.apps.calendar;

    expect(() =>
      intersectCodexPluginThreadConfigWithScheduledAuthority(config, authority()),
    ).toThrow(
      "Scheduled Codex apps are unavailable under the current policy or account: calendar. Restore access or reauthorize the automation from a fresh authenticated Codex owner turn.",
    );
  });

  it("gives legacy scheduled caps a bounded operator recovery instruction", () => {
    const prompt = buildLegacyScheduledCodexAppRecoveryPrompt({
      trigger: "cron",
      scheduledRuntimeAuthorityRecoveryRequired: true,
    });

    expect(prompt).toContain("recreate or reauthorize");
    expect(prompt).toContain("authenticated Codex owner turn");
    expect(prompt).not.toContain("account-1");
    expect(
      buildLegacyScheduledCodexAppRecoveryPrompt({
        trigger: "user",
        scheduledRuntimeAuthorityRecoveryRequired: true,
      }),
    ).toBeUndefined();
  });

  it.each([true, false])("checks current-policy inventory with hanging=%s", async (hanging) => {
    const base = policyClient({ tools: { list: connectorTool() } });
    const request = async (method: string, params: Record<string, unknown>) => {
      if (method === "mcpServerStatus/list") {
        if (hanging) {
          return await new Promise<never>(() => {});
        }
        expect(params).toMatchObject({ threadId: "thread-existing", detail: "toolsAndAuthOnly" });
      }
      return base(method, params);
    };
    const provider = scheduledProvider(request, hanging ? 400 : 2_000);
    const startedAt = Date.now();
    await expect(
      provider.build(hanging ? undefined : { threadId: "thread-existing" }),
    ).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      message: expect.stringContaining(
        hanging
          ? "Codex app policy verification exceeded"
          : "Scheduled Codex apps are unavailable under the current policy or account: calendar",
      ),
    });
    if (hanging) {
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    }
  });
});

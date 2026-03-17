import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  readAllowFromStoreMock: vi.fn(),
  upsertPairingRequestMock: vi.fn(),
  resolveAgentRouteMock: vi.fn(),
  finalizeInboundContextMock: vi.fn(),
  buildCommandTextFromArgsMock: vi.fn(),
  findCommandByNativeNameMock: vi.fn(),
  listNativeCommandSpecsForConfigMock: vi.fn(),
  parseCommandArgsMock: vi.fn(),
  resolveCommandArgMenuMock: vi.fn(),
  resolveConversationLabelMock: vi.fn(),
  createReplyPrefixOptionsMock: vi.fn(),
  recordSessionMetaFromInboundMock: vi.fn(),
  recordInboundSessionMetaSafeMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>();
  return {
    ...actual,
    dispatchReplyWithDispatcher: (...args: unknown[]) => mocks.dispatchMock(...args),
    finalizeInboundContext: (...args: unknown[]) => mocks.finalizeInboundContextMock(...args),
    buildCommandTextFromArgs: (...args: unknown[]) => mocks.buildCommandTextFromArgsMock(...args),
    findCommandByNativeName: (...args: unknown[]) => mocks.findCommandByNativeNameMock(...args),
    listNativeCommandSpecsForConfig: (...args: unknown[]) =>
      mocks.listNativeCommandSpecsForConfigMock(...args),
    parseCommandArgs: (...args: unknown[]) => mocks.parseCommandArgsMock(...args),
    resolveCommandArgMenu: (...args: unknown[]) => mocks.resolveCommandArgMenuMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: (...args: unknown[]) => mocks.readAllowFromStoreMock(...args),
    upsertChannelPairingRequest: (...args: unknown[]) => mocks.upsertPairingRequestMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/routing")>();
  return {
    ...actual,
    resolveAgentRoute: (...args: unknown[]) => mocks.resolveAgentRouteMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/channel-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-runtime")>();
  return {
    ...actual,
    resolveConversationLabel: (...args: unknown[]) => mocks.resolveConversationLabelMock(...args),
    createReplyPrefixOptions: (...args: unknown[]) => mocks.createReplyPrefixOptionsMock(...args),
    recordInboundSessionMetaSafe: (...args: unknown[]) =>
      mocks.recordInboundSessionMetaSafeMock(...args),
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/config-runtime")>();
  return {
    ...actual,
    recordSessionMetaFromInbound: (...args: unknown[]) =>
      mocks.recordSessionMetaFromInboundMock(...args),
    resolveStorePath: (...args: unknown[]) => mocks.resolveStorePathMock(...args),
    resolveNativeCommandsEnabled: ({
      providerSetting,
      defaultEnabled,
    }: {
      providerSetting?: boolean;
      defaultEnabled?: boolean;
    }) => providerSetting ?? defaultEnabled ?? true,
    resolveNativeSkillsEnabled: ({
      providerSetting,
      defaultEnabled,
    }: {
      providerSetting?: boolean;
      defaultEnabled?: boolean;
    }) => providerSetting ?? defaultEnabled ?? false,
  };
});

type SlashHarnessMocks = {
  dispatchMock: ReturnType<typeof vi.fn>;
  readAllowFromStoreMock: ReturnType<typeof vi.fn>;
  upsertPairingRequestMock: ReturnType<typeof vi.fn>;
  resolveAgentRouteMock: ReturnType<typeof vi.fn>;
  finalizeInboundContextMock: ReturnType<typeof vi.fn>;
  buildCommandTextFromArgsMock: ReturnType<typeof vi.fn>;
  findCommandByNativeNameMock: ReturnType<typeof vi.fn>;
  listNativeCommandSpecsForConfigMock: ReturnType<typeof vi.fn>;
  parseCommandArgsMock: ReturnType<typeof vi.fn>;
  resolveCommandArgMenuMock: ReturnType<typeof vi.fn>;
  resolveConversationLabelMock: ReturnType<typeof vi.fn>;
  createReplyPrefixOptionsMock: ReturnType<typeof vi.fn>;
  recordSessionMetaFromInboundMock: ReturnType<typeof vi.fn>;
  recordInboundSessionMetaSafeMock: ReturnType<typeof vi.fn>;
  resolveStorePathMock: ReturnType<typeof vi.fn>;
};

export function getSlackSlashMocks(): SlashHarnessMocks {
  return mocks;
}

export function resetSlackSlashMocks() {
  const usageCommand = { key: "usage", nativeName: "usage" };
  const reportCommand = { key: "report", nativeName: "report" };
  const reportCompactCommand = { key: "reportcompact", nativeName: "reportcompact" };
  const reportExternalCommand = { key: "reportexternal", nativeName: "reportexternal" };
  const reportLongCommand = { key: "reportlong", nativeName: "reportlong" };
  const unsafeConfirmCommand = { key: "unsafeconfirm", nativeName: "unsafeconfirm" };
  const statusAliasCommand = { key: "status", nativeName: "status" };
  const periodArg = { name: "period", description: "period" };
  const baseReportPeriodChoices = [
    { value: "day", label: "day" },
    { value: "week", label: "week" },
    { value: "month", label: "month" },
    { value: "quarter", label: "quarter" },
  ];
  const fullReportPeriodChoices = [...baseReportPeriodChoices, { value: "year", label: "year" }];
  const hasNonEmptyArgValue = (values: unknown, key: string) => {
    const raw =
      typeof values === "object" && values !== null
        ? (values as Record<string, unknown>)[key]
        : undefined;
    return typeof raw === "string" && raw.trim().length > 0;
  };
  const resolvePeriodMenu = (
    params: { args?: { values?: unknown } },
    choices: Array<{
      value: string;
      label: string;
    }>,
  ) => {
    if (hasNonEmptyArgValue(params.args?.values, "period")) {
      return null;
    }
    return { arg: periodArg, choices };
  };

  mocks.dispatchMock.mockReset().mockResolvedValue({ counts: { final: 1, tool: 0, block: 0 } });
  mocks.readAllowFromStoreMock.mockReset().mockResolvedValue([]);
  mocks.upsertPairingRequestMock.mockReset().mockResolvedValue({ code: "PAIRCODE", created: true });
  mocks.resolveAgentRouteMock.mockReset().mockReturnValue({
    agentId: "main",
    sessionKey: "session:1",
    accountId: "acct",
  });
  mocks.finalizeInboundContextMock.mockReset().mockImplementation((ctx: unknown) => ctx);
  mocks.buildCommandTextFromArgsMock
    .mockReset()
    .mockImplementation(
      (cmd: { nativeName?: string; key: string }, args?: { values?: Record<string, unknown> }) => {
        const name = cmd.nativeName ?? cmd.key;
        const values = args?.values ?? {};
        const mode = values.mode;
        const period = values.period;
        const selected =
          typeof mode === "string" && mode.trim()
            ? mode.trim()
            : typeof period === "string" && period.trim()
              ? period.trim()
              : "";
        return selected ? `/${name} ${selected}` : `/${name}`;
      },
    );
  mocks.findCommandByNativeNameMock.mockReset().mockImplementation((name: string) => {
    const normalized = name.trim().toLowerCase();
    if (normalized === "usage") {
      return usageCommand;
    }
    if (normalized === "report") {
      return reportCommand;
    }
    if (normalized === "reportcompact") {
      return reportCompactCommand;
    }
    if (normalized === "reportexternal") {
      return reportExternalCommand;
    }
    if (normalized === "reportlong") {
      return reportLongCommand;
    }
    if (normalized === "unsafeconfirm") {
      return unsafeConfirmCommand;
    }
    if (normalized === "agentstatus") {
      return statusAliasCommand;
    }
    return undefined;
  });
  mocks.listNativeCommandSpecsForConfigMock.mockReset().mockReturnValue([
    {
      name: "usage",
      description: "Usage",
      acceptsArgs: true,
      args: [],
    },
    {
      name: "report",
      description: "Report",
      acceptsArgs: true,
      args: [],
    },
    {
      name: "reportcompact",
      description: "ReportCompact",
      acceptsArgs: true,
      args: [],
    },
    {
      name: "reportexternal",
      description: "ReportExternal",
      acceptsArgs: true,
      args: [],
    },
    {
      name: "reportlong",
      description: "ReportLong",
      acceptsArgs: true,
      args: [],
    },
    {
      name: "unsafeconfirm",
      description: "UnsafeConfirm",
      acceptsArgs: true,
      args: [],
    },
    {
      name: "agentstatus",
      description: "Status",
      acceptsArgs: false,
      args: [],
    },
  ]);
  mocks.parseCommandArgsMock.mockReset().mockReturnValue({ values: {} });
  mocks.resolveCommandArgMenuMock
    .mockReset()
    .mockImplementation((params: { command?: { key?: string }; args?: { values?: unknown } }) => {
      if (params.command?.key === "report") {
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { value: "all", label: "all" },
        ]);
      }
      if (params.command?.key === "reportlong") {
        return resolvePeriodMenu(params, [
          ...fullReportPeriodChoices,
          { value: "x".repeat(90), label: "long" },
        ]);
      }
      if (params.command?.key === "reportcompact") {
        return resolvePeriodMenu(params, baseReportPeriodChoices);
      }
      if (params.command?.key === "reportexternal") {
        return {
          arg: { name: "period", description: "period" },
          choices: Array.from({ length: 140 }, (_v, i) => ({
            value: `period-${i + 1}`,
            label: `Period ${i + 1}`,
          })),
        };
      }
      if (params.command?.key === "unsafeconfirm") {
        return {
          arg: { name: "mode_*`~<&>", description: "mode" },
          choices: [
            { value: "on", label: "on" },
            { value: "off", label: "off" },
          ],
        };
      }
      if (params.command?.key !== "usage") {
        return null;
      }
      const values = (params.args?.values ?? {}) as Record<string, unknown>;
      if (typeof values.mode === "string" && values.mode.trim()) {
        return null;
      }
      return {
        arg: { name: "mode", description: "mode" },
        choices: [
          { value: "tokens", label: "tokens" },
          { value: "cost", label: "cost" },
        ],
      };
    });
  mocks.resolveConversationLabelMock.mockReset().mockReturnValue(undefined);
  mocks.createReplyPrefixOptionsMock.mockReset().mockReturnValue({ onModelSelected: () => {} });
  mocks.recordSessionMetaFromInboundMock.mockReset().mockResolvedValue(undefined);
  mocks.recordInboundSessionMetaSafeMock.mockReset().mockImplementation(async (params: unknown) => {
    await mocks.recordSessionMetaFromInboundMock(params);
  });
  mocks.resolveStorePathMock.mockReset().mockReturnValue("/tmp/openclaw-sessions.json");
}

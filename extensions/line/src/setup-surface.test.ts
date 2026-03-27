import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeApiExportTypesViaJiti } from "../../../test/helpers/extensions/jiti-runtime-api.ts";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import { createStartAccountContext } from "../../../test/helpers/extensions/start-account-context.js";
import type { OpenClawConfig, PluginRuntime, ResolvedLineAccount } from "../api.js";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

const { getBotInfoMock, MessagingApiClientMock } = vi.hoisted(() => {
  const getBotInfoMock = vi.fn();
  const MessagingApiClientMock = vi.fn(function () {
    return { getBotInfo: getBotInfoMock };
  });
  return { getBotInfoMock, MessagingApiClientMock };
});

vi.mock("@line/bot-sdk", () => ({
  messagingApi: { MessagingApiClient: MessagingApiClientMock },
}));

const lineConfigure = createPluginSetupWizardConfigure(linePlugin);
let probeLineBot: typeof import("./probe.js").probeLineBot;

function normalizeModuleSpecifier(specifier: string): string | null {
  if (specifier.startsWith("./src/")) {
    return specifier;
  }
  if (specifier.startsWith("../../extensions/line/src/")) {
    return `./src/${specifier.slice("../../extensions/line/src/".length)}`;
  }
  return null;
}

function collectModuleExportNames(filePath: string): string[] {
  const sourcePath = filePath.replace(/\.js$/, ".ts");
  const sourceText = readFileSync(sourcePath, "utf8");
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (!element.isTypeOnly) {
          names.add(element.name.text);
        }
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    const isExported = modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!isExported) {
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text);
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      if (statement.name) {
        names.add(statement.name.text);
      }
    }
  }

  return Array.from(names).toSorted();
}

function collectRuntimeApiPreExports(runtimeApiPath: string): string[] {
  const runtimeApiSource = readFileSync(runtimeApiPath, "utf8");
  const runtimeApiFile = ts.createSourceFile(
    runtimeApiPath,
    runtimeApiSource,
    ts.ScriptTarget.Latest,
    true,
  );
  const preExports = new Set<string>();
  let pluginSdkLineRuntimeSeen = false;

  for (const statement of runtimeApiFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }
    const moduleSpecifier =
      statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : undefined;
    if (!moduleSpecifier) {
      continue;
    }
    if (moduleSpecifier === "openclaw/plugin-sdk/line-runtime") {
      pluginSdkLineRuntimeSeen = true;
      break;
    }
    const normalized = normalizeModuleSpecifier(moduleSpecifier);
    if (!normalized) {
      continue;
    }

    if (!statement.exportClause) {
      for (const name of collectModuleExportNames(
        path.join(process.cwd(), "extensions", "line", normalized),
      )) {
        preExports.add(name);
      }
      continue;
    }

    if (!ts.isNamedExports(statement.exportClause)) {
      continue;
    }

    for (const element of statement.exportClause.elements) {
      if (!element.isTypeOnly) {
        preExports.add(element.name.text);
      }
    }
  }

  if (!pluginSdkLineRuntimeSeen) {
    return [];
  }

  return Array.from(preExports).toSorted();
}

describe("line setup wizard", () => {
  it("configures token and secret for the default account", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter LINE channel access token") {
          return "line-token";
        }
        if (message === "Enter LINE channel secret") {
          return "line-secret";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: lineConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.line?.enabled).toBe(true);
    expect(result.cfg.channels?.line?.channelAccessToken).toBe("line-token");
    expect(result.cfg.channels?.line?.channelSecret).toBe("line-secret");
  });
});

describe("probeLineBot", () => {
  beforeEach(async () => {
    vi.resetModules();
    getBotInfoMock.mockReset();
    MessagingApiClientMock.mockReset();
    MessagingApiClientMock.mockImplementation(function () {
      return { getBotInfo: getBotInfoMock };
    });
    ({ probeLineBot } = await import("./probe.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    getBotInfoMock.mockClear();
  });

  it("returns timeout when bot info stalls", async () => {
    vi.useFakeTimers();
    getBotInfoMock.mockImplementation(() => new Promise(() => {}));

    const probePromise = probeLineBot("token", 10);
    await vi.advanceTimersByTimeAsync(20);
    const result = await probePromise;

    expect(result.ok).toBe(false);
    expect(result.error).toBe("timeout");
  });

  it("returns bot info when available", async () => {
    getBotInfoMock.mockResolvedValue({
      displayName: "OpenClaw",
      userId: "U123",
      basicId: "@openclaw",
      pictureUrl: "https://example.com/bot.png",
    });

    const result = await probeLineBot("token", 50);

    expect(result.ok).toBe(true);
    expect(result.bot?.userId).toBe("U123");
  });
});

describe("line runtime api", () => {
  it("loads through Jiti without duplicate export errors", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "line", "runtime-api.ts");

    expect(
      loadRuntimeApiExportTypesViaJiti({
        modulePath: runtimeApiPath,
        exportNames: [
          "buildTemplateMessageFromPayload",
          "downloadLineMedia",
          "isSenderAllowed",
          "probeLineBot",
          "pushMessageLine",
        ],
        realPluginSdkSpecifiers: ["openclaw/plugin-sdk/line-runtime"],
      }),
    ).toEqual({
      buildTemplateMessageFromPayload: "function",
      downloadLineMedia: "function",
      isSenderAllowed: "function",
      probeLineBot: "function",
      pushMessageLine: "function",
    });
  }, 240_000);

  it("keeps the LINE runtime barrel self-contained", () => {
    const runtimeApiPath = path.join(process.cwd(), "extensions", "line", "runtime-api.ts");
    expect(collectRuntimeApiPreExports(runtimeApiPath)).toEqual([]);
    const runtimeApiSource = readFileSync(runtimeApiPath, "utf8");

    expect(runtimeApiSource).not.toContain("openclaw/plugin-sdk/line-runtime");
    expect(collectRuntimeApiPreExports(runtimeApiPath)).toEqual([]);
  });
});

function createRuntime() {
  const monitorLineProvider = vi.fn(async () => ({
    account: { accountId: "default" },
    handleWebhook: async () => {},
    stop: () => {},
  }));

  const runtime = {
    channel: {
      line: {
        monitorLineProvider,
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;

  return { runtime, monitorLineProvider };
}

function createAccount(params: { token: string; secret: string }): ResolvedLineAccount {
  return {
    accountId: "default",
    enabled: true,
    channelAccessToken: params.token,
    channelSecret: params.secret,
    tokenSource: "config",
    config: {} as ResolvedLineAccount["config"],
  };
}

function startLineAccount(params: { account: ResolvedLineAccount; abortSignal?: AbortSignal }) {
  const { runtime, monitorLineProvider } = createRuntime();
  setLineRuntime(runtime);
  return {
    monitorLineProvider,
    task: linePlugin.gateway!.startAccount!(
      createStartAccountContext({
        account: params.account,
        abortSignal: params.abortSignal,
      }),
    ),
  };
}

describe("linePlugin gateway.startAccount", () => {
  it("fails startup when channel secret is missing", async () => {
    const { monitorLineProvider, task } = startLineAccount({
      account: createAccount({ token: "token", secret: "   " }),
    });

    await expect(task).rejects.toThrow(
      'LINE webhook mode requires a non-empty channel secret for account "default".',
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("fails startup when channel access token is missing", async () => {
    const { monitorLineProvider, task } = startLineAccount({
      account: createAccount({ token: "   ", secret: "secret" }),
    });

    await expect(task).rejects.toThrow(
      'LINE webhook mode requires a non-empty channel access token for account "default".',
    );
    expect(monitorLineProvider).not.toHaveBeenCalled();
  });

  it("starts provider when token and secret are present", async () => {
    const abort = new AbortController();
    const { monitorLineProvider, task } = startLineAccount({
      account: createAccount({ token: "token", secret: "secret" }),
      abortSignal: abort.signal,
    });

    await vi.waitFor(() => {
      expect(monitorLineProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          channelAccessToken: "token",
          channelSecret: "secret",
          accountId: "default",
        }),
      );
    });

    abort.abort();
    await task;
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  OpenClawPluginCommandDefinition,
  OpenClawPluginService,
  PluginCommandContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import register, { __testing } from "./index.js";
import { runAlertCheck, type AlertDelivery } from "./src/alert-runner.js";
import { createAlertStore, parseAlertRequest } from "./src/alerts.js";
import { readGesahniConfig } from "./src/config.js";
import type { MarketDataClient } from "./src/market-data.js";

function createMarketDataClient(): MarketDataClient {
  return {
    quote: vi.fn(async (symbol: string) => ({
      symbol,
      bid: 209.9,
      ask: 210.1,
      mark: 210,
      timestamp: "2026-05-06T14:30:00Z",
      source: "TestData",
    })),
    optionQuote: vi.fn(async (contract) => ({
      symbol: contract.occSymbol,
      bid: 30.9,
      ask: 31.1,
      mark: 31,
      timestamp: "2026-05-06T14:31:00Z",
      source: "TestData",
    })),
    bars: vi.fn(async (symbol: string) =>
      [208, 208.5, 209, 210, 209.5, 211].map((close, index) => ({
        symbol,
        close,
        timestamp: `2026-05-06T14:${String(index).padStart(2, "0")}:00Z`,
      })),
    ),
    status: () => "TestData configured",
  };
}

function createContext(
  args: string,
  overrides: Partial<PluginCommandContext> = {},
): PluginCommandContext {
  return {
    channel: "discord",
    channelId: "1498120236770267187",
    senderId: "1309247958029701190",
    isAuthorizedSender: true,
    commandBody: args ? `/gesahni ${args}` : "/gesahni",
    args,
    config: {},
    from: "discord:channel:1498120236770267187",
    to: "slash:1309247958029701190",
    requestConversationBinding: async () => ({ status: "error", message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

function createDmContext(
  args: string,
  overrides: Partial<PluginCommandContext> = {},
): PluginCommandContext {
  return createContext(args, {
    channelId: undefined,
    from: "discord:1309247958029701190",
    ...overrides,
  });
}

async function withTmpState<T>(run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gesahni-test-"));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

describe("gesahni plugin", () => {
  it("keeps legacy bridge config valid for startup", () => {
    const config = readGesahniConfig({
      baseUrl: "https://api.gesahni.example",
      readBridgeToken: "read-token",
      writeBridgeToken: "write-token",
      defaultTimeoutMs: 1500,
      bridge: {
        userId: "tg:123",
      },
    });

    expect(config.bridge).toEqual({
      baseUrl: "https://api.gesahni.example",
      readBridgeToken: "read-token",
      writeBridgeToken: "write-token",
      defaultTimeoutMs: 1500,
      userId: "tg:123",
    });
  });

  it("registers product commands", async () => {
    await withTmpState(async (stateDir) => {
      const commands: OpenClawPluginCommandDefinition[] = [];
      const services: OpenClawPluginService[] = [];
      const hooks: string[] = [];
      register.register(
        createTestPluginApi({
          id: "gesahni",
          name: "Gesahni",
          pluginConfig: {},
          runtime: {
            state: { resolveStateDir: () => stateDir },
          } as never,
          registerCommand: (command) => commands.push(command),
          registerService: (service) => services.push(service),
          on: (event) => hooks.push(event),
        }),
      );

      expect(commands.map((command) => command.name).toSorted()).toEqual([
        "alert",
        "alerts",
        "chart",
        "contract",
        "quote",
        "stockhelp",
        "stockstatus",
      ]);
      expect(commands.every((command) => command.channels?.includes("discord"))).toBe(true);
      expect(services.map((service) => service.id)).toEqual(["gesahni-alert-runner"]);
      expect(hooks).toEqual(["before_dispatch", "before_prompt_build"]);
    });
  });

  it("adds Discord stock-room voice and reaction guidance for agent replies", () => {
    const guidance = __testing.resolvePromptGuidance({
      prompt: "hi",
      messageProvider: "discord",
    });

    expect(guidance).toContain("Gesahni Discord stock-room voice:");
    expect(guidance).toContain("Sound relaxed, sharp, and a little fun");
    expect(guidance).toContain("Prefer Discord reactions for lightweight state");
    expect(guidance).toContain("👀 for checking");
    expect(guidance).toContain("keep personal/private lists private");
  });

  it("does not add Discord stock-room voice outside Discord or Gesahni turns", () => {
    expect(
      __testing.resolvePromptGuidance({
        prompt: "summarize this repo",
        messageProvider: "telegram",
      }),
    ).toBeUndefined();
  });

  it("adds screenshot guidance for replied image analysis turns", () => {
    const guidance = __testing.resolveScreenshotPromptGuidance(
      '@gesahni thoughts on this\nReply target of current user message (untrusted, for context):\n```json\n{"body":"<media:image> (1 image)"}\n```',
    );

    expect(guidance).toContain("separate what is visible in the image from live market data");
    expect(guidance).toContain("extract symbol, expiry, strike, right, quantity");
    expect(guidance).toContain("label any intrinsic-value math as an estimate");
  });

  it("combines Discord voice and screenshot guidance for replied image turns", () => {
    const guidance = __testing.resolvePromptGuidance({
      prompt:
        '@gesahni thoughts on this\nReply target of current user message (untrusted, for context):\n```json\n{"body":"<media:image> (1 image)"}\n```',
      messageProvider: "discord",
    });

    expect(guidance).toContain("Gesahni Discord stock-room voice:");
    expect(guidance).toContain("Gesahni Discord screenshot guidance:");
  });

  it("returns fast quote output without an agent session", async () => {
    await withTmpState(async (stateDir) => {
      const command = __testing.createQuoteCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });

      const result = await command.handler(createContext("AAPL"));

      expect(result.text).toContain("AAPL - $210.00");
      expect(result.text).toContain("Source: TestData");
      expect(result.text).toContain("Educational only.");
    });
  });

  it("returns a fast stock command help summary", async () => {
    const command = __testing.createStockHelpCommand();

    const result = await command.handler(createContext(""));

    expect(result.text).toContain("Gesahni stock commands:");
    expect(result.text).toContain("/quote AAPL");
    expect(result.text).toContain("/alert group AAPL above 210");
    expect(result.text).toContain("/alerts me - list private alerts in DM only.");
  });

  it("normalizes option-contract shorthand", async () => {
    await withTmpState(async (stateDir) => {
      const command = __testing.createContractCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });

      const result = await command.handler(createContext("MU 647.5C 5/8"));

      expect(result.text).toContain("MU 647.5C");
      expect(result.text).toContain("OCC: MU");
      expect(result.text).toContain("C00647500");
      expect(result.text).toContain("Option mark: $31.00");
    });
  });

  it("analyzes option trade references with underlying context", async () => {
    await withTmpState(async (stateDir) => {
      const marketDataClient = createMarketDataClient();
      vi.mocked(marketDataClient.quote).mockImplementation(async (symbol: string) => ({
        symbol,
        bid: 677.9,
        ask: 678.1,
        mark: 678,
        timestamp: "2026-05-06T14:32:00Z",
        source: "TestData",
      }));
      const command = __testing.createContractCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient,
      });

      const result = await command.handler(createContext("sold 1 MU 647.5C 5/8 for 19.50"));

      expect(result.text).toContain("Underlying: $678.00");
      expect(result.text).toContain("Intrinsic: $30.50");
      expect(result.text).toContain("Estimated time value: $0.50");
      expect(result.text).toContain("Sold/closed reference: 1 contract at $19.50 = $1950.00");
      expect(result.text).toContain("Current value: $3100.00");
      expect(result.text).toContain("Extra upside versus that sale: +$1150.00.");
      expect(result.text).toContain("Want me to set an alert for the next level?");
    });
  });

  it("labels intrinsic-value fallback when option quotes are unavailable", async () => {
    await withTmpState(async (stateDir) => {
      const marketDataClient = createMarketDataClient();
      vi.mocked(marketDataClient.quote).mockResolvedValue({
        symbol: "MU",
        bid: 677.9,
        ask: 678.1,
        mark: 678,
        timestamp: "2026-05-06T14:32:00Z",
        source: "TestData",
      });
      vi.mocked(marketDataClient.optionQuote).mockRejectedValue(new Error("option feed down"));
      const command = __testing.createContractCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient,
      });

      const result = await command.handler(createContext("MU 647.5C 5/8"));

      expect(result.text).toContain(
        "Option quote unavailable; using intrinsic value as a floor estimate",
      );
      expect(result.text).toContain("Current value: $3050.00");
      expect(result.text).toContain("contract value is estimated from intrinsic value only");
    });
  });

  it("does not call below-sale estimates extra upside", async () => {
    await withTmpState(async (stateDir) => {
      const marketDataClient = createMarketDataClient();
      vi.mocked(marketDataClient.quote).mockResolvedValue({
        symbol: "MU",
        bid: 645.8,
        ask: 645.9,
        mark: 645.85,
        timestamp: "2026-05-06T15:02:00Z",
        source: "TestData",
      });
      vi.mocked(marketDataClient.optionQuote).mockRejectedValue(new Error("option feed down"));
      const command = __testing.createContractCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient,
      });

      const result = await command.handler(createContext("sold 1 MU 647.5C 5/8 for 19.50"));

      expect(result.text).toContain("Current estimate is $1950.00 below that sale.");
      expect(result.text).not.toContain("Extra upside versus that sale: -");
    });
  });

  it("returns data-driven chart output without image generation", async () => {
    await withTmpState(async (stateDir) => {
      const command = __testing.createChartCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });

      const result = await command.handler(createContext("AAPL"));

      expect(result.text).toContain("AAPL data chart");
      expect(result.text).toContain("Range: 208.00 - 211.00");
      expect(result.text).toContain("Source: Alpaca bars. Educational only.");
      expect(result.mediaUrl).toEqual(expect.stringContaining("aapl-"));
      await expect(fs.stat(result.mediaUrl as string)).resolves.toMatchObject({
        mode: expect.any(Number),
      });
    });
  });

  it("previews and confirms group alerts", async () => {
    await withTmpState(async (stateDir) => {
      const command = __testing.createAlertCommand({
        pluginConfig: {
          alerts: {
            groupChannelId: "1500000000000000000",
            groupChannelName: "stock-alerts",
          },
        },
        stateDir,
        marketDataClient: createMarketDataClient(),
      });

      const preview = await command.handler(createContext("group AAPL above 210"));
      const id = /Alert id: (alrt_[^\s]+)/.exec(preview.text ?? "")?.[1];

      expect(preview.text).toContain("Group alert preview: AAPL above 210.00.");
      expect(preview.text).toContain("Delivery: #stock-alerts.");
      expect(id).toBeTruthy();

      const confirmed = await command.handler(createContext(`confirm ${id}`));
      expect(confirmed.text).toContain("Alert saved: AAPL above 210.00 -> #stock-alerts.");
    });
  });

  it("defaults group alerts to the stock-alerts delivery target", async () => {
    await withTmpState(async (stateDir) => {
      const command = __testing.createAlertCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });
      const store = createAlertStore(stateDir);

      const preview = await command.handler(createContext("group AAPL above 210"));
      const id = /Alert id: (alrt_[^\s]+)/.exec(preview.text ?? "")?.[1];
      await command.handler(createContext(`confirm ${id}`));

      const active = await store.listActive();
      expect(active[0]?.delivery).toEqual({
        channel: "discord",
        target: "channel:stock-alerts",
        label: "#stock-alerts",
      });
    });
  });

  it("can owner-gate future group alert creation", async () => {
    await withTmpState(async (stateDir) => {
      const command = __testing.createAlertCommand({
        pluginConfig: { alerts: { groupCreation: "owner" } },
        stateDir,
        marketDataClient: createMarketDataClient(),
      });

      const denied = await command.handler(createContext("group AAPL above 210"));
      const allowed = await command.handler(
        createContext("group AAPL above 210", { senderIsOwner: true }),
      );

      expect(denied.text).toBe("Group alert creation is owner-only right now.");
      expect(allowed.text).toContain("Group alert preview: AAPL above 210.00.");
    });
  });

  it("parses natural-language alert requests into previews", async () => {
    await withTmpState(async (stateDir) => {
      const command = __testing.createAlertCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });

      const result = await command.handler(createContext("alert pr when AAPL gets over 210"));

      expect(result.text).toContain("Group alert preview: AAPL above 210.00.");
      expect(result.text).toContain("Reply with /alert confirm");
    });
  });

  it("keeps private alert lists DM-only", async () => {
    await withTmpState(async (stateDir) => {
      const alertCommand = __testing.createAlertCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });
      const alertsCommand = __testing.createAlertsCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });

      const preview = await alertCommand.handler(createDmContext("MU above 680"));
      expect(preview.text).toContain("Private alert preview:");
      await alertCommand.handler(createDmContext("confirm"));

      const publicList = await alertsCommand.handler(createContext("me"));
      expect(publicList.text).toBe("Private alerts can only be listed in DM.");

      const dmList = await alertsCommand.handler(createDmContext(""));
      expect(dmList.text).toContain("MU above 680.00");
    });
  });

  it("handles the DM natural-language private alert lifecycle before onboarding", async () => {
    await withTmpState(async (stateDir) => {
      const options = {
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      };
      const event = {
        channel: "discord",
        sessionKey: "agent:gesahni-discord-dm:main",
        senderId: "1309247958029701190",
        isGroup: false,
      };
      const ctx = {
        conversationId: "discord:1309247958029701190",
        sessionKey: event.sessionKey,
        senderId: "1309247958029701190",
      };

      const preview = await __testing.handleStockAlertDispatch(
        { ...event, content: "alert me if AAPL breaks 210" },
        ctx,
        options,
      );
      expect(preview).toMatchObject({ handled: true });
      expect(preview?.text).toContain("Private alert preview:");
      expect(preview?.text).toContain("- Symbol: AAPL");
      expect(preview?.text).toContain("- Condition: price above 210.00");
      expect(preview?.text).toContain("- Scope: private DM");
      expect(preview?.text).toContain("- Delivery: this DM");
      expect(preview?.text).toContain('Reply "confirm" to save');

      const confirmed = await __testing.handleStockAlertDispatch(
        { ...event, content: "confirm" },
        ctx,
        options,
      );
      expect(confirmed?.text).toBe("Saved private alert for AAPL above 210.00.");

      const listed = await __testing.handleStockAlertDispatch(
        { ...event, content: "/alerts" },
        ctx,
        options,
      );
      expect(listed?.text).toContain("AAPL above 210.00 -> DM");
      expect(listed?.text).not.toContain("#stock-alerts");

      const deleted = await __testing.handleStockAlertDispatch(
        { ...event, content: "delete the AAPL 210 alert" },
        ctx,
        options,
      );
      expect(deleted?.text).toBe("Deleted private alert for AAPL.");

      const listedAfterDelete = await __testing.handleStockAlertDispatch(
        { ...event, content: "/alerts" },
        ctx,
        options,
      );
      expect(listedAfterDelete?.text).toBe("No private alerts are active.");
    });
  });

  it("blocks public natural-language alert creation before the agent can mutate state", async () => {
    await withTmpState(async (stateDir) => {
      const result = await __testing.handleStockAlertDispatch(
        {
          channel: "discord",
          content: "create a public alert for AAPL above 210",
          sessionKey: "agent:gesahni-discord-escalation:discord:channel:1498120236770267187",
          senderId: "1309247958029701190",
          isGroup: true,
        },
        {
          conversationId: "channel:1498120236770267187",
          sessionKey: "agent:gesahni-discord-escalation:discord:channel:1498120236770267187",
          senderId: "1309247958029701190",
        },
        {
          pluginConfig: {},
          stateDir,
          marketDataClient: createMarketDataClient(),
        },
      );
      const store = createAlertStore(stateDir);

      expect(result?.handled).toBe(true);
      expect(result?.text).toContain("I can't create, confirm, update, or delete alerts");
      expect(result?.text).not.toContain("No private alerts");
      await expect(store.listActive()).resolves.toEqual([]);
    });
  });

  it("blocks public alert-me phrasing without exposing private alert details", async () => {
    await withTmpState(async (stateDir) => {
      const alertCommand = __testing.createAlertCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });
      await alertCommand.handler(createDmContext("MU above 680"));
      await alertCommand.handler(createDmContext("confirm"));

      const result = await __testing.handleStockAlertDispatch(
        {
          channel: "discord",
          content: "alert me if AAPL breaks 210",
          sessionKey: "agent:gesahni-discord-escalation:discord:channel:1498120236770267187",
          senderId: "1309247958029701190",
          isGroup: true,
        },
        {
          conversationId: "channel:1498120236770267187",
          sessionKey: "agent:gesahni-discord-escalation:discord:channel:1498120236770267187",
          senderId: "1309247958029701190",
        },
        {
          pluginConfig: {},
          stateDir,
          marketDataClient: createMarketDataClient(),
        },
      );

      expect(result?.handled).toBe(true);
      expect(result?.text).toContain("I can't create, confirm, update, or delete alerts");
      expect(result?.text).not.toContain("MU");
      expect(result?.text).not.toContain("680");
    });
  });

  it("falls through to generic onboarding when there is no actionable stock intent", async () => {
    await withTmpState(async (stateDir) => {
      const result = await __testing.handleStockAlertDispatch(
        {
          channel: "discord",
          content: "who are you?",
          sessionKey: "agent:gesahni-discord-dm:discord:direct:1309247958029701190",
          senderId: "1309247958029701190",
          isGroup: false,
        },
        {
          conversationId: "user:1309247958029701190",
          sessionKey: "agent:gesahni-discord-dm:discord:direct:1309247958029701190",
          senderId: "1309247958029701190",
        },
        {
          pluginConfig: {},
          stateDir,
          marketDataClient: createMarketDataClient(),
        },
      );

      expect(result).toBeUndefined();
    });
  });

  it("deletes owned alerts", async () => {
    await withTmpState(async (stateDir) => {
      const alertCommand = __testing.createAlertCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });
      const alertsCommand = __testing.createAlertsCommand({
        pluginConfig: {},
        stateDir,
        marketDataClient: createMarketDataClient(),
      });

      const preview = await alertCommand.handler(createContext("group AAPL above 210"));
      const id = /Alert id: (alrt_[^\s]+)/.exec(preview.text ?? "")?.[1];
      await alertCommand.handler(createContext(`confirm ${id}`));

      const deleted = await alertCommand.handler(createContext(`delete ${id}`));
      const listed = await alertsCommand.handler(createContext("group"));

      expect(deleted.text).toBe("Alert deleted: AAPL.");
      expect(listed.text).toBe("No group alerts are active.");
    });
  });

  it("triggers active alerts once until the condition resets", async () => {
    await withTmpState(async (stateDir) => {
      const store = createAlertStore(stateDir);
      const alert = parseAlertRequest({
        input: "group AAPL above 210 at 205",
        config: {},
        channel: "discord",
        senderId: "1309247958029701190",
        currentDiscordChannelId: "1498120236770267187",
      });
      expect(alert).toBeTruthy();
      const preview = await store.preview(alert!);
      await store.confirm(preview.id, "1309247958029701190");
      const deliver = vi.fn<AlertDelivery>(async () => {});

      const first = await runAlertCheck({
        cfg: {},
        store,
        marketData: createMarketDataClient(),
        deliver,
        marketHoursOpen: true,
        now: new Date("2026-05-06T15:00:00Z"),
      });
      const second = await runAlertCheck({
        cfg: {},
        store,
        marketData: createMarketDataClient(),
        deliver,
        marketHoursOpen: true,
        now: new Date("2026-05-06T15:01:00Z"),
      });

      expect(first).toMatchObject({ checked: 1, triggered: 1, errors: 0 });
      expect(second).toMatchObject({ checked: 1, triggered: 0, errors: 0 });
      expect(deliver).toHaveBeenCalledTimes(1);
      const firstDelivery = deliver.mock.calls[0]?.[0];
      if (!firstDelivery) {
        throw new Error("Expected one stock alert delivery");
      }
      expect(firstDelivery.text).toContain("Stock alert: AAPL is above 210.00.");
      expect(firstDelivery.text).toContain("Entry reference: 205.00");
    });
  });

  it("skips alert checks outside regular market hours", async () => {
    await withTmpState(async (stateDir) => {
      const store = createAlertStore(stateDir);
      const alert = parseAlertRequest({
        input: "group AAPL above 210",
        config: {},
        channel: "discord",
        senderId: "1309247958029701190",
        currentDiscordChannelId: "1498120236770267187",
      });
      const preview = await store.preview(alert!);
      await store.confirm(preview.id, "1309247958029701190");
      const deliver = vi.fn(async () => {});

      const result = await runAlertCheck({
        cfg: {},
        store,
        marketData: createMarketDataClient(),
        deliver,
        marketHoursOpen: false,
      });

      expect(result).toEqual({ checked: 0, triggered: 0, skipped: 1, errors: 0 });
      expect(deliver).not.toHaveBeenCalled();
    });
  });
});

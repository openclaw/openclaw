import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ElementHandle, Page } from "playwright";
import { buildWidgetDocument } from "../../src/canvas/wrap.ts";
import type { ConfigSchemaResponse, CronJob, GatewaySessionRow } from "../../ui/src/api/types.ts";
import { pathForAgentPanel, pathForRoute } from "../../ui/src/app-route-paths.ts";
import { createSkill } from "../../ui/src/pages/skills/view.test-support.ts";
import type {
  MockGatewayControls,
  MockGatewayWindow,
} from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { clickBoardWidgetControl } from "../../ui/src/test-helpers/control-ui-e2e-widget.ts";
import {
  controlUiSessionPath,
  defaultControlUiFeatureMethods,
  type ControlUiMockGatewayScenario,
  waitForControlUiRoute,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import type { ProjectionFamily } from "../../ui/src/test-helpers/control-ui-projection-fixture-contract.ts";
import { mcpResourceHtml } from "../../ui/src/test-helpers/control-ui-team-scale-widget-html.ts";
import { cronListResponseFixture } from "../../ui/src/test-helpers/cron.ts";
import { meetingStatus } from "../../ui/src/test-helpers/transcripts.test-support.ts";
import {
  browserResourceMethodResponses,
  createBrowserResourceScenarios,
} from "./control-ui-browser-resource-scenarios.ts";
import { dataActivityLiveScenarios } from "./control-ui-data-activity-live-scenarios.ts";
import { dataActivityScenarios } from "./control-ui-data-activity-scenarios.ts";
import { dataBoardScenarios } from "./control-ui-data-board-scenarios.ts";
import { dataCatalogScenarios } from "./control-ui-data-catalog-scenarios.ts";
import { dataLogScenarios } from "./control-ui-data-log-scenarios.ts";
import { dataUsageDetailScenarios } from "./control-ui-data-usage-detail-scenarios.ts";
import { dataUsageScenarios } from "./control-ui-data-usage-scenarios.ts";
import { heavyContentScenarios } from "./control-ui-heavy-content-scenarios.ts";
import {
  frames,
  navigation,
  openInteractionPanel,
  openNavigationDrawer,
  prepareChat,
} from "./control-ui-interaction-navigation.ts";
import { runProjectionFixture } from "./control-ui-projection-fixtures.ts";
import type { ControlUiResourceCounts } from "./control-ui-resource-counts.ts";
import {
  exerciseWorkboardResourceFixture,
  idleWorkboardResourceFixture,
  prepareWorkboardResourceFixture,
  runWorkboardEventsCpu,
  runWorkboardRemountCpu,
  workboardResourceRoute,
} from "./control-ui-workboard-resource-fixture.ts";

const sessionKeys = ["agent:main:interaction-a", "agent:main:interaction-b"] as const;
const sessionQuery = "Interaction 0999";
const modelQuery = "Warm model 0999";
const cronQuery = "Warm automation 0499";
const activePane = ".chat-pane-cache__pane--active";
const sidebarClocks = ".sidebar-recent-session openclaw-elapsed-time";
const initialClockLabels = new WeakMap<Page, string>();
const progressClockSessions = Array.from(
  { length: 6 },
  (_, index) => sessionKeys[index] ?? `agent:main:interaction-${index}`,
);
const progressClocks =
  'openclaw-session-progress-widget [data-progress-card-placement="board"] time';
const initialProgressClocks = new WeakMap<Page, { count: number; labels: string[] }>();
const graphStreamingRuns = new WeakMap<Page, string>();

const nativeBoardSessions = Array.from(
  { length: 6 },
  (_, index) => sessionKeys[index] ?? `agent:main:interaction-${index}`,
);
const boardFrameSelector = `${activePane} .board-widget__frame`;
const canvasFrameSelector = "iframe.chat-tool-card__preview-frame";
const retainedFrames = new WeakMap<Page, ElementHandle<HTMLElement | SVGElement>>();
const canvasDocId = "cv_resource_retention";
const canvasDocumentUrl = `/__openclaw__/canvas/documents/${canvasDocId}/index.html`;
const canvasRunId = "resource-retention-run";
const mcpResourceCount = 3;
const retainedMcpFrames = new WeakMap<Page, Array<ElementHandle>>();

export type InteractionSandbox = { sandboxUrl: string; sandboxPort: number };
export type InteractionEvidence = Record<string, number | boolean>;
type InteractionSession = GatewaySessionRow &
  NonNullable<ControlUiMockGatewayScenario["sessions"]>[number];
export type InteractionFixtureOverrides = Omit<
  Partial<ControlUiMockGatewayScenario>,
  "sessions"
> & {
  sessions?: InteractionSession[];
};

type InteractionFixtureOptions = {
  workboardResources?: boolean;
  heavyContent?: boolean;
  runningSessions?: boolean;
  longSessionLabels?: boolean;
  longUserMessages?: boolean;
  nativeBoardResources?: boolean;
  progressCardClocks?: boolean;
  boardFrameResources?: boolean;
  canvasFrameRetention?: boolean;
  mcpAppResources?: boolean;
  browserResources?: boolean;
};

type TranscriptPlatformSnapshot = {
  fixtureMessages: number;
  mountedGroups: number;
  mountedMessageDisclosures: number;
  mountedFileDisclosures: number;
  documentVisibility: DocumentVisibilityState;
  viewportWidth: number;
  fontListeners?: number;
  fontCallbackCalls?: number;
  mediaCallbackCalls?: number;
};

export type InteractionScenario = {
  id: string;
  route: string;
  expected: string;
  /** Deliberately perturbs execution; exclude its timing from performance comparisons. */
  diagnostic?: string;
  /** Run only when its ID is explicitly named in --steps. */
  explicitOnly?: boolean;
  fixture?: InteractionFixtureOptions;
  /** Large-data campaigns replace only their domain's synthetic Gateway responses. */
  fixtureOverrides?: (
    sandbox: InteractionSandbox | undefined,
    base: ReturnType<typeof createInteractionFixture>,
  ) => InteractionFixtureOverrides;
  createRequestHandlers?: (
    defaults: Readonly<Record<string, (params: unknown) => unknown>>,
  ) => Record<string, (params: unknown) => unknown>;
  dataPage?: string;
  /** Resource campaigns opt into the longer inventory and idle scenarios. */
  resourceOnly?: boolean;
  /** Own one browser per observation; launch and retirement stay outside measurement. */
  observationBrowser?: boolean;
  visibility?: "hidden";
  projectionFamily?: ProjectionFamily;
  projectionIdle?: boolean;
  /** Count newly inserted rows across the action, including transient replacements. */
  rowSelector?: string;
  setup?: (page: Page) => Promise<void>;
  prepare: (page: Page, gateway: MockGatewayControls) => Promise<void>;
  run: (page: Page, gateway: MockGatewayControls) => Promise<void | InteractionEvidence>;
};

export function createScenarioFixture(
  buildId: string,
  version: string,
  scenario: InteractionScenario,
  sandbox?: InteractionSandbox,
): ControlUiMockGatewayScenario & { sessions: InteractionSession[] } {
  const base = createInteractionFixture(buildId, version, scenario.fixture, sandbox);
  const overrides = scenario.fixtureOverrides?.(sandbox, base);
  return {
    ...base,
    ...overrides,
    sessions: overrides?.sessions ?? base.sessions,
    featureMethods: overrides?.featureMethods
      ? [
          ...new Set([
            ...(base.featureMethods ?? defaultControlUiFeatureMethods),
            ...overrides.featureMethods,
          ]),
        ]
      : base.featureMethods,
    methodResponses: { ...base.methodResponses, ...overrides?.methodResponses },
  };
}

function resourceWidgetHtml(name: string) {
  return buildWidgetDocument(
    `Resource ${name}`,
    `<style>body{margin:0}main{height:300px;padding:16px;box-sizing:border-box}</style>
     <main><h2>Resource ${name}</h2>
     <button onclick="this.nextElementSibling.textContent=String(++window.clicks)">Count</button><output>0</output>
     <button onclick="document.querySelector('main').style.height='380px'">Grow</button></main>
     <script>window.clicks=0;</script>`,
  );
}

function canvasResourceMessages() {
  return [
    {
      role: "user",
      content: "Show the resource counter.",
      timestamp: 1_800_000_400_000,
      __openclaw: { id: "resource-prompt", seq: 398, idempotencyKey: `${canvasRunId}:user` },
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Preparing the resource counter." },
        { type: "toolCall", id: "resource-show", name: "show_widget", arguments: {} },
      ],
      timestamp: 1_800_000_400_001,
      __openclaw: { id: "resource-call", seq: 399, runId: canvasRunId },
    },
    {
      role: "toolResult",
      toolCallId: "resource-show",
      toolName: "show_widget",
      content: JSON.stringify({
        kind: "canvas",
        view: { backend: "canvas", id: canvasDocId, url: canvasDocumentUrl },
        presentation: {
          target: "assistant_message",
          title: "Resource counter",
          preferred_height: 300,
          sandbox: "scripts",
        },
      }),
      timestamp: 1_800_000_400_002,
      __openclaw: { id: "resource-result", seq: 400, runId: canvasRunId },
    },
  ];
}

function canvasResourceTranscript() {
  return [
    ...Array.from({ length: 397 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `Transcript 0 message ${index}. Synthetic resource fixture.`,
      timestamp: 1_800_000_000_000 + index * 1_000,
      __openclaw: { id: `resource-history-${index}`, seq: index + 1 },
    })),
    ...canvasResourceMessages(),
  ];
}

function nativeBoardResponses(updatedAt: number) {
  return {
    cases: [
      ...nativeBoardSessions.map((sessionKey, index) => ({
        match: { sessionKey },
        response: {
          card: {
            sessionKey,
            revision: 1,
            updatedAt,
            markdown: `**Verification ${index + 1}**: review the synthetic deployment.`,
            steps: [
              { step: "Inspect the change", status: "completed" },
              { step: "Check the verification record", status: "in_progress" },
            ],
          },
        },
      })),
      { response: { card: null } },
    ],
  };
}

function progressClockResponses(updatedAt: number, revision = 1) {
  return {
    cases: [
      ...progressClockSessions.map((sessionKey, index) => ({
        match: { sessionKey },
        response: {
          card: {
            sessionKey,
            revision,
            updatedAt,
            markdown: `**Verification ${index + 1}**: review the synthetic deployment.`,
            steps: [
              { step: "Inspect the change", status: "completed" },
              { step: "Check the verification record", status: "in_progress" },
            ],
          },
        },
      })),
      { response: { card: null } },
    ],
  };
}

function createInteractionConfig() {
  return {
    transcripts: {
      enabled: true,
      autoStart: ["Alpha", "Beta"].map((title) => ({
        providerId: "test-voice",
        guildId: "guild",
        channelId: title.toLowerCase(),
        title,
      })),
    },
  };
}

function createInteractionModels() {
  return Array.from({ length: 1_000 }, (_, index) => ({
    id: `model-${index}`,
    name: `Warm model ${String(index).padStart(4, "0")}`,
    provider: "example",
    contextWindow: 128_000,
  }));
}

export function createInteractionFixture(
  buildId: string,
  version: string,
  options: InteractionFixtureOptions = {},
  sandbox?: InteractionSandbox,
) {
  if (
    (options.boardFrameResources || options.canvasFrameRetention || options.mcpAppResources) &&
    !sandbox
  ) {
    throw new Error("Frame resource fixtures require the native sandbox descriptor");
  }
  const config = createInteractionConfig();
  const captureSources = config.transcripts.autoStart;
  const keyForIndex = (index: number) => sessionKeys[index] ?? `agent:main:interaction-${index}`;
  const startedAt = options.runningSessions ? Date.now() - 5_000 : undefined;
  const sessions = Array.from({ length: 1_000 }, (_, index) => {
    const runningChild = options.runningSessions && index > 0 && index <= 200;
    return {
      key: keyForIndex(index),
      sessionId: `interaction-session-${index}`,
      agentId: "main",
      kind: "direct" as const,
      label:
        `Interaction ${String(index).padStart(4, "0")}` +
        (options.longSessionLabels
          ? " — investigate the synthetic deployment and review the complete verification record"
          : ""),
      updatedAt: 1_800_000_000_000 - index * 1_000,
      childOwnerSessionKeys: runningChild ? [sessionKeys[0]] : [],
      ...(options.canvasFrameRetention && index === 0
        ? { hasActiveRun: true, activeRunIds: [canvasRunId], startedAt: 1_800_000_400_000 }
        : {}),
      ...(options.runningSessions && index === 0
        ? {
            childSessions: Array.from({ length: 200 }, (_childValue, child) =>
              keyForIndex(child + 1),
            ),
          }
        : {}),
      ...(runningChild
        ? {
            startedAt,
            hasActiveRun: true,
            activeRunIds: [`interaction-run-${index}`],
            status: "running" as const,
            spawnedBy: sessionKeys[0],
            parentSessionKey: sessionKeys[0],
          }
        : {}),
    };
  });
  const jobs: CronJob[] = Array.from({ length: 500 }, (_, index) => ({
    id: `interaction-job-${index}`,
    name: `Warm automation ${String(index).padStart(4, "0")}`,
    enabled: true,
    createdAtMs: 1_800_000_000_000,
    updatedAtMs: 1_800_000_000_000,
    schedule: { kind: "every", everyMs: 3_600_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Synthetic interaction benchmark reminder." },
    state: {},
  }));
  const cronPage = (rows: CronJob[], offset: number) => ({
    jobs: rows.slice(offset, offset + 50),
    snapshotRevision: "interaction-cron-inventory",
    total: rows.length,
    offset,
    limit: 50,
    hasMore: offset + 50 < rows.length,
    nextOffset: offset + 50 < rows.length ? offset + 50 : null,
  });
  const cronCases = Array.from({ length: cronQuery.length }, (_, index) => {
    const query = cronQuery.slice(0, index + 1);
    return {
      match: { query },
      response: cronPage(
        jobs.filter((job) => job.name.includes(query)),
        0,
      ),
    };
  });
  return {
    serverBuildId: buildId,
    serverVersion: version,
    sessionKey: sessionKeys[0],
    ...(options.nativeBoardResources ||
    options.progressCardClocks ||
    options.boardFrameResources ||
    options.mcpAppResources ||
    options.browserResources
      ? {
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "board.get",
            ...(options.nativeBoardResources ||
            options.progressCardClocks ||
            options.boardFrameResources
              ? ["progressCard.get", "sessions.list"]
              : []),
            ...(options.mcpAppResources ? ["board.widget.appView", "mcp.app.view"] : []),
            ...(options.browserResources ? ["browser.dashboard.request"] : []),
          ],
          ...(options.nativeBoardResources || options.progressCardClocks || options.browserResources
            ? {
                controlUiWidgetKinds: [
                  ...(options.nativeBoardResources || options.progressCardClocks
                    ? [{ pluginId: "session", kind: "session:progress", label: "Session progress" }]
                    : []),
                  ...(options.browserResources
                    ? [{ pluginId: "browser", kind: "browser:dashboard", label: "Browser" }]
                    : []),
                ],
              }
            : {}),
        }
      : {}),
    ...(options.canvasFrameRetention
      ? {
          historyMessages: canvasResourceTranscript(),
          inFlightRun: { runId: canvasRunId, text: "", startedAt: 1_800_000_400_000 },
        }
      : {}),
    agentModel: "example/model-0",
    sessions,
    sessionTranscripts: Object.fromEntries(
      sessionKeys
        .filter((key) => !options.canvasFrameRetention || key !== sessionKeys[0])
        .map((key) => [
          key,
          {
            messages: Array.from({ length: options.heavyContent ? 0 : 400 }, (_, index) => ({
              role: index % 2 === 0 ? "user" : "assistant",
              content: `Transcript ${sessionKeys.indexOf(key)} message ${index}.\n${"Synthetic transcript detail.\n".repeat(
                options.longUserMessages && index % 2 === 0 ? 80 : 4,
              )}`,
              timestamp: 1_800_000_000_000 + index * 1_000,
              __openclaw: {
                id: `interaction-${sessionKeys.indexOf(key)}-${index}`,
                seq: index + 1,
              },
            })),
          },
        ]),
    ),
    models: createInteractionModels(),
    methodResponses: {
      ...(options.browserResources ? browserResourceMethodResponses() : {}),
      ...(options.mcpAppResources
        ? {
            "board.get": {
              sessionKey: sessionKeys[0],
              revision: 1,
              tabs: [{ tabId: "main", title: "Apps", position: 0, chatDock: "right" }],
              widgets: Array.from({ length: mcpResourceCount }, (_, index) => ({
                name: `mcp-resource-${index}`,
                tabId: "main",
                title: `Resource App ${index + 1}`,
                contentKind: "mcp-app",
                sizeW: 4,
                sizeH: 3,
                position: index,
                grantState: "none",
                revision: 1,
                instanceId: `mcp-resource-${index}`,
              })),
            },
            "board.widget.appView": {
              cases: Array.from({ length: mcpResourceCount }, (_, index) => ({
                match: { name: `mcp-resource-${index}` },
                response: { viewId: `mcp-resource-${index}`, expiresAtMs: Date.now() + 1_200_000 },
              })),
            },
            "mcp.app.view": {
              ...sandbox,
              html: mcpResourceHtml(),
              toolInput: {},
              toolResult: { content: [{ type: "text", text: "ready" }] },
              messageSupported: false,
              updateModelContextSupported: false,
            },
          }
        : {}),
      ...(options.canvasFrameRetention
        ? { "canvas.document.view": { ...sandbox, html: resourceWidgetHtml("counter") } }
        : {}),
      ...(options.boardFrameResources
        ? {
            "board.get": {
              sessionKey: sessionKeys[0],
              revision: 1,
              tabs: ["main", "second"].map((tabId, position) => ({
                tabId,
                title: `Resource ${tabId}`,
                position,
                chatDock: "right",
              })),
              widgets: ["main", "second"].flatMap((tabId) =>
                Array.from({ length: 3 }, (_, index) => ({
                  name: `resource-${tabId}-${index}`,
                  tabId,
                  title: `Resource ${tabId}-${index}`,
                  contentKind: "html",
                  sizeW: 12,
                  sizeH: 6,
                  position: index,
                  grantState: "none",
                  revision: 1,
                  ...sandbox,
                  frameUrl: `/__openclaw__/board/${encodeURIComponent(sessionKeys[0])}/resource-${tabId}-${index}/index.html?bt=synthetic-resource-ticket`,
                  viewTicket: "synthetic-resource-ticket",
                  viewTicketTtlMs: 1_200_000,
                  viewGeneration: "0123456789abcdef0123456789abcdef",
                })),
              ),
            },
          }
        : {}),
      "config.schema": {
        schema: { type: "object", properties: {} },
        uiHints: {},
        version: "interaction-config",
        generatedAt: "2026-10-23T00:00:00.000Z",
      } satisfies ConfigSchemaResponse,
      "progressCard.get": options.progressCardClocks
        ? progressClockResponses(Date.now() - 45_000)
        : options.nativeBoardResources
          ? nativeBoardResponses(Date.now() - 45_000)
          : { card: null },
      ...(options.nativeBoardResources || options.progressCardClocks
        ? {
            "board.get": {
              sessionKey: sessionKeys[0],
              revision: 1,
              tabs: [{ tabId: "main", title: "Verification", position: 0, chatDock: "right" }],
              widgets: (options.progressCardClocks
                ? progressClockSessions
                : nativeBoardSessions
              ).map((sessionKey, index) => ({
                name: `verification-progress-${index}`,
                tabId: "main",
                title: `Verification ${index + 1}`,
                contentKind: "plugin",
                pluginKind: "session:progress",
                props: { sessionKey },
                sizeW: 4,
                sizeH: 3,
                position: index,
                grantState: "none",
                revision: 1,
              })),
            },
          }
        : {}),
      "config.get": {
        config,
        sourceConfig: config,
        hash: "interaction-config",
        raw: JSON.stringify(config),
        valid: true,
        issues: [],
      },
      "transcripts.status": {
        ...meetingStatus,
        configuredSources: captureSources.map((source) =>
          Object.assign({}, meetingStatus.configuredSources[0], { source, title: source.title }),
        ),
      },
      "skills.status": {
        workspaceDir: "/synthetic/workspace",
        managedSkillsDir: "/synthetic/skills",
        skills: ["Alpha", "Beta"].map((name) =>
          createSkill({
            name,
            skillKey: name.toLowerCase(),
            primaryEnv: undefined,
            missing: { bins: ["synthetic-bin"], anyBins: [], env: [], config: [], os: [] },
            blockedByAgentFilter: true,
          }),
        ),
      },
      "sessions.storage.status": {
        agents: ["main", "research"].map((agentId) => ({
          agentId,
          storePath: `/synthetic/${agentId}.sqlite`,
          hotTranscripts: 7,
          coldTranscripts: 0,
          databaseBytes: 4096,
          walBytes: 0,
          archiveBytes: 0,
          embeddedArchiveBytes: 0,
        })),
        maintenance: {
          running: false,
          lastStartedAt: null,
          lastCompletedAt: null,
          lastError: null,
          archivedTranscripts: 0,
          externalizedTranscripts: 0,
        },
      },
      "models.authStatus": {
        ts: 1_800_000_000_000,
        providers: [{ provider: "openai", displayName: "OpenAI", status: "ok", profiles: [] }],
      },
      "usage.status": {
        updatedAt: 1_800_000_000_000,
        providers: [
          {
            provider: "openai",
            displayName: "OpenAI",
            windows: [
              { label: "5h", usedPercent: 25 },
              { label: "Weekly", usedPercent: 40 },
            ],
            billing: [{ type: "balance", amount: 12, unit: "credits" }],
          },
        ],
      },
      "cron.list": cronListResponseFixture([
        ...cronCases,
        ...Array.from({ length: 10 }, (_, index) => ({
          match: { offset: index * 50 },
          response: cronPage(jobs, index * 50),
        })),
        { response: cronPage(jobs, 0) },
      ]),
      "cron.status": { enabled: true, jobs: jobs.length, nextWakeAtMs: null },
      "cron.runs": {
        entries: [],
        total: 0,
        offset: 0,
        limit: 50,
        hasMore: false,
        nextOffset: null,
      },
    },
  } satisfies ControlUiMockGatewayScenario;
}

async function switchSession(page: Page, index: 0 | 1) {
  await navigation(page, "sessions");
  await page
    .locator(
      `.sidebar-recent-session[data-session-key="${sessionKeys[index]}"] .sidebar-recent-session__link`,
    )
    .click();
  await page
    .locator(activePane)
    .getByText(`Transcript ${index} message 399.`, { exact: false })
    .waitFor();
  await frames(page);
}

function mcpResourceFrame(page: Page, index: number) {
  return page.locator(
    `${activePane} [data-widget-name="mcp-resource-${index}"] mcp-app-view iframe`,
  );
}

async function waitForMcpResourceContexts(page: Page) {
  for (let index = 0; index < mcpResourceCount; index++) {
    const frame = mcpResourceFrame(page, index);
    const deadline = Date.now() + 30_000;
    let matched: boolean;
    do {
      // Board layout keeps settling after a viewport change; sample both sides on every poll.
      const dimensions = await frame.locator("..").evaluate((mount) => {
        const bounds = mount.getBoundingClientRect();
        return {
          width: Math.max(1, Math.round(bounds.width)),
          height: Math.max(0, Math.round(bounds.height)),
        };
      });
      const reported = await frame
        .contentFrame()
        .frameLocator("iframe")
        .locator("html")
        .evaluate((root) => ({
          width: Number(root.dataset.hostWidth),
          height: Number(root.dataset.hostHeight),
        }));
      matched = reported.width === dimensions.width && reported.height === dimensions.height;
      if (!matched) {
        await frames(page);
      }
    } while (!matched && Date.now() < deadline);
    if (!matched) {
      throw new Error(`MCP App ${index} did not receive its current container dimensions`);
    }
  }
}

async function prepareMcpResources(page: Page) {
  await openInteractionPanel(page);
  for (let index = 0; index < mcpResourceCount; index++) {
    const inner = mcpResourceFrame(page, index).contentFrame().frameLocator("iframe");
    await clickBoardWidgetControl(page, inner.getByRole("button", { name: "Count", exact: true }));
    await inner.getByText("1", { exact: true }).waitFor();
  }
  await settleSidebarBackgroundWork(page);
  await waitForMcpResourceContexts(page);
  const appFrameHandles = await page.locator(`${activePane} mcp-app-view iframe`).elementHandles();
  if (appFrameHandles.length !== mcpResourceCount) {
    throw new Error("MCP resource fixture requires three initialized App frames");
  }
  retainedMcpFrames.set(page, appFrameHandles);
}

async function resizeMcpResources(
  page: Page,
  gateway: MockGatewayControls,
): Promise<InteractionEvidence> {
  const viewport = page.viewportSize()!;
  const retained = retainedMcpFrames.get(page)!;
  try {
    await page.setViewportSize({ width: viewport.width + 96, height: viewport.height + 64 });
    await waitForMcpResourceContexts(page);
    for (let index = 0; index < mcpResourceCount; index++) {
      const frame = mcpResourceFrame(page, index);
      if (!(await frame.evaluate((current, original) => current === original, retained[index]!))) {
        throw new Error("Container resize replaced an MCP App frame");
      }
      const inner = frame.contentFrame().frameLocator("iframe");
      if ((await inner.locator("output").textContent()) !== "1") {
        throw new Error("Container resize discarded MCP App state");
      }
    }
    const reads = (await gateway.getRequests("mcp.app.view")).length;
    if (reads !== mcpResourceCount) {
      throw new Error("Container resize reloaded an MCP App view");
    }
    return { initializedViews: mcpResourceCount, retained: true, viewReads: reads };
  } finally {
    try {
      await page.setViewportSize(viewport);
      await waitForMcpResourceContexts(page);
    } finally {
      await Promise.all(retained.map((frame) => frame.dispose()));
      retainedMcpFrames.delete(page);
    }
  }
}

async function prepareNativeBoard(page: Page, gateway: MockGatewayControls) {
  await openInteractionPanel(page);
  await gateway.waitForRequest("board.get", { match: { sessionKey: sessionKeys[0] } });
  await page.waitForFunction((expected) => {
    const widgets = [
      ...document.querySelectorAll<HTMLElement & { active: boolean }>(
        "openclaw-session-progress-widget",
      ),
    ];
    return (
      widgets.length === expected &&
      widgets.every(
        (widget) =>
          widget.active &&
          !widget.querySelector(
            '.board-widget__plugin-loading, [data-test-id="session-progress-error"]',
          ),
      )
    );
  }, nativeBoardSessions.length);
  await settleSidebarBackgroundWork(page);
}

async function installResourceBoardDocuments(page: Page) {
  await page.route("**/__openclaw__/board/**", async (route) => {
    const name = new URL(route.request().url()).pathname.match(
      /\/resource-(main-[0-2]|second-[0-2])\/index\.html$/u,
    )?.[1];
    if (!name) {
      await route.continue();
      return;
    }
    await route.fulfill({ contentType: "text/html", body: resourceWidgetHtml(name) });
  });
}

function resourceBoardFrame(page: Page, name: string) {
  return page.locator(`${activePane} [data-widget-name="resource-${name}"] .board-widget__frame`);
}

async function waitForResourceBoardTab(page: Page, tab: "main" | "second") {
  for (let index = 0; index < 3; index++) {
    const frame = resourceBoardFrame(page, `${tab}-${index}`);
    await frame
      .contentFrame()
      .frameLocator("iframe")
      .getByRole("heading", { name: `Resource ${tab}-${index}`, exact: true })
      .waitFor();
    await page.waitForFunction((name) => {
      const iframeElement = document.querySelector<HTMLIFrameElement>(
        `[data-widget-name="resource-${name}"] .board-widget__frame`,
      );
      return (
        iframeElement && !iframeElement.inert && getComputedStyle(iframeElement).opacity === "1"
      );
    }, `${tab}-${index}`);
  }
}

async function selectResourceBoardTab(page: Page, tab: "main" | "second") {
  await page.locator(`${activePane} [data-board-tab-id="${tab}"]`).click();
  await waitForResourceBoardTab(page, tab);
}

async function prepareResourceBoard(page: Page) {
  await openInteractionPanel(page);
  await waitForResourceBoardTab(page, "main");
  const first = resourceBoardFrame(page, "main-0");
  await clickBoardWidgetControl(
    page,
    first.contentFrame().frameLocator("iframe").getByRole("button", { name: "Count", exact: true }),
  );
  await selectResourceBoardTab(page, "second");
  await selectResourceBoardTab(page, "main");
  const retained = await first.elementHandle();
  if (!retained) {
    throw new Error("The first board frame did not survive its initial tab round trip");
  }
  retainedFrames.set(page, retained);
  await assertResourceBoardInventory(page);
  await settleSidebarBackgroundWork(page);
}

async function assertResourceBoardInventory(page: Page) {
  const counts = await page.locator(boardFrameSelector).evaluateAll((resourceFrames) => ({
    mounted: resourceFrames.length,
    parked: resourceFrames.filter((resourceFrame) => resourceFrame.closest("[hidden][inert]"))
      .length,
  }));
  if (counts.mounted !== 6 || counts.parked !== 3) {
    throw new Error(
      `Expected six retained board frames, three parked; got ${JSON.stringify(counts)}`,
    );
  }
  return counts;
}

async function exerciseResourceBoard(page: Page): Promise<InteractionEvidence> {
  const first = resourceBoardFrame(page, "main-0");
  const inner = first.contentFrame().frameLocator("iframe");
  const sizes = () =>
    page
      .locator(`${activePane} [data-widget-name^="resource-main-"]`)
      .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().height));
  const before = await sizes();
  await clickBoardWidgetControl(page, inner.getByRole("button", { name: "Grow", exact: true }));
  await page.waitForFunction((height) => {
    const cell = document.querySelector('[data-widget-name="resource-main-0"]');
    return cell && cell.getBoundingClientRect().height > height + 32;
  }, before[0]!);
  const after = await sizes();
  if (after.slice(1).some((height, index) => Math.abs(height - before[index + 1]!) > 1)) {
    throw new Error("Resizing one sandbox changed a sibling board widget's height");
  }
  const board = page.locator(`${activePane} openclaw-board-view`);
  await board.evaluate((element) => {
    element.scrollTop = 0;
  });
  await inner.getByRole("heading", { name: "Resource main-0", exact: true }).hover();
  const scrollBefore = await board.evaluate((element) => element.scrollTop);
  await page.mouse.wheel(0, 120);
  await page.waitForFunction((previousScrollTop) => {
    const boardElement = document.querySelector(
      ".chat-pane-cache__pane--active openclaw-board-view",
    );
    return boardElement && boardElement.scrollTop > previousScrollTop;
  }, scrollBefore);
  await selectResourceBoardTab(page, "second");
  await selectResourceBoardTab(page, "main");
  const retained = retainedFrames.get(page)!;
  try {
    if (!(await first.evaluate((frame, original) => frame === original, retained))) {
      throw new Error("Board tab switching replaced the sandbox frame");
    }
    if ((await inner.locator("output").textContent()) !== "1") {
      throw new Error("Board tab switching discarded the counter state");
    }
    const counts = await assertResourceBoardInventory(page);
    await settleSidebarCapture(page);
    return { mountedFrames: counts.mounted, parkedFrames: counts.parked, retained: true };
  } finally {
    await retained.dispose();
    retainedFrames.delete(page);
  }
}

async function prepareCanvasRetention(page: Page, gateway: MockGatewayControls) {
  await page.getByRole("button", { name: "Stop generating", exact: true }).waitFor();
  const frame = page.locator(`${activePane} ${canvasFrameSelector}`);
  const inner = frame.contentFrame().frameLocator("iframe");
  await clickBoardWidgetControl(page, inner.getByRole("button", { name: "Count", exact: true }));
  await inner.getByText("1", { exact: true }).waitFor();
  const retained = await frame.elementHandle();
  if (!retained || (await gateway.getRequests("canvas.document.view")).length !== 1) {
    throw new Error("Canvas must begin with one loaded interactive frame and one view read");
  }
  retainedFrames.set(page, retained);
  await settleSidebarBackgroundWork(page);
}

async function finishCanvasRetention(
  page: Page,
  gateway: MockGatewayControls,
): Promise<InteractionEvidence> {
  const retained = retainedFrames.get(page)!;
  const probe = await retained.evaluateHandle((frame) => {
    const state = { maxConnected: 1, sawParked: false, lastParkedAt: 0, longestParkMs: 0 };
    const sample = () => {
      state.maxConnected = Math.max(
        state.maxConnected,
        document.querySelectorAll("iframe.chat-tool-card__preview-frame").length,
      );
      const parked = frame.isConnected && !frame.closest(".chat-thread");
      if (parked && !state.lastParkedAt) {
        state.sawParked = true;
        state.lastParkedAt = performance.now();
      } else if (!parked && state.lastParkedAt) {
        state.longestParkMs = Math.max(state.longestParkMs, performance.now() - state.lastParkedAt);
        state.lastParkedAt = 0;
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true });
    let observing = true;
    return {
      state,
      stop: () => {
        if (observing) {
          observing = false;
          sample();
          observer.disconnect();
        }
      },
    };
  });
  try {
    const finalText = "The resource counter is ready.";
    const finalMessage = {
      role: "assistant",
      idempotencyKey: canvasRunId,
      stopReason: "stop",
      content: [
        {
          type: "text",
          text: `[embed](${canvasDocumentUrl})\n\n${finalText}\n\n${"Resource detail.\n\n".repeat(12)}`,
        },
        {
          type: "canvas",
          preview: {
            kind: "canvas",
            surface: "assistant_message",
            render: "url",
            viewId: canvasDocId,
            url: canvasDocumentUrl,
            title: "Resource counter",
            sandbox: "scripts",
            preferredHeight: 300,
          },
        },
      ],
      timestamp: 1_800_000_400_003,
      __openclaw: { id: "resource-final", seq: 401, runId: canvasRunId, runTerminal: true },
    };
    await gateway.setHistoryMessages([...canvasResourceTranscript(), finalMessage]);
    await page.evaluate(
      ({ sessionKey, runId, finalMessage: terminalMessage }) => {
        const mockGateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
        // Deliver the normal lifecycle batch together, within the existing one-second parking lease.
        mockGateway.emit("session.message", {
          sessionKey,
          runId,
          message: terminalMessage,
          messageId: "resource-final",
          messageSeq: 401,
          session: {
            key: sessionKey,
            hasActiveRun: true,
            activeRunIds: [runId],
            status: "running",
          },
          hasActiveRun: true,
          activeRunIds: [runId],
        });
        mockGateway.emit("chat", {
          sessionKey,
          runId,
          seq: 1,
          state: "final",
          message: terminalMessage,
        });
        mockGateway.emit("sessions.changed", {
          sessionKey,
          reason: "lifecycle",
          session: {
            key: sessionKey,
            hasActiveRun: false,
            activeRunIds: [],
            lastRunId: runId,
            status: "done",
            updatedAt: 1_800_000_400_003,
          },
        });
      },
      { sessionKey: sessionKeys[0], runId: canvasRunId, finalMessage },
    );
    const reply = page.locator('.chat-bubble[data-entry-id="resource-final"]');
    await reply.getByText(finalText, { exact: true }).waitFor();
    await reply.locator("openclaw-canvas-widget-view").waitFor();
    const frame = reply.locator(canvasFrameSelector);
    if (!(await frame.evaluate((currentFrame, original) => currentFrame === original, retained))) {
      throw new Error("The live Canvas frame was replaced in the final reply");
    }
    if (
      (await frame.contentFrame().frameLocator("iframe").locator("output").textContent()) !== "1"
    ) {
      throw new Error("Canvas handoff discarded the interactive counter state");
    }
    await frames(page);
    await probe.evaluate(({ stop }) => stop());
    const observed = await probe.evaluate(({ state }) => state);
    const reads = (await gateway.getRequests("canvas.document.view")).length;
    if (
      reads !== 1 ||
      observed.maxConnected !== 1 ||
      (await page.locator(canvasFrameSelector).count()) !== 1
    ) {
      throw new Error("Canvas handoff duplicated its frame or reloaded its document");
    }
    return {
      mountedFrames: 1,
      parkedFramesMax: Number(observed.sawParked),
      longestParkMs: observed.longestParkMs,
      viewReads: reads,
      retained: true,
    };
  } finally {
    await probe.evaluate(({ stop }) => stop());
    await probe.dispose();
    await retained.dispose();
    retainedFrames.delete(page);
  }
}

async function idleResourceFrames(
  page: Page,
  gateway: MockGatewayControls,
  kind: "board" | "canvas",
  visibility: "visible" | "hidden",
): Promise<InteractionEvidence> {
  const retained = retainedFrames.get(page)!;
  try {
    if ((await page.evaluate(() => document.visibilityState)) !== visibility) {
      throw new Error(`Expected a ${visibility} document before ${kind} idle`);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 3_000);
    });
    if ((await page.evaluate(() => document.visibilityState)) !== visibility) {
      throw new Error(`${kind} idle changed document visibility`);
    }
    const frame =
      kind === "board"
        ? resourceBoardFrame(page, "main-0")
        : page.locator(`${activePane} ${canvasFrameSelector}`);
    if (!(await frame.evaluate((currentFrame, original) => currentFrame === original, retained))) {
      throw new Error(`${kind} idle replaced its retained frame`);
    }
    if (
      (await frame.contentFrame().frameLocator("iframe").locator("output").textContent()) !== "1"
    ) {
      throw new Error(`${kind} idle discarded interactive counter state`);
    }
    if (kind === "board") {
      const counts = await assertResourceBoardInventory(page);
      return {
        mountedFrames: counts.mounted,
        parkedFrames: counts.parked,
        retained: true,
        idleMs: 3_000,
      };
    }
    const viewReads = (await gateway.getRequests("canvas.document.view")).length;
    if (viewReads !== 1 || (await page.locator(canvasFrameSelector).count()) !== 1) {
      throw new Error("Canvas idle duplicated its frame or reread its document");
    }
    return { mountedFrames: 1, viewReads, retained: true, idleMs: 3_000 };
  } finally {
    await retained.dispose();
    retainedFrames.delete(page);
  }
}

async function preparePlatformTranscript(page: Page) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await prepareChat(page);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.locator(`${activePane} .chat-message-disclosure__content`).first().waitFor({
    state: "attached",
  });
  await settleSidebarBackgroundWork(page);
}

async function platformTranscriptSnapshot(page: Page): Promise<TranscriptPlatformSnapshot> {
  return page.evaluate((selector) => {
    const pane = document.querySelector(selector);
    if (!pane) {
      throw new Error("Platform transcript has no active pane");
    }
    // The existing native-resource probe is absent during instrumentation-off CPU pairs.
    const reader: unknown = Reflect.get(window, "openclawResourceCounts");
    const resources =
      typeof reader === "function" ? (reader() as ControlUiResourceCounts) : undefined;
    return {
      fixtureMessages: 400,
      mountedGroups: pane.querySelectorAll("[data-chat-row-key]").length,
      mountedMessageDisclosures: pane.querySelectorAll(".chat-message-disclosure__content").length,
      mountedFileDisclosures: pane.querySelectorAll(
        "div.workspace-desktop__disclosure, div.session-diff__disclosure",
      ).length,
      documentVisibility: document.visibilityState,
      viewportWidth: innerWidth,
      fontListeners: resources?.listeners.fontFaceSet,
      fontCallbackCalls: resources?.listenerCallbacks.fontFaceSet,
      mediaCallbackCalls: resources?.listenerCallbacks.mediaQuery,
    };
  }, activePane);
}

function platformTranscriptEvidence(
  phase: string,
  snapshot: TranscriptPlatformSnapshot,
): InteractionEvidence {
  const evidence: InteractionEvidence = {
    [`${phase}FixtureMessages`]: snapshot.fixtureMessages,
    [`${phase}MountedGroups`]: snapshot.mountedGroups,
    [`${phase}MountedMessageDisclosures`]: snapshot.mountedMessageDisclosures,
    [`${phase}MountedFileDisclosures`]: snapshot.mountedFileDisclosures,
    [`${phase}DocumentHidden`]: snapshot.documentVisibility === "hidden",
    [`${phase}ViewportWidth`]: snapshot.viewportWidth,
  };
  if (snapshot.fontListeners !== undefined) {
    evidence[`${phase}FontListeners`] = snapshot.fontListeners;
  }
  if (snapshot.fontCallbackCalls !== undefined) {
    evidence[`${phase}FontCallbackCalls`] = snapshot.fontCallbackCalls;
  }
  if (snapshot.mediaCallbackCalls !== undefined) {
    evidence[`${phase}MediaCallbackCalls`] = snapshot.mediaCallbackCalls;
  }
  return evidence;
}

async function runTranscriptPlatformEvents(page: Page): Promise<InteractionEvidence> {
  const before = await platformTranscriptSnapshot(page);
  if (before.mountedMessageDisclosures === 0) {
    throw new Error("Long-user fixture did not mount a message font-metric consumer");
  }
  const viewport = page.viewportSize()!;
  await page.setViewportSize({
    width: viewport.width > 768 ? 720 : 1024,
    height: viewport.height,
  });
  await frames(page);
  await page.setViewportSize(viewport);
  await frames(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await frames(page);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await frames(page);
  // This is a bounded synthetic notification on the actual FontFaceSet. It
  // exercises existing metric consumers without claiming a browser font download.
  for (let event = 0; event < 8; event++) {
    await page.evaluate(() => document.fonts.dispatchEvent(new Event("loadingdone")));
    await frames(page);
  }
  const afterPlatformEvents = await platformTranscriptSnapshot(page);
  const original = await page.evaluateHandle(
    (selector) => [...document.querySelectorAll(`${selector} .chat-message-disclosure__content`)],
    activePane,
  );
  try {
    const thread = page.locator(`${activePane} .chat-thread`);
    await thread.hover();
    await page.mouse.wheel(0, -(await thread.evaluate((element) => element.scrollHeight)));
    await thread.getByText("Transcript 0 message 0.", { exact: false }).waitFor();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.scrollTop === 0,
      `${activePane} .chat-thread`,
    );
    await frames(page);
    const retirement = await original.evaluate((nodes) => ({
      initialDisclosureNodes: nodes.length,
      initialDisclosureNodesStillConnected: nodes.filter((node) => node.isConnected).length,
    }));
    await page.evaluate(() => document.fonts.dispatchEvent(new Event("loadingdone")));
    await frames(page);
    return {
      syntheticFontNotifications: true,
      syntheticFontEvents: 9,
      nativeViewportChanges: 2,
      nativeReducedMotionChanges: 2,
      ...platformTranscriptEvidence("before", before),
      ...platformTranscriptEvidence("afterPlatformEvents", afterPlatformEvents),
      ...platformTranscriptEvidence("after", await platformTranscriptSnapshot(page)),
      ...retirement,
    };
  } finally {
    await original.dispose();
  }
}

async function prepareProgressClocks(page: Page, gateway: MockGatewayControls) {
  await prepareChat(page);
  const pane = page.locator(activePane);
  const mobileHeader = pane.locator(".agent-chat__header--mobile");
  const mobile = await mobileHeader.isVisible();
  const toggle = (mobile ? mobileHeader : pane.locator(".sidebar-region__panels-toggle")).getByRole(
    "button",
    { name: "Panels", exact: true },
  );
  if (mobile) {
    const host = pane.locator(".chat-mobile-host");
    if (!(await host.isVisible())) {
      await toggle.click();
    }
    await host.getByRole("button", { name: "Panels", exact: true }).click();
    await host
      .locator(".chat-panel-launcher-mobile")
      .getByRole("button", { name: "Dashboard", exact: true })
      .click();
  } else {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    await pane
      .locator(".side-panel-launcher")
      .getByRole("button")
      .filter({
        has: page
          .getByText("Dashboard", { exact: true })
          .and(page.locator(".side-panel-type-option__label")),
      })
      .click();
  }

  await gateway.waitForRequest("board.get", { match: { sessionKey: sessionKeys[0] } });
  await page.waitForFunction(
    ({ selector, expected }) => {
      const widgets = [
        ...document.querySelectorAll<HTMLElement & { active: boolean }>(
          "openclaw-session-progress-widget",
        ),
      ];
      return (
        widgets.length === expected &&
        widgets.every(
          (widget) =>
            widget.active &&
            !widget.querySelector(
              '.board-widget__plugin-loading, [data-test-id="session-progress-error"]',
            ),
        ) &&
        document.querySelectorAll(selector).length === expected
      );
    },
    { selector: progressClocks, expected: progressClockSessions.length },
  );
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width - 4, viewport.height - 4);
  await settleSidebarBackgroundWork(page);
  // Start each sample near a minute boundary without replacing the native clock.
  const updatedAt = Date.now() - 45_000;
  await gateway.setMethodResponse("progressCard.get", progressClockResponses(updatedAt, 2));
  for (const sessionKey of progressClockSessions) {
    await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 2 });
  }
  await page.waitForFunction(
    ({ selector, datetime }) => {
      const clocks = [...document.querySelectorAll(selector)];
      return (
        clocks.length >= 2 &&
        clocks.every(
          (clock) =>
            clock.getAttribute("datetime") === datetime &&
            clock.textContent?.trim() === "Updated just now",
        )
      );
    },
    { selector: progressClocks, datetime: new Date(updatedAt).toISOString() },
  );
  // The accepted progress refresh also updates the active chat's persisted snapshot.
  await settleSidebarBackgroundWork(page);
  const clocks = page.locator(progressClocks);
  initialProgressClocks.set(page, {
    count: await clocks.count(),
    labels: await clocks.allTextContents(),
  });
}

async function prepareSessionSwitch(page: Page) {
  await prepareChat(page);
  await switchSession(page, 1);
  await switchSession(page, 0);
}

async function prepareSidebarInventory(page: Page, gateway: MockGatewayControls) {
  await prepareChat(page);
  await navigation(page, "sessions");
  const more = page.locator(
    ".sidebar-session-pagination--roster > .sidebar-session-pagination__button",
  );
  for (const offset of [200, 400, 600, 800]) {
    await more.click();
    await gateway.waitForRequest("sessions.list", {
      match: { source: "sidebar", offset, limit: 200 },
    });
    await frames(page);
  }
  await more.waitFor({ state: "hidden" });
}

async function settleSidebarCapture(page: Page) {
  // Cross the snapshot owner's 500 ms debounce and idle turn, including oversized cache refusals.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (typeof requestIdleCallback === "function") {
            requestIdleCallback(() => resolve(), { timeout: 1000 });
          } else {
            setTimeout(resolve, 0);
          }
        }, 500);
      }),
  );
}

type InteractionPreloadWindow = Window & {
  openclawInteractionPreloadState?: WeakMap<HTMLLinkElement, "load" | "error">;
};

export type InteractionNavigationPreloads = {
  group: string | undefined;
  assets: Array<{
    href: string;
    linkStates: Array<"load" | "error" | "pending">;
    resourceComplete: boolean;
  }>;
};

export function installInteractionNavigationPreloadObserver() {
  const settled = new WeakMap<HTMLLinkElement, "load" | "error">();
  Object.assign(window, { openclawInteractionPreloadState: settled });
  for (const type of ["load", "error"] as const) {
    document.addEventListener(
      type,
      (event) => {
        if (event.target instanceof HTMLLinkElement) {
          settled.set(event.target, type);
        }
      },
      true,
    );
  }
}

export async function settleInteractionNavigationPreloads(
  page: Page,
): Promise<InteractionNavigationPreloads> {
  // Headless Chromium can strand the shell's idle callback until another frame runs.
  await frames(page);
  const expected = await page.evaluate(async () => {
    const descriptor = document
      .getElementById("openclaw-navigation-preloads")
      ?.getAttribute("content");
    const route = window.openclawControlUi?.snapshot().route?.matches[0]?.routeId;
    if (!descriptor || !route) {
      throw new Error("Warm interaction requires the built navigation prefetch manifest");
    }
    // The fixture server mounts resources at /; deep-link entry-script aliases differ.
    const base = new URL("/", location.origin);
    const response = await fetch(new URL(descriptor, base));
    if (!response.ok) {
      throw new Error("Could not read the built navigation prefetch manifest");
    }
    const manifest: Record<string, string[]> = await response.json();
    // Match the idle owner's automatic group; explicit navigation intent remains native.
    const next = `${route}-next`;
    const group = manifest[next] ? next : route === "new-session" ? undefined : "new-session";
    if (group && !manifest[group]?.length) {
      throw new Error(`Navigation prefetch manifest has no ${group} assets`);
    }
    return {
      group,
      assets: [...new Set(group ? manifest[group] : [])].map((file) => new URL(file, base).href),
    };
  });
  const ready = await page.waitForFunction(
    ({ group, assets }) => {
      // SAFETY: the page's initialization script installs this diagnostic map before navigation.
      const settled = (window as InteractionPreloadWindow).openclawInteractionPreloadState;
      if (!settled) {
        throw new Error("Navigation prefetch observer must be installed before navigation");
      }
      const links = [
        ...document.querySelectorAll<HTMLLinkElement>(
          'link[rel="preload"], link[rel="modulepreload"]',
        ),
      ];
      const observations = assets.map((href) => {
        const matching = links.filter((link) => link.href === href);
        const linkStates = matching.map((link) => settled.get(link) ?? ("pending" as const));
        if (linkStates.includes("error")) {
          throw new Error(`Navigation prefetch failed: ${href}`);
        }
        return {
          href,
          linkStates,
          resourceComplete: performance
            .getEntriesByName(href, "resource")
            .some((entry) => entry instanceof PerformanceResourceTiming && entry.responseEnd > 0),
        };
      });
      return observations.every((asset) =>
        asset.linkStates.length
          ? asset.linkStates.every((state) => state === "load")
          : asset.resourceComplete,
      )
        ? { group, assets: observations }
        : false;
    },
    expected,
    { timeout: 60_000, polling: 100 },
  );
  try {
    const evidence = await ready.jsonValue();
    if (!evidence) {
      throw new Error("Navigation prefetch did not complete");
    }
    return evidence;
  } finally {
    await ready.dispose();
  }
}

export async function settleSidebarBackgroundWork(page: Page) {
  await settleInteractionNavigationPreloads(page);
  await settleSidebarCapture(page);
  await page.waitForLoadState("networkidle");
  await frames(page);
}

async function prepareSidebarResources(page: Page, gateway: MockGatewayControls) {
  await prepareSidebarInventory(page, gateway);
  const showMore = page.locator(
    '.sidebar-session-pagination__button[aria-label="Show more"]:visible',
  );
  // Section pagination reveals ten of the already-loaded 1,000 rows per click.
  for (let pageIndex = 0; pageIndex < 100 && (await showMore.count()); pageIndex++) {
    await showMore.first().click();
    await frames(page);
  }
  await showMore.waitFor({ state: "hidden" });
  await page
    .locator(".sidebar-shell__body")
    .first()
    .evaluate((element) => {
      element.scrollTop = 0;
    });
  await frames(page);
  const label = page.locator(".sidebar-recent-session__name.hover-marquee").first();
  await label.waitFor({ state: "visible" });
  if (!(await label.textContent())?.includes("synthetic deployment")) {
    throw new Error("Resource scenario requires the long-label 1,000-session fixture");
  }
  // Leave the pointer away from rows; idle measurements must not include a hovered marquee.
  const viewport = page.viewportSize()!;
  await page.mouse.move(viewport.width - 4, viewport.height - 4);
  await settleSidebarBackgroundWork(page);
}

async function routeLink(page: Page, route: "sessions" | "cron") {
  await navigation(page, "pages");
  return page.locator(`.sidebar-pages a[href="${pathForRoute(route)}"]`).first();
}

async function inventoryReady(
  page: Page,
  gateway: MockGatewayControls,
  route: "sessions" | "cron",
) {
  if (route === "sessions") {
    await gateway.waitForRequest("sessions.list", { match: { source: "sessions-page" } });
    await page
      .locator(".sessions-table tbody .session-data-row")
      .first()
      .getByText("Interaction 0000", { exact: true })
      .waitFor();
    await page.waitForFunction(
      () => document.querySelectorAll(".sessions-table tbody .session-data-row").length === 25,
    );
  } else {
    await gateway.waitForRequest("cron.list", { match: { offset: 0 } });
    await page
      .locator(".cron-table__row")
      .getByText("Warm automation 0000", { exact: true })
      .waitFor();
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".cron-table__row").length === 50 &&
        document.querySelector(".cron-table")?.getAttribute("aria-busy") !== "true",
    );
  }
}

async function warmRoute(page: Page, gateway: MockGatewayControls, route: "sessions" | "cron") {
  await (await routeLink(page, route)).click();
  await waitForControlUiRoute(page, { routeId: route });
  await inventoryReady(page, gateway, route);
  await page.goBack();
  await waitForControlUiRoute(page, { routeId: "new-session" });
  await (await routeLink(page, route)).waitFor();
}

async function prepareSessions(page: Page, gateway: MockGatewayControls) {
  await page.locator(".sessions-table tbody .session-data-row").first().waitFor();
  const toggle = page.getByRole("button", { name: "Filters", exact: true });
  await toggle.click();
  const filters = page.locator(".sessions-filter-popover:popover-open");
  const after = (
    await gateway.getRequests("sessions.list", { source: "sessions-page", limit: 1000 })
  ).length;
  const limit = filters.getByLabel("Limit", { exact: true });
  await limit.fill("1000");
  await limit.press("Tab");
  await gateway.waitForRequest("sessions.list", {
    after,
    match: { source: "sessions-page", limit: 1000 },
  });
  await page.locator(".data-table-pagination__info").getByText(/1000/).waitFor();
  await toggle.click();
  await filters.waitFor({ state: "hidden" });
  // The owner sorts 1,000 rows, while the product deliberately renders at most 100 per page.
  await page.locator(".data-table-pagination__size").selectOption("100");
  await page.waitForFunction(
    () => document.querySelectorAll(".sessions-table tbody .session-data-row").length === 100,
  );
  await frames(page);
}

async function refreshSessions(page: Page, gateway: MockGatewayControls) {
  const after = (await gateway.getRequests("sessions.list", { source: "sessions-page" })).length;
  await page.locator(".sessions-toolbar__refresh").click();
  await gateway.waitForRequest("sessions.list", { after, match: { source: "sessions-page" } });
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>(".sessions-toolbar__refresh")?.disabled,
  );
  await frames(page);
}

async function prepareCron(page: Page) {
  await page.locator(".cron-table__row").first().waitFor();
  const more = page.getByRole("button", { name: "Load more", exact: true });
  for (let count = 100; count <= 500; count += 50) {
    await more.click();
    await page.waitForFunction(
      (expected) => document.querySelectorAll(".cron-table__row").length === expected,
      count,
    );
  }
}

async function settingsSection(
  page: Page,
  path: string,
  routeId: "appearance" | "connection" | "notifications",
) {
  const sidebar = page.locator(".settings-sidebar");
  await sidebar.waitFor({ state: "attached" });
  if (await page.locator(".shell--mobile-nav:not(.shell--nav-drawer-open)").count()) {
    await openNavigationDrawer(page);
  }
  await sidebar.locator(`a[href="${path}"]`).click();
  await waitForControlUiRoute(page, { routeId, pathname: path });
}

async function prepareModelPicker(page: Page) {
  await prepareFirstModelPicker(page);
  const trigger = page.locator(`${activePane} [data-chat-model-select]`);
  await trigger.click();
  await page.locator("[data-chat-model-search]").waitFor();
  await trigger.click();
}

async function prepareFirstModelPicker(page: Page) {
  await prepareChat(page);
  await page.locator(`${activePane} .agent-chat__input textarea`).first().click();
  await page
    .locator(`${activePane} [data-chat-model-select][aria-disabled="false"][aria-busy="false"]`)
    .waitFor();
  if (await page.locator(".chat-controls__model-menu, [data-chat-model-search]").count()) {
    throw new Error("First-open measurement requires an unopened picker");
  }
}

async function runFirstModelPicker(page: Page, recordPhases = false): Promise<InteractionEvidence> {
  const recorder = recordPhases
    ? await page.evaluateHandle((pane) => {
        const events: Array<{
          target: string;
          type: string;
          eventMs: number;
          observedMs: number;
        }> = [];
        const eventTypes = [
          "pointerdown",
          "pointerup",
          "touchstart",
          "touchend",
          "click",
          "focus",
          "focusin",
          "keydown",
          "keyup",
          "beforeinput",
          "input",
        ];
        const record = (event: Event) => {
          if (!(event.target instanceof Element)) {
            return;
          }
          const target = event.target.closest(`${pane} [data-chat-model-select]`)
            ? "trigger"
            : event.target.closest("[data-chat-model-search]")
              ? "search"
              : undefined;
          if (!target) {
            return;
          }
          events.push({
            target,
            type: event.type,
            eventMs: event.timeStamp,
            observedMs: performance.now(),
          });
        };
        for (const type of eventTypes) {
          document.addEventListener(type, record, true);
        }
        return {
          finish(startedAt: number) {
            const evidence: Record<string, number> = {
              timeOriginMs: performance.timeOrigin,
              startedAtMs: startedAt,
            };
            for (const event of events) {
              if (event.observedMs < startedAt) {
                continue;
              }
              const key = `native_${event.target}_${event.type}`;
              const index = evidence[`${key}_count`] ?? 0;
              evidence[`${key}_${index}_event_ms`] = event.eventMs - startedAt;
              evidence[`${key}_${index}_observed_ms`] = event.observedMs - startedAt;
              evidence[`${key}_count`] = index + 1;
            }
            return evidence;
          },
          dispose() {
            for (const type of eventTypes) {
              document.removeEventListener(type, record, true);
            }
          },
        };
      }, activePane)
    : undefined;
  try {
    const started = await page.evaluate(() => performance.now());
    const trigger = page.locator(`${activePane} [data-chat-model-select]`);
    if ((page.viewportSize()?.width ?? 1440) < 600) {
      await trigger.tap();
    } else {
      await trigger.click();
    }
    await page.locator("[data-chat-model-search]").waitFor();
    await page.waitForFunction(
      () => document.activeElement === document.querySelector("[data-chat-model-search]"),
    );
    const firstOpenReadyMs = await page.evaluate((start) => performance.now() - start, started);
    await searchModels(page);
    if (!(await page.locator('[data-chat-model-option="example/model-999"]').isEnabled())) {
      throw new Error("First-open search result is not selectable");
    }
    return recorder
      ? {
          firstOpenReadyMs,
          ...(await recorder.evaluate((value, start) => value.finish(start), started)),
        }
      : { firstOpenReadyMs };
  } finally {
    if (recorder) {
      try {
        await recorder.evaluate((value) => value.dispose());
      } finally {
        await recorder.dispose();
      }
    }
  }
}

async function searchModels(page: Page) {
  await searchModelQuery(page, modelQuery);
}

async function searchModelQuery(page: Page, query: string) {
  await page.locator("[data-chat-model-search]").pressSequentially(query);
  await page.locator('[data-chat-model-option="example/model-999"]').waitFor();
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll<HTMLElement>("[data-chat-model-option]")].filter((option) =>
        option.checkVisibility(),
      ).length === 1,
  );
}

async function navigateModels(page: Page) {
  const search = page.locator("[data-chat-model-search]");
  const initial = await search.getAttribute("aria-activedescendant");
  if (!initial) {
    throw new Error("Expected an initial active model descendant");
  }
  await search.press("ArrowDown");
  await page.waitForFunction(
    (id) =>
      document.querySelector("[data-chat-model-search]")?.getAttribute("aria-activedescendant") !==
      id,
    initial,
  );
  for (let index = 0; index < 9; index++) {
    await search.press("ArrowDown");
  }
  for (let index = 0; index < 10; index++) {
    await search.press("ArrowUp");
  }
  await page.waitForFunction(
    (id) =>
      document.querySelector("[data-chat-model-search]")?.getAttribute("aria-activedescendant") ===
      id,
    initial,
  );
}

async function prepareProviderUsage(page: Page) {
  const summary = page.locator('[data-provider-id="openai"] .provider-row__summary');
  await summary.waitFor();
  if ((await summary.getAttribute("aria-expanded")) !== "true") {
    await summary.click();
  }
  await page.locator(".provider-usage__window").first().waitFor();
}

const providerModelPickerSelector = ".model-providers__defaults openclaw-select-picker";
const providerModelValue = "example/model-999";

function providerModelPicker(page: Page) {
  return page.locator(providerModelPickerSelector).first();
}

async function openProviderModelPicker(page: Page) {
  await providerModelPicker(page).locator(".picker-select__trigger").click();
  await page.waitForFunction((selector) => {
    const picker = document.querySelector(selector);
    const search = picker?.querySelector(".picker-select__search");
    return (
      picker?.querySelector(".picker-select__trigger")?.getAttribute("aria-expanded") === "true" &&
      search === document.activeElement &&
      picker
        .querySelector<HTMLElement>('[role="option"][data-value^="example/model-"]')
        ?.checkVisibility()
    );
  }, providerModelPickerSelector);
}

async function closeProviderModelPicker(page: Page) {
  await providerModelPicker(page).locator(".picker-select__search").press("Escape");
  await page.waitForFunction((selector) => {
    const picker = document.querySelector(selector);
    const trigger = picker?.querySelector(".picker-select__trigger");
    return (
      trigger?.getAttribute("aria-expanded") === "false" &&
      trigger === document.activeElement &&
      picker?.querySelectorAll('[role="option"]').length === 0
    );
  }, providerModelPickerSelector);
}

async function prepareProviderModelPicker(page: Page) {
  await prepareProviderUsage(page);
  await openProviderModelPicker(page);
  await closeProviderModelPicker(page);
}

async function searchProviderModels(page: Page) {
  await providerModelPicker(page).locator(".picker-select__search").pressSequentially(modelQuery);
  await page.waitForFunction(
    ({ selector, value }) => {
      const picker = document.querySelector(selector);
      const rows = [...(picker?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])].filter(
        (option) => option.checkVisibility(),
      );
      return rows.length === 1 && rows[0]?.dataset.value === value;
    },
    { selector: providerModelPickerSelector, value: providerModelValue },
  );
}

export const interactionScenarios: readonly InteractionScenario[] = [
  ...dataActivityLiveScenarios,
  ...dataActivityScenarios,
  ...dataBoardScenarios,
  ...dataCatalogScenarios,
  ...dataLogScenarios,
  ...dataUsageDetailScenarios,
  ...dataUsageScenarios,
  ...(
    ["tooltips", "link-providers", "link-metadata", "ci-pairs", "clawhub-cards"] as const
  ).flatMap((family): InteractionScenario[] => {
    const active: InteractionScenario = {
      id: `projection-${family}`,
      route: "/instance-resource-fixture.html",
      expected:
        "Real production consumers on an isolated benchmark document; native observer/listener/subscription counts and retained scope/cleanup contracts, with twenty bounded native publication batches.",
      projectionFamily: family,
      prepare: async (page) => {
        if (await page.locator("openclaw-app").count()) {
          throw new Error("Instance resources require the benchmark-only blank document");
        }
      },
      run: async (page): Promise<void> => {
        await runProjectionFixture(page);
      },
    };
    const idle = (["visible", "hidden"] as const).map((visibility): InteractionScenario => ({
      id: `projection-${family}-idle-${visibility}`,
      route: "/instance-resource-fixture.html",
      expected: `Actual ${family} consumers stay mounted for three ${visibility} native-clock seconds; no global count instrumentation exists in CPU mode.`,
      projectionFamily: family,
      projectionIdle: true,
      visibility: visibility === "hidden" ? visibility : undefined,
      prepare: async () => {},
      run: async (page): Promise<void> => {
        const state = () => page.evaluate(() => document.visibilityState);
        if ((await state()) !== visibility) {
          throw new Error(`Expected ${visibility} instance document`);
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 3_000);
        });
        if ((await state()) !== visibility) {
          throw new Error("Instance idle visibility changed");
        }
      },
    }));
    return [active].concat(idle);
  }),
  ...heavyContentScenarios,
  ...createBrowserResourceScenarios({
    route: controlUiSessionPath(sessionKeys[0]),
    openPanel: openInteractionPanel,
    switchSession,
    prepare: settleSidebarBackgroundWork,
    settle: async (page) => {
      await frames(page);
      await settleSidebarCapture(page);
    },
  }),
  ...(["sdk-avatars", "sdk-avatar-identities"] as const).map((family): InteractionScenario => ({
    id: `projection-${family}`,
    route: controlUiSessionPath(sessionKeys[0]),
    expected:
      "120 SDK avatars in A and 40 in B, two real factories per application; twenty native publications update A only, then independent factory/application retirement.",
    projectionFamily: family,
    prepare: prepareChat,
    run: async (page) => {
      await runProjectionFixture(page);
    },
  })),
  ...(["visible", "hidden"] as const).map((visibility): InteractionScenario => ({
    id: `projection-outbox-idle-${visibility}`,
    route: controlUiSessionPath(sessionKeys[0]),
    expected: `480 actual outbox rows remain mounted for three ${visibility} native-clock idle seconds, then retire independently.`,
    projectionFamily: "outbox",
    projectionIdle: true,
    visibility: visibility === "hidden" ? visibility : undefined,
    prepare: prepareChat,
    run: async (page) => {
      const state = () => page.evaluate(() => document.visibilityState);
      if ((await state()) !== visibility) {
        throw new Error(`Expected ${visibility} projection page`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 3_000);
      });
      if (
        (await state()) !== visibility ||
        (await page
          .locator('[data-projection-application="A"] [data-attention-kind="outbox"]')
          .count()) !== 400
      ) {
        throw new Error("Projection idle visibility or mounted family changed");
      }
    },
  })),
  ...(["agent-rows", "outbox", "board-pins"] as const).map((family): InteractionScenario => ({
    id: `projection-${family}`,
    route: controlUiSessionPath(sessionKeys[0]),
    expected:
      "400 rows in application A and 80 in B; twenty actual native-owner publications update A alone, then both groups retire independently.",
    projectionFamily: family,
    prepare: prepareChat,
    run: async (page) => {
      await runProjectionFixture(page);
    },
  })),
  {
    id: "workboard-native-resources",
    route: workboardResourceRoute,
    fixture: { workboardResources: true },
    resourceOnly: true,
    observationBrowser: true,
    expected:
      "1,000 actual native Workboard cards preserve cancelled/coalesced popover transitions, pending hover cancellation, placement and independent resource retirement. Requires --resource-counts; diagnostic waits are not CPU timing.",
    rowSelector: ".workboard-card",
    prepare: (page) => prepareWorkboardResourceFixture(page, settleSidebarBackgroundWork),
    run: (page, gateway) => exerciseWorkboardResourceFixture(page, gateway, frames),
  },
  {
    id: "workboard-events-cpu",
    route: workboardResourceRoute,
    fixture: { workboardResources: true },
    resourceOnly: true,
    observationBrowser: true,
    expected:
      "1,000 closed cards receive eight actual viewport changes and eight native column scrolls with no diagnostic listeners; measure CPU without --resource-counts.",
    prepare: (page) => prepareWorkboardResourceFixture(page, settleSidebarBackgroundWork),
    run: async (page) => {
      const evidence = await runWorkboardEventsCpu(page, frames);
      await settleSidebarCapture(page);
      return evidence;
    },
  },
  {
    id: "workboard-remount-cpu",
    route: workboardResourceRoute,
    fixture: { workboardResources: true },
    resourceOnly: true,
    observationBrowser: true,
    expected:
      "Retire 1,000 actual cards, then mount 1,000 through real paginated responses inside the warm CPU interval; measure without --resource-counts.",
    prepare: (page) => prepareWorkboardResourceFixture(page, settleSidebarBackgroundWork),
    run: async (page, gateway) => {
      const evidence = await runWorkboardRemountCpu(page, gateway, frames);
      await settleSidebarCapture(page);
      return evidence;
    },
  },
  ...(["visible", "hidden"] as const).map((visibility): InteractionScenario => ({
    id: `workboard-idle-${visibility}`,
    route: workboardResourceRoute,
    fixture: { workboardResources: true },
    resourceOnly: true,
    observationBrowser: true,
    visibility: visibility === "hidden" ? visibility : undefined,
    expected: `1,000 actual Workboard cards stay mounted and genuinely ${visibility} during three native-clock idle seconds.`,
    prepare: (page) => prepareWorkboardResourceFixture(page, settleSidebarBackgroundWork),
    run: (page) => idleWorkboardResourceFixture(page, visibility),
  })),
  {
    id: "mcp-app-resize-resources",
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { mcpAppResources: true },
    resourceOnly: true,
    expected:
      "Three real MCP Apps keep frame state and independently receive current container dimensions.",
    rowSelector: "mcp-app-view iframe",
    prepare: prepareMcpResources,
    run: resizeMcpResources,
  },
  {
    id: "transcript-platform-events",
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { longUserMessages: true },
    resourceOnly: true,
    expected:
      "The 400-message fixture exercises mounted message metric consumers across native viewport/reduced-motion changes, nine explicitly synthetic document.fonts notifications, and virtualized row retirement.",
    prepare: preparePlatformTranscript,
    run: runTranscriptPlatformEvents,
  },
  ...(["visible", "hidden"] as const).map((visibility): InteractionScenario => ({
    id: `transcript-platform-idle-${visibility}`,
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { longUserMessages: true },
    resourceOnly: true,
    visibility: visibility === "hidden" ? visibility : undefined,
    expected: `Mounted long-user message consumers remain ${visibility} for three native-clock idle seconds; inventory and mounted counts are reported separately.`,
    prepare: preparePlatformTranscript,
    run: async (page) => {
      const before = await platformTranscriptSnapshot(page);
      if (before.documentVisibility !== visibility) {
        throw new Error(`Expected ${visibility} transcript before idle`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 3_000);
      });
      const after = await platformTranscriptSnapshot(page);
      if (after.documentVisibility !== visibility || after.mountedMessageDisclosures === 0) {
        throw new Error(`Transcript or ${visibility} state changed during idle`);
      }
      return {
        syntheticFontNotifications: false,
        syntheticFontEvents: 0,
        nativeViewportChanges: 0,
        nativeReducedMotionChanges: 0,
        ...platformTranscriptEvidence("before", before),
        ...platformTranscriptEvidence("after", after),
      };
    },
  })),
  {
    id: "board-native-message-resources",
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { nativeBoardResources: true },
    resourceOnly: true,
    expected: "Six active native Dashboard cells have no sandbox frame or frame-message work.",
    rowSelector: "openclaw-session-progress-widget",
    prepare: prepareNativeBoard,
    run: async (page) => {
      await frames(page);
      const counts = await page
        .locator("openclaw-session-progress-widget")
        .evaluateAll((widgets) => ({
          widgets: widgets.length,
          active: widgets.filter((widget) => Reflect.get(widget, "active") === true).length,
          frames: document.querySelectorAll(".board-widget__frame").length,
        }));
      if (counts.widgets !== 6 || counts.active !== 6 || counts.frames !== 0) {
        throw new Error("Native Dashboard workload must retain six active cells without iframes");
      }
      return { mountedNativeCells: counts.widgets, mountedFrames: counts.frames };
    },
  },
  {
    id: "board-frame-first-handshake",
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { boardFrameResources: true },
    resourceOnly: true,
    expected: "Opening Dashboard completes the real sandbox handshake for three HTML frames.",
    rowSelector: boardFrameSelector,
    setup: installResourceBoardDocuments,
    prepare: async (page) => {
      await prepareChat(page);
      await settleSidebarBackgroundWork(page);
    },
    run: async (page) => {
      await openInteractionPanel(page);
      await waitForResourceBoardTab(page, "main");
      const count = await page.locator(boardFrameSelector).count();
      if (count !== 3) {
        throw new Error("Only the first visited board tab may load its three frames");
      }
      return { mountedFrames: count, parkedFrames: 0 };
    },
  },
  {
    id: "board-frame-message-resources",
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { boardFrameResources: true },
    resourceOnly: true,
    expected:
      "Six real sandbox frames survive tab parking, scoped resize and forwarded wheel input.",
    rowSelector: boardFrameSelector,
    setup: installResourceBoardDocuments,
    prepare: prepareResourceBoard,
    run: exerciseResourceBoard,
  },
  {
    id: "canvas-frame-retention-resources",
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { canvasFrameRetention: true },
    resourceOnly: true,
    expected:
      "A live Canvas counter reaches its final reply with one retained frame and one view read.",
    rowSelector: canvasFrameSelector,
    prepare: prepareCanvasRetention,
    run: finishCanvasRetention,
  },
  ...(["board", "canvas"] as const).flatMap((kind) =>
    (["visible", "hidden"] as const).map((visibility): InteractionScenario => ({
      id: `${kind}-frame-idle-${visibility}`,
      route: controlUiSessionPath(sessionKeys[0]),
      fixture: kind === "board" ? { boardFrameResources: true } : { canvasFrameRetention: true },
      resourceOnly: true,
      visibility: visibility === "hidden" ? visibility : undefined,
      expected: `The retained ${kind} frames preserve identity and state during three ${visibility} native-clock idle seconds.`,
      rowSelector: kind === "board" ? boardFrameSelector : canvasFrameSelector,
      setup: kind === "board" ? installResourceBoardDocuments : undefined,
      prepare: async (page, gateway) => {
        if (kind === "board") {
          await prepareResourceBoard(page);
        } else {
          await prepareCanvasRetention(page, gateway);
        }
        const viewport = page.viewportSize()!;
        await page.mouse.move(viewport.width - 4, viewport.height - 4);
        await frames(page);
      },
      run: (page, gateway) => idleResourceFrames(page, gateway, kind, visibility),
    })),
  ),
  {
    id: "sidebar-resources-scroll-resize",
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { longSessionLabels: true },
    resourceOnly: true,
    expected:
      "The 1,000-session sidebar reaches its final row, survives a viewport resize, and returns to its first row.",
    rowSelector: ".sidebar-recent-session",
    prepare: prepareSidebarResources,
    run: async (page) => {
      const scroller = page.locator(".sidebar-shell__body").first();
      const viewport = page.viewportSize()!;
      for (const fraction of [0.25, 0.5, 0.75, 1]) {
        await scroller.evaluate((element, position) => {
          element.scrollTop = (element.scrollHeight - element.clientHeight) * position;
        }, fraction);
        await frames(page);
      }
      await page
        .locator('.sidebar-recent-session[data-session-key="agent:main:interaction-999"]')
        .waitFor({ state: "visible" });
      if ((await scroller.evaluate((element) => element.scrollTop)) <= 0) {
        throw new Error("The sidebar did not scroll through its loaded inventory");
      }
      await page.setViewportSize({ width: viewport.width + 48, height: viewport.height });
      await frames(page);
      await page.setViewportSize(viewport);
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
      });
      await page
        .locator(`.sidebar-recent-session[data-session-key="${sessionKeys[0]}"]`)
        .waitFor({ state: "visible" });
      await frames(page);
    },
  },
  ...(["visible", "hidden"] as const).map((visibility): InteractionScenario => ({
    id: `sidebar-resources-idle-${visibility}`,
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { longSessionLabels: true },
    resourceOnly: true,
    visibility: visibility === "hidden" ? visibility : undefined,
    expected: `The 1,000-session sidebar remains mounted and ${visibility} for three native-clock idle seconds.`,
    prepare: prepareSidebarResources,
    run: async (page) => {
      const state = () => page.evaluate(() => document.visibilityState);
      if ((await state()) !== visibility) {
        throw new Error(`Expected a ${visibility} page before the idle interval`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 3_000);
      });
      if (
        (await state()) !== visibility ||
        !(await page.locator(".sidebar-recent-session").count())
      ) {
        throw new Error(`Sidebar or ${visibility} state changed during the idle interval`);
      }
    },
  })),
  {
    id: "progress-card-clock-tick",
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { progressCardClocks: true },
    resourceOnly: true,
    expected:
      "Mounted progress widgets in the 400-message chat retain their clocks and advance after a native 30-second tick.",
    rowSelector: progressClocks,
    prepare: prepareProgressClocks,
    run: async (page) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 31_500);
      });
      const initial = initialProgressClocks.get(page)!;
      const clocks = page.locator(progressClocks);
      const labels = await clocks.allTextContents();
      if (
        (await page.evaluate(() => document.visibilityState)) !== "visible" ||
        labels.length !== initial.count ||
        labels.some((label, index) => !label.trim() || label === initial.labels[index])
      ) {
        throw new Error(
          "Mounted progress clocks must remain attached and advance while the page is visible",
        );
      }
      initialProgressClocks.delete(page);
    },
  },
  ...(["visible", "hidden"] as const).map((visibility): InteractionScenario => ({
    id: `progress-card-clock-idle-${visibility}`,
    route: controlUiSessionPath(sessionKeys[0]),
    fixture: { progressCardClocks: true },
    resourceOnly: true,
    visibility: visibility === "hidden" ? visibility : undefined,
    expected: `The actual mounted progress-clock count is retained during ${visibility} native-clock idle.`,
    rowSelector: progressClocks,
    prepare: prepareProgressClocks,
    run: async (page) => {
      const state = () => page.evaluate(() => document.visibilityState);
      if ((await state()) !== visibility) {
        throw new Error(`Expected a ${visibility} page before progress-clock idle`);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, visibility === "hidden" ? 31_500 : 3_000);
      });
      const initial = initialProgressClocks.get(page)!;
      if (
        (await state()) !== visibility ||
        (await page.locator(progressClocks).count()) !== initial.count
      ) {
        throw new Error(`Mounted progress clocks or ${visibility} state changed while idle`);
      }
      initialProgressClocks.delete(page);
    },
  })),
  {
    id: "sidebar-clock-idle",
    route: "/new",
    fixture: { runningSessions: true },
    expected: "At least 100 running child-session clocks advance during five idle seconds.",
    rowSelector: sidebarClocks,
    prepare: async (page) => {
      await navigation(page, "sessions");
      const toggle = page.locator(`[data-child-session-toggle="${sessionKeys[0]}"]`);
      await toggle.waitFor();
      if ((await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      await page.locator(sidebarClocks).first().waitFor({ state: "attached" });
      const more = page.locator(`[data-show-more-children="${sessionKeys[0]}"]`);
      if ((await page.locator(sidebarClocks).count()) < 100 && (await more.count()) > 0) {
        await more.click();
      }
      await page.waitForFunction(
        (selector) => document.querySelectorAll(selector).length >= 100,
        sidebarClocks,
      );
      const viewport = page.viewportSize()!;
      await page.mouse.move(viewport.width - 8, viewport.height - 8);
      await page.locator('[role="tooltip"]:visible').first().waitFor({ state: "hidden" });
      await settleSidebarBackgroundWork(page);
      const label = await page.locator(sidebarClocks).first().textContent();
      if (!label?.trim()) {
        throw new Error("Running sidebar clocks must have an initial elapsed label");
      }
      initialClockLabels.set(page, label);
    },
    run: async (page) => {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 5_000);
          }),
      );
      const clocks = page.locator(sidebarClocks);
      const label = await clocks.first().textContent();
      if (
        (await clocks.count()) < 100 ||
        !label?.trim() ||
        label === initialClockLabels.get(page)
      ) {
        throw new Error("At least 100 running sidebar clocks must remain mounted and advance");
      }
      initialClockLabels.delete(page);
    },
  },
  {
    id: "agent-skills-refresh",
    route: pathForAgentPanel("main", "skills"),
    expected: "Refreshing the agent's skills retains both rows and their diagnostics.",
    rowSelector: ".agent-skill-row, .agent-skill-row .settings-row__desc",
    prepare: async (page) => {
      await page.locator(".agent-skill-row").first().waitFor();
    },
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("skills.status")).length;
      const section = page.locator(".settings-section").filter({
        has: page.locator('input[name="agent-skills-filter"]'),
      });
      await section.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("skills.status", { after });
      await frames(page);
    },
  },
  {
    id: "meeting-health-refresh",
    route: `${pathForRoute("communications")}?section=transcripts#settings-communications-meeting-capture`,
    expected: "Refreshing capture health retains source controls and health rows.",
    rowSelector: "openclaw-meeting-capture-settings .settings-row",
    prepare: async (page) => {
      await page
        .locator('openclaw-meeting-capture-settings [aria-label="Edit source 1"]')
        .waitFor();
      await page.getByText("Applied source state", { exact: true }).waitFor();
    },
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("transcripts.status")).length;
      await page
        .locator("openclaw-meeting-capture-settings")
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await gateway.waitForRequest("transcripts.status", { after });
      await frames(page);
    },
  },
  {
    id: "cron-refresh",
    route: pathForRoute("cron"),
    expected: "Refreshing the first automation page retains unchanged job rows.",
    rowSelector: ".cron-table__row",
    prepare: async (page, gateway) => inventoryReady(page, gateway, "cron"),
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("cron.list")).length;
      await page.locator(".cron-refresh").click();
      await gateway.waitForRequest("cron.list", { after });
      await page.waitForFunction(
        () => document.querySelector(".cron-table")?.getAttribute("aria-busy") !== "true",
      );
      await frames(page);
    },
  },
  {
    id: "provider-usage-refresh",
    route: pathForRoute("model-providers"),
    expected: "Refreshing provider usage retains the plan windows and billing rows.",
    rowSelector:
      ".provider-usage__group, .provider-usage__window, .provider-usage__row, .provider-usage__chip",
    prepare: prepareProviderUsage,
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("usage.status")).length;
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("usage.status", { after });
      await frames(page);
    },
  },
  {
    id: "provider-model-picker-open-search",
    route: pathForRoute("model-providers"),
    expected:
      "The generic 1,000-model primary picker filters to Warm model 0999, closes without saving, and returns focus.",
    prepare: prepareProviderModelPicker,
    run: async (page, gateway) => {
      const picker = providerModelPicker(page);
      const trigger = picker.locator(".picker-select__trigger");
      const selected = await trigger.getAttribute("aria-label");
      const saves = (await gateway.getRequests("config.patch")).length;
      await openProviderModelPicker(page);
      await searchProviderModels(page);
      await closeProviderModelPicker(page);
      if (
        (await trigger.getAttribute("aria-label")) !== selected ||
        (await gateway.getRequests("config.patch")).length !== saves
      ) {
        throw new Error(
          "Searching and dismissing the provider model picker must preserve its selection without saving",
        );
      }
    },
  },
  {
    id: "provider-model-picker-long-name",
    route: pathForRoute("model-providers"),
    resourceOnly: true,
    expected:
      "The generic picker preserves its intrinsic popup width for a long synthetic model name and leaves its filtered choice visible.",
    fixtureOverrides: () => {
      const models = createInteractionModels();
      models[998]!.name =
        "Warm model 0998 — Synthetic extended-context reasoning model with a deliberately wide provider name";
      return { models };
    },
    prepare: prepareProviderModelPicker,
    run: async (page) => {
      await openProviderModelPicker(page);
      const picker = providerModelPicker(page);
      await picker.locator(".picker-select__search").fill("model 0998");
      await picker.locator('[role="option"][data-value="example/model-998"]').waitFor({
        state: "visible",
      });
      await frames(page);
    },
  },
  {
    id: "provider-model-picker-first-open",
    route: pathForRoute("model-providers"),
    resourceOnly: true,
    expected: "The generic model picker loads its first window and focuses search on first open.",
    prepare: prepareProviderUsage,
    run: openProviderModelPicker,
  },
  {
    id: "provider-model-picker-open",
    route: pathForRoute("model-providers"),
    resourceOnly: true,
    expected: "The warm generic model picker opens with visible choices and focuses its search.",
    prepare: prepareProviderModelPicker,
    run: openProviderModelPicker,
  },
  {
    id: "provider-model-picker-search",
    route: pathForRoute("model-providers"),
    resourceOnly: true,
    expected: "The already-open generic model picker filters to Warm model 0999.",
    prepare: async (page) => {
      await prepareProviderModelPicker(page);
      await openProviderModelPicker(page);
      await frames(page);
    },
    run: searchProviderModels,
  },
  {
    id: "provider-model-picker-select",
    route: pathForRoute("model-providers"),
    resourceOnly: true,
    expected:
      "Enter selects Warm model 0999 once, persists its exact reference, and returns focus to the updated trigger.",
    fixtureOverrides: () => ({
      methodResponses: {
        "config.patch": {
          config: {
            ...createInteractionConfig(),
            agents: { defaults: { model: providerModelValue } },
          },
          hash: "interaction-selected-model",
        },
      },
    }),
    prepare: async (page) => {
      await prepareProviderModelPicker(page);
      await openProviderModelPicker(page);
      await searchProviderModels(page);
      await frames(page);
    },
    run: async (page, gateway) => {
      const saves = (await gateway.getRequests("config.patch")).length;
      await providerModelPicker(page).locator(".picker-select__search").press("Enter");
      const request = await gateway.waitForRequest("config.patch", { after: saves });
      const params = request.params;
      const patch: unknown =
        isRecord(params) && typeof params.raw === "string" ? JSON.parse(params.raw) : undefined;
      if (
        !isRecord(patch) ||
        !isRecord(patch.agents) ||
        !isRecord(patch.agents.defaults) ||
        patch.agents.defaults.model !== providerModelValue
      ) {
        throw new Error("The provider picker must persist the exact selected model reference");
      }
      await page.waitForFunction(
        ({ selector, label }) => {
          const picker = document.querySelector(selector);
          const trigger = picker?.querySelector<HTMLButtonElement>(".picker-select__trigger");
          return (
            trigger?.getAttribute("aria-expanded") === "false" &&
            !trigger.disabled &&
            trigger === document.activeElement &&
            trigger.getAttribute("aria-label")?.includes(label) &&
            picker?.querySelectorAll('[role="option"]').length === 0
          );
        },
        { selector: providerModelPickerSelector, label: modelQuery },
      );
      if ((await gateway.getRequests("config.patch")).length !== saves + 1) {
        throw new Error("Selecting a provider model must issue exactly one config patch");
      }
    },
  },
  {
    id: "storage-refresh",
    route: `${pathForRoute("ai-agents")}?section=session#settings-session-storage`,
    expected: "An unchanged storage refresh retains both agent rows and the open disclosure.",
    rowSelector: "openclaw-session-storage-settings details > .settings-row",
    prepare: async (page) => {
      const details = page.locator(
        "openclaw-session-storage-settings details.settings-row--stacked",
      );
      await details.locator("summary").click();
      await details.getByText("research", { exact: true }).waitFor();
    },
    run: async (page, gateway) => {
      const after = (await gateway.getRequests("sessions.storage.status")).length;
      const section = page.locator("openclaw-session-storage-settings");
      await section.getByRole("button", { name: "Refresh", exact: true }).click();
      await gateway.waitForRequest("sessions.storage.status", { after });
      await section.getByRole("button", { name: "Refresh", exact: true }).waitFor();
      await frames(page);
    },
  },
  {
    id: "sessions-refresh",
    route: pathForRoute("sessions"),
    expected: "Refreshing retains all visible sessions and expanded detail statistics.",
    rowSelector: ".sessions-table .session-data-row, .session-detail-stat",
    prepare: async (page, gateway) => {
      await prepareSessions(page, gateway);
      await refreshSessions(page, gateway);
      await page.locator(".session-details-toggle").first().click();
      await page.locator(".session-detail-stat").first().waitFor();
    },
    run: refreshSessions,
  },
  {
    id: "graph-stream-100-deltas",
    route: controlUiSessionPath(sessionKeys[0]),
    explicitOnly: true,
    expected:
      "One hundred separately flushed chat deltas render the complete reply, which remains visible after finalization.",
    prepare: async (page, gateway) => {
      await prepareChat(page);
      const after = (await gateway.getRequests("chat.send")).length;
      await page
        .locator(`${activePane} .agent-chat__composer-combobox textarea`)
        .fill("Produce the synthetic graph measurement reply.");
      await page.locator(`${activePane} .chat-send-btn--send`).click();
      const request = await gateway.waitForRequest("chat.send", { after });
      if (!isRecord(request.params) || typeof request.params.idempotencyKey !== "string") {
        throw new Error("Graph streaming fixture did not start a chat run");
      }
      graphStreamingRuns.set(page, request.params.idempotencyKey);
      await page.locator(`${activePane} .chat-send-btn--stop`).waitFor();
      await frames(page);
    },
    run: async (page, gateway) => {
      const runId = graphStreamingRuns.get(page);
      if (!runId) {
        throw new Error("Graph streaming fixture has no prepared run");
      }
      const text = await page.evaluate(
        async ({ sessionKey, runId: targetRunId }) => {
          const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
          let reply = "";
          for (let index = 1; index <= 100; index++) {
            reply += `Graph streaming checkpoint ${index}.\n\n`;
            mock.emit("chat", {
              sessionKey,
              runId: targetRunId,
              seq: index,
              state: "delta",
              message: { role: "assistant", content: [{ type: "text", text: reply }] },
            });
            // Give every event its own reactive flush and native presentation turn.
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            });
          }
          return reply;
        },
        { sessionKey: sessionKeys[0], runId },
      );
      const liveReply = page.locator(`${activePane} .chat-bubble.streaming`);
      await liveReply.getByText("Graph streaming checkpoint 100.", { exact: true }).waitFor();
      await liveReply.getByText("Graph streaming checkpoint 1.", { exact: true }).waitFor();
      await gateway.emitChatFinal({ sessionKey: sessionKeys[0], runId, text });
      const reply = page.locator(`${activePane} .chat-bubble:not(.streaming)`);
      await reply.getByText("Graph streaming checkpoint 100.", { exact: true }).waitFor();
      await reply.getByText("Graph streaming checkpoint 1.", { exact: true }).waitFor();
      const rendered =
        (await reply.filter({ hasText: "Graph streaming checkpoint 100." }).textContent()) ?? "";
      if (
        text
          .trim()
          .split("\n\n")
          .some((checkpoint) => !rendered.includes(checkpoint))
      ) {
        throw new Error("Graph streaming lost content during finalization");
      }
      await page.locator(`${activePane} .chat-send-btn--send`).waitFor();
      return { deltas: 100, finalized: true };
    },
  },
  {
    id: "graph-sidebar-live-update",
    route: controlUiSessionPath(sessionKeys[0]),
    explicitOnly: true,
    expected:
      "An existing sidebar session adopts its live title while the selected transcript stays visible.",
    prepare: async (page) => {
      await prepareChat(page);
      await navigation(page, "sessions");
      await page
        .locator(`.sidebar-recent-session[data-session-key="${sessionKeys[1]}"]`)
        .getByText("Interaction 0001", { exact: true })
        .waitFor();
      await settleSidebarBackgroundWork(page);
    },
    run: async (page, gateway) => {
      const row = await gateway.getSessionRow(sessionKeys[1]);
      const updatedAt = Math.max(Date.now(), (row.updatedAt ?? 0) + 1);
      const label = "Graph sidebar live update witness";
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: row.key,
        sessionId: row.sessionId,
        agentId: "main",
        reason: "patch",
        ts: updatedAt,
        session: { ...row, label, displayName: label, updatedAt, snapshotAt: updatedAt },
        ancestorSessions: [],
      });
      await page
        .locator(`.sidebar-recent-session[data-session-key="${sessionKeys[1]}"]`)
        .getByText(label, { exact: true })
        .waitFor();
      await page
        .locator(activePane)
        .getByText("Transcript 0 message 399.", { exact: false })
        .waitFor();
      await frames(page);
      return { updatedRows: 1 };
    },
  },
  {
    id: "chat-typing",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "Typing preserves the composer draft without sending a chat request.",
    prepare: prepareChat,
    run: async (page, gateway) => {
      const input = page.locator(`${activePane} .agent-chat__composer-combobox textarea`);
      const sends = (await gateway.getRequests("chat.send")).length;
      await input.pressSequentially("Synthetic typing 0123456789");
      await frames(page);
      if ((await input.inputValue()) !== "Synthetic typing 0123456789") {
        throw new Error("Typing lost the composer draft");
      }
      if ((await gateway.getRequests("chat.send")).length !== sends) {
        throw new Error("Typing must not send a chat request");
      }
    },
  },
  {
    id: "session-switch",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "Both retained 400-message transcripts become visible in turn.",
    rowSelector: "[data-virtual-row-key], .sidebar-recent-session",
    prepare: prepareSessionSwitch,
    run: async (page) => {
      await switchSession(page, 1);
      await switchSession(page, 0);
    },
  },
  {
    id: "transcript-scroll-top",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The first message of the 400-message transcript enters the viewport.",
    prepare: prepareChat,
    run: async (page) => {
      const thread = page.locator(`${activePane} .chat-thread`);
      if (page.viewportSize()!.width < 768) {
        // Playwright's mobile WebKit driver has no wheel input. Use the same
        // native scrollport jump in both mobile engines (not a wheel-latency sample).
        await thread.evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
      } else {
        await thread.hover();
        await page.mouse.wheel(0, -(await thread.evaluate((element) => element.scrollHeight)));
      }
      await thread.getByText("Transcript 0 message 0.", { exact: false }).waitFor();
      await page.waitForFunction(
        (selector) => document.querySelector(selector)?.scrollTop === 0,
        `${activePane} .chat-thread`,
      );
      await frames(page);
    },
  },
  {
    id: "sidebar-toggle",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The 1,000-session sidebar closes and reopens.",
    prepare: async (page, gateway) => {
      await prepareSidebarInventory(page, gateway);
      await settleSidebarBackgroundWork(page);
    },
    run: async (page) => {
      const mobile = (await page.locator(".shell--mobile-nav").count()) > 0;
      if (mobile) {
        await page.keyboard.press("Escape");
        await page.locator(".shell--nav-drawer-open").waitFor({ state: "detached" });
        await page.locator(".shell-nav").evaluate(async (drawer) => {
          await Promise.all(drawer.getAnimations().map((animation) => animation.finished));
        });
      } else {
        await page.locator(".sidebar-session-toolbar__collapse").first().click();
      }
      await navigation(page, "sessions");
      await page.locator(`.sidebar-recent-session[data-session-key="${sessionKeys[0]}"]`).waitFor();
      await frames(page);
      if (mobile && !(await page.locator(".shell-nav :focus").first().isVisible())) {
        throw new Error("Opening the mobile drawer must focus a control inside it");
      }
    },
  },
  {
    id: "session-palette-filter",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The command palette filters the session catalog to Interaction 0999.",
    prepare: async (page) => {
      await prepareChat(page);
      await page.keyboard.press("ControlOrMeta+k");
      await page.locator(".cmd-palette__input").waitFor();
      await page.keyboard.press("Escape");
    },
    run: async (page, gateway) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.locator(".cmd-palette__input").pressSequentially(sessionQuery);
      await page.getByRole("option", { name: new RegExp(sessionQuery) }).waitFor();
      await gateway.waitForRequest("sessions.search", { match: { query: sessionQuery } });
    },
  },
  {
    id: "settings-open",
    route: "/new",
    expected: "Settings opens at Appearance with a usable settings sidebar.",
    prepare: async (page) => {
      await page.keyboard.press("ControlOrMeta+Shift+,");
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await page.keyboard.press("Escape");
      await waitForControlUiRoute(page, { routeId: "new-session" });
    },
    run: async (page, gateway) => {
      const schemaReads = (await gateway.getRequests("config.schema")).length;
      await page.keyboard.press("ControlOrMeta+Shift+,");
      await waitForControlUiRoute(page, { routeId: "appearance" });
      await page.locator(".settings-page").waitFor();
      await frames(page);
      if ((await gateway.getRequests("config.schema")).length !== schemaReads) {
        throw new Error("Warm Settings must retain the loaded config schema");
      }
    },
  },
  {
    id: "settings-sections",
    route: "/settings/appearance",
    expected: "Notifications, Connection, and Appearance each finish their warm route transition.",
    prepare: async (page) => {
      await settingsSection(page, "/settings/notifications", "notifications");
      await settingsSection(page, "/settings/connection", "connection");
      await settingsSection(page, "/settings/appearance", "appearance");
    },
    run: async (page, gateway) => {
      const schemaReads = (await gateway.getRequests("config.schema")).length;
      await settingsSection(page, "/settings/notifications", "notifications");
      await settingsSection(page, "/settings/connection", "connection");
      await settingsSection(page, "/settings/appearance", "appearance");
      await frames(page);
      if ((await gateway.getRequests("config.schema")).length !== schemaReads) {
        throw new Error("Warm Settings tabs must retain the loaded config schema");
      }
    },
  },
  {
    id: "model-picker-first-open-search",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The unopened 1,000-model picker focuses search and filters to Warm model 0999.",
    prepare: prepareFirstModelPicker,
    run: (page) => runFirstModelPicker(page),
  },
  {
    id: "model-picker-first-open-phases",
    route: controlUiSessionPath(sessionKeys[0]),
    expected:
      "The first-open picker exposes native input timestamps with the original action cadence.",
    diagnostic: "Native event listeners and post-action collection perturb timing.",
    explicitOnly: true,
    prepare: prepareFirstModelPicker,
    run: (page) => runFirstModelPicker(page, true),
  },
  {
    id: "model-picker-open-search",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The 1,000-model picker opens and filters to Warm model 0999.",
    prepare: prepareModelPicker,
    run: async (page) => {
      await page.locator(`${activePane} [data-chat-model-select]`).click();
      await searchModels(page);
    },
  },
  {
    id: "model-picker-navigate",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "Keyboard navigation advances through model choices and returns to the selected row.",
    prepare: async (page) => {
      await prepareModelPicker(page);
      await page.locator(`${activePane} [data-chat-model-select]`).click();
      await page.locator("[data-chat-model-search]").waitFor();
      await frames(page);
    },
    run: navigateModels,
  },
  {
    id: "model-picker-filtered-navigate",
    route: controlUiSessionPath(sessionKeys[0]),
    resourceOnly: true,
    expected: "Keyboard navigation retains the active descendant across 1,000 filtered models.",
    prepare: async (page) => {
      await prepareModelPicker(page);
      await page.locator(`${activePane} [data-chat-model-select]`).click();
      await page.locator("[data-chat-model-search]").fill("Warm model");
      await page.waitForFunction(
        () =>
          Number.parseFloat(
            document.querySelector<HTMLElement>(
              "[data-chat-model-filtering] .chat-controls__model-virtual-content",
            )?.style.height ?? "",
          ) >= 30_000,
      );
      await frames(page);
    },
    run: navigateModels,
  },
  {
    id: "model-picker-search",
    route: controlUiSessionPath(sessionKeys[0]),
    expected: "The already-open 1,000-model picker filters to Warm model 0999.",
    prepare: async (page) => {
      await prepareModelPicker(page);
      await page.locator(`${activePane} [data-chat-model-select]`).click();
      await page.locator("[data-chat-model-search]").waitFor();
      await frames(page);
    },
    run: searchModels,
  },
  {
    id: "model-picker-reference-search",
    route: controlUiSessionPath(sessionKeys[0]),
    resourceOnly: true,
    expected: "A case-insensitive provider/model reference finds the original model choice.",
    prepare: async (page) => {
      await prepareModelPicker(page);
      await page.locator(`${activePane} [data-chat-model-select]`).click();
      await page.locator("[data-chat-model-search]").waitFor();
      await frames(page);
    },
    run: (page) => searchModelQuery(page, "EXAMPLE/MODEL-999"),
  },
  ...(["sessions", "cron"] as const).map((route): InteractionScenario => ({
    id: `${route}-open`,
    route: "/new",
    expected: `The warm ${route} route opens its default window from the Pages navigation.`,
    prepare: async (page, gateway) => warmRoute(page, gateway, route),
    run: async (page, gateway) => {
      await (await routeLink(page, route)).click();
      await waitForControlUiRoute(page, { routeId: route });
      await inventoryReady(page, gateway, route);
    },
  })),
  {
    id: "sessions-sort",
    route: "/sessions",
    expected: "Sorting the 1,000-session result reverses its Updated order.",
    prepare: prepareSessions,
    run: async (page) => {
      await page
        .locator(".sessions-table")
        .getByRole("button", { name: "Updated", exact: true })
        .click();
      await page
        .locator(".sessions-table tbody .session-data-row")
        .first()
        .getByText(sessionQuery, { exact: true })
        .waitFor();
    },
  },
  {
    id: "sessions-search",
    route: "/sessions",
    expected: "Gateway filtering replaces the 1,000-session result with Interaction 0999.",
    prepare: prepareSessions,
    run: async (page, gateway) => {
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      const after = (await gateway.getRequests("sessions.list", { search: sessionQuery })).length;
      await page
        .locator(".sessions-filter-popover:popover-open input")
        .first()
        .pressSequentially(sessionQuery);
      await gateway.waitForRequest("sessions.list", { after, match: { search: sessionQuery } });
      await page
        .locator(".sessions-table tbody .session-data-row")
        .getByText(sessionQuery, { exact: true })
        .waitFor();
      await page.waitForFunction(
        () => document.querySelectorAll(".sessions-table tbody .session-data-row").length === 1,
      );
    },
  },
  {
    id: "cron-search-typing-pending",
    route: pathForRoute("cron"),
    expected: "Typing updates the filter while one held request retains all 500 jobs.",
    prepare: async (page, gateway) => {
      await prepareCron(page);
      await page.getByRole("searchbox", { name: "Search automations" }).click();
      await gateway.deferNext("cron.list");
    },
    run: async (page, gateway) => {
      const before = (await gateway.getRequests("cron.list")).length;
      const search = page.getByRole("searchbox", { name: "Search automations" });
      await search.pressSequentially(cronQuery);
      await gateway.waitForRequest("cron.list", { match: { query: "W", offset: 0 } });
      await frames(page);
      if (
        (await search.inputValue()) !== cronQuery ||
        (await page.locator(".cron-table__row").count()) !== 500 ||
        (await page.locator(".cron-table").getAttribute("aria-busy")) !== "true" ||
        (await gateway.getRequests("cron.list")).length - before !== 1
      ) {
        throw new Error("Expected the typed filter and 500 retained rows with one pending request");
      }
    },
  },
  {
    id: "cron-menu-open",
    route: pathForRoute("cron"),
    expected: "The first of 500 jobs opens its enabled Run if due, Clone, and Remove actions.",
    prepare: prepareCron,
    run: async (page) => {
      const trigger = page.locator(".cron-table__row").first().locator(".cron-job-menu__trigger");
      const menuId = await trigger.getAttribute("aria-controls");
      if (!menuId) {
        throw new Error("Automation action trigger has no menu target");
      }
      await trigger.click();
      const menu = page.locator(`[id=${JSON.stringify(menuId)}][role="menu"]`);
      await menu.waitFor({ state: "visible" });
      for (const name of ["Run if due", "Clone", "Remove"]) {
        const item = menu.getByRole("menuitem", { name, exact: true });
        await item.waitFor({ state: "visible" });
        if (!(await item.isEnabled())) {
          throw new Error(`Automation action is disabled: ${name}`);
        }
      }
      if ((await menu.getByRole("menuitem").count()) !== 3) {
        throw new Error("Expected exactly three automation menu actions");
      }
    },
  },
  ...(["paste", "typing"] as const).map((input): InteractionScenario => ({
    id: input === "paste" ? "cron-search" : "cron-search-typing",
    route: pathForRoute("cron"),
    expected: `${input === "paste" ? "Pasting" : "Typing"} a filter replaces 500 loaded jobs with Warm automation 0499.`,
    prepare: prepareCron,
    run: async (page, gateway) => {
      const requestsBefore = (await gateway.getRequests("cron.list")).length;
      const after = (await gateway.getRequests("cron.list", { query: cronQuery })).length;
      // A single input keeps request coalescing from changing the workload across builds.
      const search = page.getByRole("searchbox", { name: "Search automations" });
      if (input === "paste") {
        await search.fill(cronQuery);
      } else {
        await search.pressSequentially(cronQuery);
      }
      await gateway.waitForRequest("cron.list", { after, match: { query: cronQuery, offset: 0 } });
      await page.locator(".cron-table__row").getByText(cronQuery, { exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelectorAll(".cron-table__row").length === 1);
      if (
        input === "paste" &&
        (await gateway.getRequests("cron.list")).length - requestsBefore !== 1
      ) {
        throw new Error("Expected exactly one automation filter request");
      }
    },
  })),
];

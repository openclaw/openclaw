// Cold direct-route inventory, independent coverage passes, and interleaved A/A/B timings.
// node --import ./scripts/tsx.mjs scripts/bench-control-ui-route-leaks.ts \
//   --bundle-dir BASE --compare-bundle-dir HEAD --mode all --pairs 10 --profiles local,remote
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type CDPSession, type Page } from "playwright";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
} from "../src/gateway/control-ui-bootstrap-contract.ts";
import { createEmptyCostUsageTotals } from "../src/infra/session-cost-usage-totals.ts";
import {
  APP_ROUTE_IDS,
  pathForAgentPanel,
  pathForRoute,
  type RouteId,
} from "../ui/src/app-route-paths.ts";
import {
  createRfbRawFrame,
  installScriptedRfbServer,
} from "../ui/src/e2e/desktop-rfb-test-support.ts";
import { CONFIG_PAGE_IDS } from "../ui/src/pages/config/config-sections.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import {
  controlUiSessionPath,
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  resolvePlaywrightChromiumExecutablePath,
  defaultControlUiFeatureMethods,
  prepareControlUiMockGatewayScenario,
  type ControlUiMockGatewayScenario,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { parityBaseScenario, parityWorkboardScenario } from "./control-ui-parity/fixtures.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { summarizeScriptCoverage } from "./lib/control-ui-cold-load-trace.ts";
import { createInteractionFixture } from "./lib/control-ui-interaction-scenarios.ts";
import {
  captureDockScenario,
  DOCK_SCENARIO_IDS,
  dockAsset,
  dockContextOptions,
  dockFixture,
  dockTarget,
  installDockInputTrace,
  isDockScenario,
  type DockAssetRequest,
  type DockScenarioId,
} from "./lib/control-ui-route-dock-scenarios.ts";
import { qualifyRouteNetworkClock, routeNetworkPhase } from "./lib/control-ui-route-network.ts";
import {
  type ActivityMediaMode,
  activityMediaFixture,
  activityMediaMethods,
  activityMediaTrigger,
  activityLightboxImage,
  waitForActivityMedia,
  waitForActivityLightbox,
  closeActivityLightbox,
} from "./route-leaks-activity-pilot.ts";
import {
  appsGatewayInitScript,
  appsPilotFixture,
  appsPilotTarget,
  appsProbeSnapshot,
  clickFirstAppAndWait,
  isAppsOpenId,
  isAppsPilotId,
  startAppsPilotSandbox,
  verifyFirstAppAndClose,
  waitForAppsCatalog,
  type AppsPilotId,
} from "./route-leaks-apps-pilot.ts";

type ProbeRoute =
  | RouteId
  | "sharing"
  | AppsPilotId
  | "desktop-document"
  | "portal-embedded"
  | "settings-native-root"
  | DockScenarioId;
let appsSandbox: Awaited<ReturnType<typeof startAppsPilotSandbox>> | undefined;

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    routes: { type: "string" },
    interactions: { type: "string" },
    "activity-media": { type: "string" },
    mode: { type: "string", default: "coverage" },
    profiles: { type: "string", default: "local,remote" },
    pairs: { type: "string", default: "10" },
    output: { type: "string" },
    screenshots: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "--bundle-dir BASE [--compare-bundle-dir HEAD] --routes sessions,cron,usage --mode coverage|timing|all --pairs 10 --profiles local,remote [--screenshots] [--output DIR]. Default routes include every Settings section, Sessions, Cron, Agents, Usage, Plugins, Workboard and sharing. Select --routes systems,portals,desktop-document for the optional Desktop probes; they use a scripted RFB endpoint and loaded synthetic portal. portal-embedded navigates Chat and opens its Portal panel through native controls, including iframe readiness and the rail CSS cascade. Optional --interactions agents-files,cron-history,cron-transcript probes follow cold readiness. Security uses --routes advanced with one settings-security-immediate or settings-security-idle interaction. Coverage and timing run in separate fresh contexts; comparison timings include a base/base control. Apps packet aliases: apps-catalog,apps-open-immediate,apps-open-idle. First App opens use real catalog navigation, actual launch/view receipts and the native sandbox; no prior Chat visit or manual preload.",
    "Native Settings root: --routes settings-native-root uses the iOS phone embed at 390x844; do not combine with --interactions.",
    `Browser/Reader cells: ${DOCK_SCENARIO_IDS.join(",")}. Each owns its cold/native first-open phases; do not combine with --interactions.`,
    "Activity media: --routes activity --activity-media empty|gallery; --interactions activity-lightbox opens the viewer after the fixed warmup, activity-lightbox-immediate opens it before artifact analysis, and activity-idle records the warmup without a click.",
  );
  process.exit(0);
}
const pairs = Number(values.pairs);
if (
  !Number.isSafeInteger(pairs) ||
  pairs < 1 ||
  !["coverage", "timing", "all"].includes(values.mode)
) {
  throw new Error("pairs must be positive; mode must be coverage, timing or all");
}
const profileCatalog = [
  { id: "local", latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  { id: "remote", latency: 100, downloadThroughput: 1_250_000, uploadThroughput: 1_250_000 },
];
const profiles = values.profiles.split(",").map((id) => {
  const profile = profileCatalog.find((entry) => entry.id === id);
  if (!profile) {
    throw new Error(`Unknown profile: ${id}`);
  }
  return profile;
});
const defaults = [
  ...new Set([
    "sessions",
    "settings",
    "new-session",
    ...APP_ROUTE_IDS.filter((id) => pathForRoute(id).startsWith("/settings/")),
    "cron",
    "agents",
    "usage",
    "plugins",
    "workboard",
    "talk",
    "sharing",
  ]),
];
const routes = (values.routes?.split(",") ?? defaults).map((id) => {
  if (
    id !== "sharing" &&
    id !== "settings-native-root" &&
    id !== "desktop-document" &&
    id !== "portal-embedded" &&
    !isAppsPilotId(id) &&
    !isDockScenario(id) &&
    !APP_ROUTE_IDS.some((route) => route === id)
  ) {
    throw new Error(`Unknown route: ${id}`);
  }
  return id as ProbeRoute;
});
const appsProbesEnabled = routes.some(isAppsPilotId);
const activityMediaOption = values["activity-media"];
if (
  activityMediaOption !== undefined &&
  activityMediaOption !== "empty" &&
  activityMediaOption !== "gallery"
) {
  throw new Error("activity-media must be empty or gallery");
}
const activityMedia: ActivityMediaMode | undefined = activityMediaOption;
const interactionIds = values.interactions?.split(",") ?? [];
if (routes.includes("settings-native-root") && interactionIds.length) {
  throw new Error("Native Settings root is a cold-only cell; do not combine with --interactions");
}
if (routes.some(isDockScenario) && interactionIds.length) {
  throw new Error(`Dock cells (${DOCK_SCENARIO_IDS.join(",")}) own their native first-open phases`);
}
const securityInteractions = ["settings-security-immediate", "settings-security-idle"];
const knownInteractions = [
  "agents-files",
  "cron-history",
  "cron-transcript",
  "activity-lightbox",
  "activity-idle",
  "activity-lightbox-immediate",
  ...securityInteractions,
];
for (const id of interactionIds) {
  if (!knownInteractions.includes(id)) {
    throw new Error(`Unknown interaction: ${id}; choose ${knownInteractions.join(",")}`);
  }
}
const securityInteraction = interactionIds.find((id) => securityInteractions.includes(id));
if (
  securityInteraction &&
  (interactionIds.length !== 1 || routes.length !== 1 || routes[0] !== "advanced")
) {
  throw new Error(
    "Security navigation requires only --routes advanced and one Security interaction",
  );
}
const activityImmediate = interactionIds.includes("activity-lightbox-immediate");
if (
  interactionIds.includes("activity-idle") &&
  (interactionIds.length !== 1 || routes.length !== 1 || routes[0] !== "activity" || !activityMedia)
) {
  throw new Error(
    "Activity idle requires only --routes activity and --activity-media empty|gallery",
  );
}
if (
  interactionIds.some((id) => id.startsWith("activity-lightbox")) &&
  activityMedia !== "gallery"
) {
  throw new Error("Activity lightbox interactions require --activity-media gallery");
}
if (
  activityImmediate &&
  (interactionIds.length !== 1 || routes.length !== 1 || routes[0] !== "activity")
) {
  throw new Error(
    "Immediate Activity lightbox requires only --routes activity and one interaction",
  );
}
const output = createControlUiE2eArtifactDir("route-leaks", values.output);
const configPages = new Set<string>(CONFIG_PAGE_IDS);
const fields =
  ':is(input:not(:disabled),textarea:not(:disabled),select:not(:disabled),button[role="combobox"]:not(:disabled),[role="switch"]:not([aria-disabled="true"]))';
function routeTarget(
  id: ProbeRoute,
  sessionKey: string,
): {
  route: RouteId | "desktop-document" | "browser-document";
  pathname: string;
  search: string;
  selector: string | undefined;
  requiredMethods?: string[];
} {
  if (id === "settings-native-root") {
    return {
      route: "settings",
      pathname: "/settings",
      search: "",
      selector: '.settings-embed-list a[href="/settings/appearance"]',
    };
  }
  if (isDockScenario(id)) {
    return dockTarget(id);
  }
  if (isAppsPilotId(id)) {
    return appsPilotTarget();
  }
  const route =
    id === "sharing" || id === "settings" || id === "portal-embedded"
      ? "chat"
      : id === "config"
        ? "appearance"
        : id;
  const selectors: Partial<Record<ProbeRoute, string>> = {
    systems: ".systems-desktop .desktop-surface canvas",
    portals: "openclaw-portals-page .portals-preview__frame",
    "portal-embedded": "openclaw-portals-page[embedded] .portals-preview__frame",
    "desktop-document": ".desktop-document .desktop-surface canvas",
    channels: "openclaw-channels-page .channels-item, openclaw-channels-page .channels-empty",
    connection: "openclaw-connection-page .settings-input-with-hint input:not(:disabled)",
    profile:
      "openclaw-profile-page .settings-workspace__body input.settings-toggle__input:not(:disabled), openclaw-profile-page #settings-profile-identity input:not([type=file]):not(:disabled)",
    lobsterdex: "openclaw-lobsterdex-page .lobsterdex-page__card",
    // The browser deliberately renders the native-only explanation on these routes.
    device: "openclaw-device-page .settings-workspace__body .settings-empty",
    "device-permissions":
      "openclaw-device-permissions-page .settings-workspace__body .settings-empty",
    notifications: "openclaw-config-page .settings-section .settings-row__control .settings-status",
    secrets:
      "openclaw-secrets-page .secrets-store__table tbody tr, openclaw-secrets-page .secrets-store__empty, openclaw-secrets-page .settings-section .settings-empty",
    approvals:
      "openclaw-approvals-page .approval-history-table[aria-busy=false] .data-table-empty-state",
    search: 'openclaw-search-page select[aria-label="Search provider"]:not(:disabled)',
    labs: "openclaw-labs-page .settings-section input[role=switch]:not(:disabled)",
    about: "openclaw-about-page .about-hero__links a",
    memory: ".memory-page__panel :is(a.memory-page__link,button:not(:disabled))",
    devices:
      "openclaw-devices-page .device-entry, openclaw-devices-page .settings-section .settings-empty",
    "cloud-workers":
      "openclaw-cloud-workers-page .settings-section .settings-empty, openclaw-cloud-workers-page .settings-section button:not(:disabled)",
    "plugin-settings": "openclaw-plugins-page .plugins-settings-search input:not(:disabled)",
    "skill-settings": "openclaw-skills-page .plugins-item__detail-button",
    sessions: "openclaw-sessions-page .data-table tbody tr:not(.session-skeleton-row) a",
    talk: 'openclaw-config-page textarea[aria-label="Trigger words"]:not(:disabled)',
    cron: "openclaw-cron-page .cron-table__row .cron-table__name, openclaw-cron-page .cron-empty-state:not([data-test-id])",
    // This control stays disabled until the agents roster read settles. Identity writes
    // can remain disabled in an otherwise usable read-only fixture.
    agents: "openclaw-agents-page .agents-refresh-btn:not(:disabled)",
    usage: "openclaw-usage-page .usage-date-input",
    activity: activityMedia === "gallery" ? activityMediaTrigger : ".activity-feed__session",
    workboard: ".workboard button:not(:disabled)",
    plugins:
      "openclaw-plugins-page .plugin-catalog-card:not(.plugin-catalog-card--skeleton), openclaw-plugins-page .plugin-catalog-results__body openclaw-panel-empty-state",
    appearance: "openclaw-config-page .settings-theme-grid [data-theme-id]",
    "model-setup":
      "openclaw-model-setup-page .model-setup__manual :is(input,select,button):not(:disabled), openclaw-model-setup-page .model-setup__row button:not(:disabled), openclaw-model-setup-page .model-setup__recommendation button:not(:disabled)",
    "model-providers":
      "openclaw-model-providers-page .model-providers__provider-list :is(button:not(:disabled),.settings-empty)",
    chat: ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
    "new-session": ".new-session-page__message",
    sharing: ".chat-pane__sharing-panel :is(button,[role=menuitem],[role=menuitemradio])",
  };
  return {
    route,
    pathname:
      id === "desktop-document"
        ? `/focus/desktop/session/${encodeURIComponent(sessionKey)}`
        : id === "sharing" || id === "portal-embedded"
          ? controlUiSessionPath(sessionKey)
          : id === "agents"
            ? pathForAgentPanel("main")
            : pathForRoute(id),
    search:
      id === "model-setup"
        ? "?firstRun=explicit"
        : id === "activity" && activityMedia
          ? "?time=all"
          : "",
    ...(id === "desktop-document"
      ? { requiredMethods: ["sessions.describe", "environments.status", "desktop.observe"] }
      : id === "systems"
        ? {
            requiredMethods: [
              "environments.list",
              "node.list",
              "system.info",
              "backup.status",
              "desktop.observe",
            ],
          }
        : id === "portals" || id === "portal-embedded"
          ? { requiredMethods: ["portal.list"] }
          : {}),
    selector:
      selectors[id] ??
      selectors[route] ??
      (configPages.has(route) ? `openclaw-config-page .settings-section ${fields}` : undefined),
  };
}

function fixtureFor(
  build: { buildId: string; version: string },
  id: ProbeRoute,
  baseUrl: string,
): ControlUiMockGatewayScenario {
  if (isDockScenario(id)) {
    return dockFixture(build, id);
  }
  if (isAppsPilotId(id)) {
    if (!appsSandbox) {
      throw new Error("Apps sandbox was not prepared");
    }
    return appsPilotFixture(fixtureFor(build, "apps", baseUrl), appsSandbox.descriptor);
  }
  const baseFixture = createInteractionFixture(build.buildId, build.version);
  const fixture =
    id === "activity" && activityMedia
      ? activityMediaFixture(baseFixture, activityMedia)
      : baseFixture;
  const workboard = id === "workboard" ? parityWorkboardScenario : {};
  return {
    ...fixture,
    ...workboard,
    ...(id === "settings-native-root"
      ? { automaticallyFetchFavicons: false, operatorScopes: ["operator.admin", "operator.read"] }
      : {}),
    serverBuildId: build.buildId,
    serverVersion: build.version,
    ...(id === "systems" || id === "desktop-document"
      ? { deferredMethods: ["desktop.observe"] }
      : {}),
    ...(id === "profile" || id === "sharing"
      ? { presenceUsers: parityBaseScenario.presenceUsers }
      : {}),
    ...(id === "sharing"
      ? {
          sessions: fixture.sessions.map((session, index) =>
            index === 0
              ? Object.assign({}, session, {
                  sharingRole: "owner" as const,
                  visibility: "shared" as const,
                })
              : session,
          ),
          hasMultipleSessionSharingIdentities: true,
        }
      : {}),
    featureMethods: [
      ...new Set([
        ...(fixture.featureMethods ?? defaultControlUiFeatureMethods),
        ...(workboard.featureMethods ?? []),
        ...(id === "sharing" ? ["session.visibility.set", "session.members.listEvidence"] : []),
        ...(id === "profile" || id === "sharing" ? ["users.self", "users.list"] : []),
        ...(id === "secrets" ? ["secrets.store.list"] : []),
        ...(id === "portals" || id === "portal-embedded" ? ["portal.list"] : []),
        ...(id === "systems" || id === "desktop-document"
          ? [
              "desktop.observe",
              "environments.list",
              "environments.status",
              "node.list",
              "system.info",
              "backup.status",
            ]
          : []),
        ...(id === "search" ? ["webSearch.status"] : []),
        ...(id === "model-setup" ? ["openclaw.setup.detect"] : []),
        ...(id === "cron" && interactionIds.length ? ["cron.history"] : []),
        ...(id === "activity" && activityMedia ? activityMediaMethods : []),
      ]),
    ],
    methodResponses: {
      ...fixture.methodResponses,
      "config.schema": parityBaseScenario.methodResponses?.["config.schema"],
      ...(id === "portals" || id === "portal-embedded"
        ? {
            "portal.list": {
              portals: [
                {
                  id: "route-probe",
                  title: "Route probe portal",
                  port: 3000,
                  listenPort: 3000,
                  tokenQuery: "openclaw_portal=synthetic",
                  createdAtMs: 1,
                  publicUrl: `${baseUrl}/route-probe-portal/`,
                  url: `${baseUrl}/route-probe-portal/?openclaw_portal=synthetic`,
                },
              ],
            },
          }
        : {}),
      ...(id === "systems" || id === "desktop-document"
        ? {
            "desktop.observe": {
              transport: "rfb",
              wsPath: "/desktop/observe?token=route-probe",
              expiresAtMs: 60_000,
              control: false,
            },
            "environments.status": {
              id: "gateway",
              type: "local",
              label: "Synthetic Gateway",
              status: "available",
              desktop: true,
            },
            "node.list": { nodes: [] },
            "backup.status": { targets: [], schedules: [], locations: [] },
          }
        : {}),
      ...(id === "desktop-document"
        ? {
            "sessions.describe": {
              session: { ...fixture.sessions[0], placement: { state: "local" } },
            },
          }
        : {}),
      ...(id === "profile" || id === "sharing"
        ? {
            "users.self": parityBaseScenario.methodResponses?.["users.self"],
            "users.list": parityBaseScenario.methodResponses?.["users.list"],
          }
        : {}),
      ...(id === "secrets" ? { "secrets.store.list": { entries: [] } } : {}),
      ...(id === "talk" ? { "voicewake.get": { triggers: ["OpenClaw"] } } : {}),
      ...(id === "approvals"
        ? {
            "approval.history": { items: [] },
            "exec.approval.grants.list": { grants: [] },
          }
        : {}),
      ...(id === "search"
        ? { "webSearch.status": parityBaseScenario.methodResponses?.["webSearch.status"] }
        : {}),
      ...(id === "model-setup"
        ? {
            "openclaw.setup.detect": {
              candidates: [],
              manualProviders: [
                {
                  id: "openai-api-key",
                  brandId: "openai",
                  groupLabel: "OpenAI",
                  label: "OpenAI API key",
                },
              ],
              prepareOptions: [],
              authOptions: [],
              setupComplete: false,
              workspace: "/synthetic/workspace",
            },
          }
        : {}),
      "sessions.usage": {
        updatedAt: 1_800_000_000_000,
        startDate: "2026-10-01",
        endDate: "2026-10-25",
        sessions: [],
        totals: createEmptyCostUsageTotals(),
        aggregates: {
          messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
          tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
          byModel: [],
          byProvider: [],
          byAgent: [],
          byChannel: [],
          costDaily: [],
          modelDaily: [],
          daily: [],
        },
      },
      "node.list": { nodes: [] },
      ...(id === "devices"
        ? {
            "device.pair.list": { pending: [], paired: [] },
            "exec.approvals.get": { hash: "route-leaks", file: { version: 1 } },
            "system-presence": [],
          }
        : {}),
      "backup.status": { targets: [], schedules: [], locations: [] },
      ...(id === "systems"
        ? {
            "environments.list": {
              environments: [
                {
                  id: "gateway",
                  type: "local",
                  label: "Synthetic Gateway",
                  status: "available",
                  desktop: true,
                },
              ],
              profiles: [],
            },
            "system.info": parityBaseScenario.methodResponses?.["system.info"],
          }
        : {}),
      ...(id === "agents" && interactionIds.includes("agents-files")
        ? {
            "agents.files.list": {
              agentId: "main",
              workspace: "/synthetic/workspace",
              files: [
                { name: "AGENTS.md", path: "/synthetic/workspace/AGENTS.md", missing: false },
              ],
            },
            "agents.files.get": {
              agentId: "main",
              workspace: "/synthetic/workspace",
              file: {
                name: "AGENTS.md",
                path: "/synthetic/workspace/AGENTS.md",
                missing: false,
                content: "# Synthetic agent instructions\nInspect the requested change.",
              },
            },
          }
        : {}),
      ...(id === "cron" && interactionIds.some((value) => value.startsWith("cron-"))
        ? {
            "cron.runs": {
              entries: [
                {
                  ts: 1_800_000_000_000,
                  jobId: "interaction-job-0",
                  jobName: "Warm automation 0000",
                  action: "finished",
                  status: "ok",
                  runId: "route-leaks-run",
                  runAtMs: 1_800_000_000_000,
                  durationMs: 120,
                  summary: "Synthetic completed automation.",
                },
              ],
              total: 1,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.history": {
              messages: [
                {
                  role: "user",
                  content: "Inspect this synthetic automation.",
                  timestamp: 1_800_000_000_000,
                },
                {
                  role: "assistant",
                  content: "Synthetic route transcript ready.",
                  timestamp: 1_800_000_000_120,
                },
              ],
            },
          }
        : {}),
      ...workboard.methodResponses,
    },
  };
}
async function readBuild(directory: string) {
  const root = path.resolve(directory);
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const raw = /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su.exec(html)?.[1];
  if (!raw) {
    throw new Error(`Missing production build identity: ${root}`);
  }
  const build: { buildId: string; version: string } = JSON.parse(raw);
  const descriptor = /id="openclaw-navigation-preloads" content="([^"]+)"/u.exec(html)?.[1];
  const navigationPreloads: Record<string, string[]> =
    interactionIds.length && descriptor
      ? JSON.parse(await readFile(path.join(root, descriptor), "utf8"))
      : {};
  return {
    root,
    build,
    indexSha256: createHash("sha256").update(html).digest("hex"),
    nextPreloads: Object.fromEntries(
      ["agents-next", "cron-next", "activity-next"].map((key) => [
        key,
        navigationPreloads[key] ?? [],
      ]),
    ),
  };
}
const base = await readBuild(values["bundle-dir"]);
const head = values["compare-bundle-dir"]
  ? await readBuild(values["compare-bundle-dir"])
  : undefined;
const variants = [
  { id: "base", ...base },
  ...(head
    ? [
        { id: "control", ...base },
        { id: "head", ...head },
      ]
    : []),
];
type AssetRequest = DockAssetRequest;
type CoverageEntry = Awaited<ReturnType<Page["coverage"]["stopJSCoverage"]>>[number];
const evaluatedUrls = (entries: CoverageEntry[]) =>
  entries
    .filter((entry) =>
      entry.functions.some((fn) =>
        fn.ranges.some((range) => range.startOffset === 0 && range.count > 0),
      ),
    )
    .map((entry) => entry.url);
type InteractionResult = { id: string; error?: string; [key: string]: unknown };
type Result = {
  variant: string;
  route: string;
  mode: string;
  profile: string;
  pair: number;
  error?: string;
  readyMs?: number;
  cpu?: Record<string, number>;
  interactions?: InteractionResult[];
  [key: string]: unknown;
};
const results: Result[] = [];
async function save() {
  const summaries = [];
  const quantile = (numbers: number[], q: number) =>
    numbers.toSorted((a, b) => a - b)[Math.ceil(numbers.length * q) - 1];
  for (const variant of variants) {
    for (const route of routes) {
      for (const profile of profiles) {
        const samples = results.filter(
          (r) =>
            r.variant === variant.id &&
            r.route === route &&
            r.profile === profile.id &&
            r.mode === "timing" &&
            !r.error,
        );
        if (!samples.length) {
          continue;
        }
        summaries.push({
          variant: variant.id,
          route,
          profile: profile.id,
          samples: samples.length,
          ...Object.fromEntries(
            ["readyMs", "taskMs", "scriptMs"].map((metric) => {
              const cells = samples.map((r) =>
                metric === "readyMs" ? r.readyMs! : r.cpu![metric]!,
              );
              return [
                metric,
                {
                  median: quantile(cells, 0.5),
                  p95: quantile(cells, 0.95),
                  min: Math.min(...cells),
                  max: Math.max(...cells),
                },
              ];
            }),
          ),
        });
      }
    }
  }
  await writeFile(
    path.join(output, "summary.json"),
    JSON.stringify(
      {
        workload:
          "cold direct navigation; real production HTTP assets, synthetic in-document WebSocket Gateway; portal-embedded includes Chat navigation and native Portal panel activation; Agents/Cron interactions use a minimum2,000ms think time, Apps immediate has no intentional wait and Apps idle has a minimum2,000ms wait without manual preloading; Activity warmed/idle cells use the fixed minimum2000ms wait, and Activity immediate has no intentional delay",
        instrumentation:
          "Timing uses renderer-main-frame threadTicks without coverage. Optional interaction wallMs/CPU are automation-to-ready intervals after cold capture, not INP; evaluatedScriptUrls uses positive top-level V8 ranges. Parsed scripts without execution are reported separately. Import references are regex-extracted chunk references, not a complete source import graph. V8 coverage also belongs to the page target; workerUrls records any dedicated-worker coverage/network-emulation gap. Coverage is a separate pass bounded by usable route readiness and includes requested preloads absent from V8 as unexecuted. requestedRawBytes counts the full source of requested files; loadedBytes includes only completed/evaluated files. pendingJsRequests identifies incomplete transfer accounting, and jsResources contains completed Resource Timing entries. Remote emulates 100ms HTTP latency and 10Mbps; synthetic WS has no simulated RTT. Workboard plugin fixture is built from the current checkout and held identical across bundle variants; its bytes are reported separately from UI-bundle code. Ready requires route success and a visible enabled page control, then one animation frame. Security navigation additionally requires the checked/enabled Browser control and all four enabled tool profiles, with no fixture override selected; config/schema receipt counts must stay unchanged. Security before/after observations have their own timestamps, and no hover/focus/import or artificial preload precedes its native click. Its readinessToActionMs records observation overhead; coverage and screenshots are written after its action. Sharing includes opening the menu after the chat becomes usable. Apps first-open cells trigger before cold summarization/screenshot/file work; immediate has no intentional delay, idle has a native minimum2000ms from cold readiness without manual warming. Each cell starts a fresh context, with base eager imports observed naturally. Phase network data retains raw CDP MonotonicTime timestamps and the actual NavigationStart metric; RPC method counts use direct same-document performance.now. Native counter/Close assertions happen after first-open CPU cutoff. Cold-plus-first-open elapsed includes the idle interval and automation gap and does not waive any individual regression. Page-target V8/CPU excludes inner App and worker execution; frame URLs retain that scope gap. Matching Agents/Cron/warmed Activity interactions give every variant the same minimum 2,000 ms idle interval before expected-preload verification. interactionWarmup CPU/wall and Activity network stop before verification polling; preloadVerification records additional wall/CPU and Activity network through confirmed completion. Total warm cost includes both intervals. Completion verification can extend readiness-to-action time. Cold-only and sharing runs have no think-time delay. Activity media cold cells retain raw request/finish/failure timestamps, reconstruct network state at actual NavigationStart plus same-document readiness, and require matched Resource Timing start/end residuals within5ms before totals. Activity RPC counts are snapshots after readiness, not a cutoff-filtered timeline. Immediate Activity opens before artifact analysis/screenshots and records readiness-to-action overhead; warmed Activity verifies preload completion and non-evaluation before the native click.",
        acceptance:
          "A measured real-scenario win of at least 5%; no median readiness regression over 5% or worse p95 unless an A/A control attributes the movement to host noise. On a noisy host, run 20 interleaved pairs and judge affected threadTicks CPU plus structural byte/request counts. Coverage-instrumented timings are diagnostic only.",
        buildVariants: variants,
        routes,
        interactions: interactionIds,
        activityMedia: activityMedia ?? null,
        profiles,
        pairs,
        summaries,
        results,
      },
      null,
      2,
    ),
  );
}
async function metrics(cdp: CDPSession) {
  const response = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(response.metrics.map(({ name, value }) => [name, value]));
}

function cpuDelta(before: Record<string, number>, after: Record<string, number>) {
  return Object.fromEntries(
    (
      [
        ["taskMs", "TaskDuration", 1_000],
        ["scriptMs", "ScriptDuration", 1_000],
        ["layoutMs", "LayoutDuration", 1_000],
        ["styleMs", "RecalcStyleDuration", 1_000],
        ["layoutCount", "LayoutCount", 1],
        ["recalcStyleCount", "RecalcStyleCount", 1],
      ] as const
    ).map(([name, metric, scale]) => {
      const first = before[metric],
        last = after[metric];
      if (!Number.isFinite(first) || !Number.isFinite(last) || last! < first!) {
        throw new Error(`Invalid threadTicks metric: ${metric}`);
      }
      return [name, scale * (last! - first!)];
    }),
  );
}

async function summarizeCoverage(
  coverage: CoverageEntry[],
  requests: AssetRequest[],
  root: string,
  assets: Awaited<ReturnType<typeof prepareControlUiMockGatewayScenario>>["assets"],
) {
  const scripts = await Promise.all(
    requests.map(async (request) => {
      const relative = new URL(request.url).pathname.replace(/^\//u, "");
      const filename = path.resolve(root, relative);
      if (!filename.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Outside bundle: ${relative}`);
      }
      const pluginAsset = assets.get(new URL(request.url).pathname);
      const source = pluginAsset
        ? pluginAsset.body.toString("utf8")
        : await readFile(filename, "utf8");
      const entries = coverage.filter((entry) => entry.url === request.url);
      const counts = summarizeScriptCoverage({
        source,
        functions: entries.flatMap((entry) => entry.functions),
      });
      let sources: string[] = [];
      try {
        sources = pluginAsset ? [] : JSON.parse(await readFile(`${filename}.map`, "utf8")).sources;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      const imports = [
        ...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+\.m?js)["']/gu),
      ].map((match) => new URL(match[1]!, request.url).pathname);
      return {
        filename: relative,
        pluginFixture: Boolean(pluginAsset),
        loadedBytes: counts.loadedBytes,
        executedBytes: counts.executedBytes,
        unusedBytes: counts.unusedBytes,
        observedByV8: entries.length > 0,
        evaluated: counts.executedBytes > 0,
        networkComplete: request.wireBytes !== undefined,
        sources,
        routeModules: sources.filter((name) => /(?:ui\/src|\.\.)\/pages\//u.test(name)),
        imports,
      };
    }),
  );
  const loaded = scripts.filter((item) => item.networkComplete || item.evaluated);
  return {
    scripts,
    requestedRawBytes: scripts.reduce((sum, item) => sum + item.loadedBytes, 0),
    loadedBytes: loaded.reduce((sum, item) => sum + item.loadedBytes, 0),
    executedBytes: scripts.reduce((sum, item) => sum + item.executedBytes, 0),
    unusedBytes: loaded.reduce((sum, item) => sum + item.unusedBytes, 0),
  };
}

async function runSecurityNavigation(
  page: Page,
  cdp: CDPSession,
  id: string,
  mode: string,
  readyMs: number,
  requests: Map<string, AssetRequest>,
  prefix: string,
  coldCoverage: CoverageEntry[] = [],
): Promise<InteractionResult> {
  const observe = () =>
    page.evaluate(() => ({
      observedAtMs: performance.now(),
      modulePreloads: [
        ...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'),
      ].map((link) => link.href),
      resources: performance.getEntriesByType("resource").map((entry) => {
        const resource = entry as PerformanceResourceTiming;
        return {
          url: resource.name,
          initiatorType: resource.initiatorType,
          responseEnd: resource.responseEnd,
          encodedBytes: resource.encodedBodySize,
          rawBytes: resource.decodedBodySize,
        };
      }),
      rpc: (window as MockGatewayWindow).openclawControlUiE2eGateway
        ?.findRequests()
        .reduce<Record<string, number>>((counts, request) => {
          counts[request.method] = (counts[request.method] ?? 0) + 1;
          return counts;
        }, {}),
    }));
  const minimumThinkTimeMs = id.endsWith("-idle") ? 2_000 : 0;
  let idleCoverage: CoverageEntry[] | undefined;
  let idleCpu: Record<string, number> | undefined;
  if (minimumThinkTimeMs) {
    const beforeIdle = await metrics(cdp);
    if (mode === "coverage") {
      await page.coverage.startJSCoverage({
        resetOnNavigation: false,
        reportAnonymousScripts: false,
      });
    }
    await page.evaluate(async (until) => {
      const remaining = until - performance.now();
      if (remaining > 0) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, remaining);
        });
      }
    }, readyMs + minimumThinkTimeMs);
    idleCoverage = mode === "coverage" ? await page.coverage.stopJSCoverage() : undefined;
    idleCpu = cpuDelta(beforeIdle, await metrics(cdp));
  }
  // Observe without focusing, hovering, importing, or warming the destination.
  const beforeAction = await observe();
  const prior = new Map(Array.from(requests, ([key, request]) => [key, { ...request }]));
  if (mode === "coverage") {
    await page.coverage.startJSCoverage({
      resetOnNavigation: false,
      reportAnonymousScripts: false,
    });
  }
  const before = await metrics(cdp);
  const started = await page.evaluate(() => performance.now());
  await page.locator(`a.settings-sidebar__item[href="${pathForRoute("security")}"]`).click();
  await page.waitForFunction(() => {
    const snapshot = window.openclawControlUi?.snapshot();
    const root = document.querySelector(".security-page");
    const rows = [...(root?.querySelectorAll(".settings-row") ?? [])];
    const browser = rows.find(
      (row) => row.querySelector(".settings-row__title")?.textContent?.trim() === "Browser enabled",
    );
    const tools = rows.find(
      (row) => row.querySelector(".settings-row__title")?.textContent?.trim() === "Available tools",
    );
    const toolProfiles = [
      ...(tools?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []),
    ];
    const visible = (node: Element | undefined) =>
      Boolean(node?.getClientRects().length && getComputedStyle(node).visibility !== "hidden");
    return (
      snapshot?.routeReady &&
      snapshot.route?.status === "success" &&
      snapshot.route.matches[0]?.routeId === "security" &&
      snapshot.route.pendingMatches.length === 0 &&
      visible(browser) &&
      visible(tools) &&
      browser?.querySelector(
        'input[type="checkbox"]:checked:not(:disabled):not([aria-disabled="true"])',
      ) &&
      toolProfiles.map((input) => input.value).join(",") === "minimal,coding,messaging,full" &&
      toolProfiles.every(
        (input) =>
          !input.checked && !input.disabled && input.getAttribute("aria-disabled") !== "true",
      )
    );
  });
  const ended = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() => resolve(performance.now()));
      }),
  );
  const atEnd = Array.from(requests.values(), (request) => ({ ...request }));
  const coverage = mode === "coverage" ? await page.coverage.stopJSCoverage() : undefined;
  const cpu = cpuDelta(before, await metrics(cdp));
  const afterAction = await observe();
  for (const method of ["config.get", "config.schema"]) {
    const beforeReads = beforeAction.rpc?.[method] ?? 0;
    const afterReads = afterAction.rpc?.[method] ?? 0;
    if (beforeReads !== 1 || afterReads !== beforeReads) {
      throw new Error(
        `Security navigation changed ${method} receipts: ${beforeReads} -> ${afterReads}`,
      );
    }
  }
  const alerts = await page.locator('[role="alert"]:visible').allTextContents();
  if (alerts.length) {
    throw new Error(`Security navigation visible alerts: ${alerts.join("; ")}`);
  }
  if (idleCoverage) {
    await writeFile(
      path.join(output, `${prefix}-${id}-idle-v8.json`),
      JSON.stringify(idleCoverage),
    );
  }
  if (coverage) {
    await writeFile(path.join(output, `${prefix}-${id}-v8.json`), JSON.stringify(coverage));
  }
  return {
    id,
    targetRoute: "security",
    minimumThinkTimeMs,
    coldReadyMs: readyMs,
    coldEvaluatedScriptUrls: evaluatedUrls(coldCoverage),
    idleCpu,
    idleEvaluatedScriptUrls: idleCoverage ? evaluatedUrls(idleCoverage) : undefined,
    beforeAction,
    afterAction,
    actionStartedMs: started,
    readinessToActionMs: started - readyMs,
    wallMs: ended - started,
    cpu,
    jsRequestsBeforeAction: [...prior.values()].filter((request) =>
      /\.m?js$/u.test(new URL(request.url).pathname),
    ),
    newJsRequests: atEnd.filter(
      (request) => !prior.has(request.requestId) && /\.m?js$/u.test(new URL(request.url).pathname),
    ),
    previousPendingCompleted: atEnd.filter(
      (request) =>
        prior.has(request.requestId) &&
        prior.get(request.requestId)!.wireBytes === undefined &&
        request.wireBytes !== undefined,
    ),
    evaluatedScriptUrls: coverage ? evaluatedUrls(coverage) : undefined,
  };
}

console.info("[route-leaks] starting production HTTP server");
const server = await startControlUiBenchGatewayServer(base.root);
console.info(`[route-leaks] HTTP ready: ${server.baseUrl}; launching isolated browser`);
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  if (appsProbesEnabled) {
    appsSandbox = await startAppsPilotSandbox();
  }
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    headless: true,
  });
  console.info(`[route-leaks] browser ready: ${browser.version()}`);
  for (const mode of values.mode === "all" ? ["coverage", "timing"] : [values.mode]) {
    for (const profile of profiles) {
      for (let pair = 0; pair < (mode === "timing" ? pairs : 1); pair++) {
        const ordered = (pair % 2 ? variants.toReversed() : variants).filter(
          (v) => mode !== "coverage" || v.id !== "control",
        );
        const orderedRoutes = [
          ...routes.slice(pair % routes.length),
          ...routes.slice(0, pair % routes.length),
        ];
        for (const route of orderedRoutes) {
          for (const variant of ordered) {
            console.info(
              `[route-leaks] ${mode}/${profile.id}/${route}/${variant.id}/${pair}: preparing fresh context`,
            );
            await server.selectBuild(variant.root);
            const context = await browser.newContext({
              viewport: { width: 1440, height: 1000 },
              ...(route === "settings-native-root"
                ? { viewport: { width: 390, height: 844 }, hasTouch: true, locale: "en-US" }
                : {}),
              ...(isDockScenario(route) ? dockContextOptions(route) : {}),
              serviceWorkers: "block",
            });
            const page = await context.newPage();
            const prefix = `${mode}-${profile.id}-${route}-${variant.id}-${pair}`;
            const errors: string[] = [];
            const hostLoad = loadavg();
            page.on("pageerror", (error) => errors.push(error.message));
            const result: Result = {
              mode,
              profile: profile.id,
              route,
              variant: variant.id,
              pair,
              hostLoad,
            };
            let pendingColdCoverage: CoverageEntry[] | undefined;
            let abortAfterContext = false;
            try {
              console.info(`[route-leaks] ${prefix}: preparing synthetic fixture`);
              const prepared = await prepareControlUiMockGatewayScenario(
                fixtureFor(variant.build, route, server.baseUrl),
              );
              const fixture = prepared.scenario;
              const bootstrapPayload = JSON.stringify(createControlUiMockBootstrapConfig(fixture));
              server.setFixtureReader((pathname) =>
                pathname === CONTROL_UI_BOOTSTRAP_CONFIG_PATH
                  ? { body: bootstrapPayload, contentType: "application/json" }
                  : (route === "portals" || route === "portal-embedded") &&
                      pathname === "/route-probe-portal/"
                    ? {
                        body: '<!doctype html><title>Route probe portal</title><h1 data-route-probe-portal>Route probe portal</h1><button type="button">Ready</button>',
                        contentType: "text/html",
                      }
                    : ((isDockScenario(route) ? dockAsset(route, pathname) : undefined) ??
                      prepared.assets.get(pathname)),
              );
              const target = routeTarget(route, fixture.sessionKey!);
              result.target = target;
              if (!target.selector) {
                result.gap =
                  "No verified page-content readiness selector; not counted as a successful route measurement";
                throw new Error(String(result.gap));
              }
              await page.addInitScript("globalThis.__name = (fn) => fn");
              if (route === "settings-native-root") {
                await page.addInitScript(() => {
                  Object.assign(window, {
                    __OPENCLAW_NATIVE_EMBED__: { platform: "ios", formFactor: "phone" },
                  });
                });
              }
              if (isDockScenario(route)) {
                await page.addInitScript(installDockInputTrace);
              }
              const gatewayInit = createControlUiMockGatewayInitScript(fixture);
              await page.addInitScript({
                content:
                  isAppsPilotId(route) || (appsProbesEnabled && route === "memory")
                    ? appsGatewayInitScript(gatewayInit)
                    : gatewayInit,
              });
              await page.addInitScript(
                ({ attribute, bootstrap }) => {
                  const apply = () => {
                    if (!document.documentElement) {
                      return false;
                    }
                    document.documentElement.setAttribute(attribute, bootstrap);
                    return true;
                  };
                  if (!apply()) {
                    const observer = new MutationObserver(() => {
                      if (apply()) {
                        observer.disconnect();
                      }
                    });
                    observer.observe(document, { childList: true });
                  }
                },
                {
                  attribute: CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
                  bootstrap: bootstrapPayload,
                },
              );
              const cdp = await context.newCDPSession(page);
              await cdp.send("Network.enable");
              await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
              await cdp.send("Network.emulateNetworkConditions", {
                offline: false,
                latency: profile.latency,
                downloadThroughput: profile.downloadThroughput,
                uploadThroughput: profile.uploadThroughput,
              });
              await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
              const requests = new Map<string, AssetRequest>();
              cdp.on("Network.requestWillBeSent", (event) =>
                requests.set(event.requestId, {
                  requestId: event.requestId,
                  url: event.request.url,
                  type: event.type ?? "",
                  initiator: event.initiator,
                  timestampSeconds: event.timestamp,
                }),
              );
              cdp.on("Network.responseReceived", (event) => {
                const request = requests.get(event.requestId);
                if (request) {
                  request.status = event.response.status;
                }
              });
              cdp.on("Network.loadingFinished", (event) => {
                const request = requests.get(event.requestId);
                if (request) {
                  request.wireBytes = event.encodedDataLength;
                  request.finishedTimestampSeconds = event.timestamp;
                }
              });
              cdp.on("Network.loadingFailed", (event) => {
                const request = requests.get(event.requestId);
                if (request) {
                  request.failed = event.errorText;
                  request.failedTimestampSeconds = event.timestamp;
                }
              });
              if (mode === "coverage") {
                await page.coverage.startJSCoverage({
                  resetOnNavigation: false,
                  reportAnonymousScripts: false,
                });
              }
              console.info(`[route-leaks] ${prefix}: navigating`);
              const before = await metrics(cdp);
              await page.goto(`${server.baseUrl}${target.pathname}${target.search}`, {
                waitUntil: "domcontentloaded",
              });
              if (isDockScenario(route)) {
                await captureDockScenario({
                  id: route,
                  mode: mode as "coverage" | "timing",
                  page,
                  cdp,
                  requests,
                  before,
                  output,
                  prefix,
                  screenshots: values.screenshots,
                  result,
                  metrics,
                  cpuDelta,
                  summarize: (coverage, phaseRequests) =>
                    summarizeCoverage(coverage, phaseRequests, variant.root, prepared.assets),
                });
                if (errors.length) {
                  throw new Error(errors.join("\n"));
                }
                continue;
              }
              if (route === "systems" || route === "desktop-document") {
                const rfb = await installScriptedRfbServer(page);
                await page.waitForFunction(
                  () =>
                    ((window as MockGatewayWindow).openclawControlUiE2eGateway?.findRequests(
                      "desktop.observe",
                    ).length ?? 0) > 0,
                );
                await page.evaluate(() =>
                  (window as MockGatewayWindow).openclawControlUiE2eGateway?.resolveDeferred(
                    "desktop.observe",
                  ),
                );
                await page.waitForFunction(
                  () =>
                    (window as typeof window & { desktopRfbEvents?: () => string[] })
                      .desktopRfbEvents?.()
                      .includes("authenticated:1") === true,
                );
                await rfb.send([createRfbRawFrame()]);
              }
              if (route === "sharing") {
                await page
                  .locator(".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea")
                  .waitFor();
                await page.locator(".chat-pane__sharing-trigger").click();
              }
              if (isAppsPilotId(route)) {
                await waitForAppsCatalog(page);
              }
              if (route === "portal-embedded") {
                const pane = page.locator(".chat-pane-cache__pane--active");
                await pane.locator(".agent-chat__composer-combobox textarea").waitFor();
                const toggle = pane
                  .locator(".sidebar-region__panels-toggle")
                  .getByRole("button", { name: "Panels", exact: true });
                if ((await toggle.getAttribute("aria-expanded")) !== "true") {
                  await toggle.click();
                }
                const launcher = pane.locator(".side-panel-launcher");
                const newTab = pane
                  .locator('[data-region-header="side"]')
                  .getByRole("button", { name: "New tab", exact: true });
                await launcher.or(newTab).filter({ visible: true }).first().waitFor();
                if (!(await launcher.isVisible())) {
                  await newTab.click();
                }
                await launcher
                  .getByRole("button")
                  .filter({
                    has: page
                      .getByText("Portal", { exact: true })
                      .and(page.locator(".side-panel-type-option__label")),
                  })
                  .click();
              }
              await page.waitForFunction(
                ({ routeId, probeRoute, selector, requiredMethods }) => {
                  const snapshot = window.openclawControlUi?.snapshot();
                  const approvalsSettled =
                    routeId !== "approvals" ||
                    (document
                      .querySelector(
                        ".approval-history-table[aria-busy=false] .data-table-empty-state",
                      )
                      ?.textContent?.trim() ===
                      "No resolved approvals in the rolling 30-day window." &&
                      document
                        .querySelector(".standing-grants-table .data-table-empty-state")
                        ?.textContent?.trim() ===
                        "No standing grants. Answer an automation approval with Always allow to mint one.");
                  // SAFETY: Every measured page receives this fixture before navigation.
                  const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
                  const desktopSettled =
                    (routeId !== "systems" && routeId !== "desktop-document") ||
                    (() => {
                      const panel = document.querySelector("openclaw-desktop-panel");
                      const canvas =
                        panel?.querySelector<HTMLCanvasElement>(".desktop-surface canvas");
                      const pixel = canvas?.getContext("2d")?.getImageData(0, 0, 1, 1).data;
                      const desktopRequests = gateway?.findRequests("desktop.observe") ?? [];
                      const source = desktopRequests[0]?.params as
                        | { source?: { kind?: string }; control?: boolean }
                        | undefined;
                      return (
                        pixel?.join(",") === "24,180,160,255" &&
                        source?.source?.kind === "host" &&
                        source?.control === false &&
                        panel?.querySelector('button[aria-label="Take control"]:not(:disabled)') !==
                          null
                      );
                    })();
                  const portalSettled =
                    (probeRoute !== "portals" && probeRoute !== "portal-embedded") ||
                    (() => {
                      const frame =
                        document.querySelector<HTMLIFrameElement>(".portals-preview__frame");
                      return (
                        frame?.contentDocument?.querySelector("[data-route-probe-portal]")
                          ?.textContent === "Route probe portal" &&
                        frame.contentDocument.querySelector("button:not(:disabled)") !== null
                      );
                    })();
                  const nativeSettingsSettled =
                    probeRoute !== "settings-native-root" ||
                    (() => {
                      const rows = [...document.querySelectorAll(".settings-embed-list a")];
                      return (
                        document.querySelector("html.openclaw-native-embed .shell--embed") !==
                          null &&
                        document.querySelector(
                          ".native-embed-header openclaw-settings-save-indicator",
                        ) !== null &&
                        rows.length > 0 &&
                        rows.every(
                          (row) =>
                            row.getClientRects().length > 0 &&
                            getComputedStyle(row).visibility !== "hidden" &&
                            row.getBoundingClientRect().height >= 44,
                        ) &&
                        document.querySelector(
                          ".shell-nav, openclaw-app-topbar, .shell-chrome-controls, openclaw-macos-titlebar-controls",
                        ) === null &&
                        document.documentElement.scrollWidth <= innerWidth
                      );
                    })();
                  const portalRailSettled =
                    probeRoute !== "portal-embedded" ||
                    (() => {
                      const identity = document.querySelector(
                        "openclaw-portals-page[embedded] .portals-embedded__identity",
                      );
                      if (!identity) {
                        return false;
                      }
                      const style = getComputedStyle(identity);
                      return style.display === "grid" && style.gap === "3px";
                    })();
                  return (
                    desktopSettled &&
                    portalSettled &&
                    portalRailSettled &&
                    nativeSettingsSettled &&
                    approvalsSettled &&
                    (routeId === "desktop-document" ||
                      (snapshot?.routeReady &&
                        snapshot.route?.status === "success" &&
                        snapshot.route.matches[0]?.routeId === routeId &&
                        snapshot.route.pendingMatches.length === 0)) &&
                    requiredMethods.every(
                      (method) => (gateway?.findRequests(method).length ?? 0) > 0,
                    ) &&
                    [...document.querySelectorAll<HTMLElement>(selector)].some(
                      (node) =>
                        node.getClientRects().length &&
                        getComputedStyle(node).visibility !== "hidden" &&
                        !node.matches(":disabled,[aria-disabled=true]"),
                    )
                  );
                },
                {
                  routeId: target.route,
                  probeRoute: route,
                  selector: target.selector,
                  requiredMethods: target.requiredMethods ?? [],
                },
                { timeout: 30_000, polling: "raf" },
              );
              if (route === "activity" && activityMedia) {
                await waitForActivityMedia(page, activityMedia);
              }
              const readyMs = await page.evaluate(
                () =>
                  new Promise<number>((resolve) => {
                    requestAnimationFrame(() => resolve(performance.now()));
                  }),
              );
              // Freeze observed transfer state before stopping coverage or reading artifacts.
              const observedRequestsAtReady = Array.from(requests.values(), (request) =>
                Object.assign({}, request),
              );
              const coverageAtReady =
                mode === "coverage" ? await page.coverage.stopJSCoverage() : undefined;
              pendingColdCoverage = coverageAtReady;
              const after = await metrics(cdp);
              const observedAfterReady = Array.from(requests.values(), (request) =>
                Object.assign({}, request),
              );
              const activityCutoff = after.NavigationStart! + readyMs / 1_000;
              const requestsAtReady =
                route === "activity" && activityMedia
                  ? observedAfterReady
                      .filter((request) => request.timestampSeconds! <= activityCutoff)
                      .map((request) => {
                        const item = Object.assign({}, request);
                        if ((item.finishedTimestampSeconds ?? Infinity) > activityCutoff) {
                          delete item.finishedTimestampSeconds;
                          delete item.wireBytes;
                        }
                        if ((item.failedTimestampSeconds ?? Infinity) > activityCutoff) {
                          delete item.failedTimestampSeconds;
                          delete item.failed;
                        }
                        return item;
                      })
                  : observedRequestsAtReady;
              if (route === "activity" && activityMedia) {
                result.observedRequestsAtReady = observedRequestsAtReady;
                result.observedRequestsAfterReady = observedAfterReady;
                result.phaseClockEvidence = {
                  navigationStart: after.NavigationStart,
                  coldMetricTimestamp: after.Timestamp,
                  sameDocumentCutoffMs: readyMs,
                  rawCutoffSeconds: activityCutoff,
                };
              }
              result.jsRequestsColdCapture = requestsAtReady.filter((request) =>
                /\.m?js$/u.test(new URL(request.url).pathname),
              );
              result.readyMs = readyMs;
              result.workerUrls = page.workers().map((worker) => worker.url());
              if (coverageAtReady) {
                result.coverageStopObservedMs = await page.evaluate(() => performance.now());
              }
              result.cpu = cpuDelta(before, after);
              result.target = target;
              result.errors = errors;
              // First App opens happen before cold summaries, screenshots, or file writes.
              // Each route/variant already owns a fresh browser context: never visit Chat first.
              let appsFirstAction: InteractionResult | undefined;
              if (isAppsOpenId(route)) {
                const navigationStart = after.NavigationStart!;
                const warm = route === "apps-open-idle";
                let warmCoverage: CoverageEntry[] | undefined;
                const warmBefore = after;
                if (warm && mode === "coverage") {
                  await page.coverage.startJSCoverage({
                    resetOnNavigation: false,
                    reportAnonymousScripts: false,
                  });
                }
                if (warm) {
                  await page.evaluate(async (coldReady) => {
                    const remaining = coldReady + 2_000 - performance.now();
                    if (remaining > 0) {
                      await new Promise<void>((resolve) => {
                        setTimeout(resolve, remaining);
                      });
                    }
                  }, readyMs);
                }
                const warmEnded = warm ? await page.evaluate(() => performance.now()) : readyMs;
                if (warm && mode === "coverage") {
                  warmCoverage = await page.coverage.stopJSCoverage();
                }
                const prior = new Map(
                  Array.from(requests, ([key, request]) => [key, Object.assign({}, request)]),
                );
                if (mode === "coverage") {
                  await page.coverage.startJSCoverage({
                    resetOnNavigation: false,
                    reportAnonymousScripts: false,
                  });
                }
                const actionBefore = await metrics(cdp);
                const { started, appSessionKey } = await page.evaluate(() => ({
                  started: performance.now(),
                  appSessionKey: window.openclawControlUi?.snapshot().sessionKey,
                }));
                if (!appSessionKey) {
                  throw new Error("First App launch requires the live selected session");
                }
                await clickFirstAppAndWait(page);
                const ended = await page.evaluate(
                  () =>
                    new Promise<number>((resolve) => {
                      requestAnimationFrame(() => resolve(performance.now()));
                    }),
                );
                const atEnd = Array.from(requests.values(), (request) =>
                  Object.assign({}, request),
                );
                const stepCoverage =
                  mode === "coverage" ? await page.coverage.stopJSCoverage() : undefined;
                const actionAfter = await metrics(cdp);
                appsFirstAction = {
                  id: route,
                  wallMs: ended - started,
                  cpu: cpuDelta(actionBefore, actionAfter),
                  actionStartedMs: started,
                  actionReadyMs: ended,
                  coldToActionGapMs: started - readyMs,
                  intentionalThinkTimeMs: warm ? 2_000 : 0,
                  phaseClockEvidence: {
                    navigationStart,
                    coldMetricTimestamp: after.Timestamp,
                    actionBeforeMetricTimestamp: actionBefore.Timestamp,
                    actionAfterMetricTimestamp: actionAfter.Timestamp,
                  },
                  coldPlusFirstOpenMs: ended,
                  coldPlusFirstOpenCpu: cpuDelta(before, actionAfter),
                  postColdThroughFirstOpenMs: ended - readyMs,
                  warmupCpu: cpuDelta(warmBefore, actionBefore),
                  warmupObservedEndMs: warmEnded,
                  newJsRequests: atEnd.filter(
                    (request) =>
                      !prior.has(request.requestId) &&
                      /\.m?js$/u.test(new URL(request.url).pathname),
                  ),
                  evaluatedScriptUrls: stepCoverage ? evaluatedUrls(stepCoverage) : undefined,
                  warmupEvaluatedScriptUrls: warmCoverage ? evaluatedUrls(warmCoverage) : undefined,
                };
                result.interactions = [appsFirstAction];
                if (stepCoverage) {
                  await writeFile(
                    path.join(output, `${prefix}-apps-open-v8.json`),
                    JSON.stringify(stepCoverage),
                  );
                }
                if (warmCoverage) {
                  await writeFile(
                    path.join(output, `${prefix}-apps-idle-v8.json`),
                    JSON.stringify(warmCoverage),
                  );
                }
                // Timestamped method observations are read after CPU cutoff, then cutoff-filtered.
                result.appsColdProbe = await appsProbeSnapshot(page, readyMs);
                appsFirstAction.preClickProbe = await appsProbeSnapshot(page, started);
                const readyProbe = await appsProbeSnapshot(page, ended);
                appsFirstAction.readyProbe = readyProbe;
                const clock = qualifyRouteNetworkClock(
                  atEnd,
                  navigationStart,
                  readyProbe.completedResourcesAtCutoff,
                );
                result.appsClockQualification = clock;
                if (!clock.passed) {
                  abortAfterContext = true;
                  throw new Error(
                    "Apps clock qualification failed; phase totals withheld and remaining contexts aborted",
                  );
                }
                appsFirstAction.networkPhases = {
                  cold: routeNetworkPhase(atEnd, navigationStart, 0, readyMs),
                  postColdBeforeClick: routeNetworkPhase(atEnd, navigationStart, readyMs, started),
                  firstOpen: routeNetworkPhase(atEnd, navigationStart, started, ended),
                };
                appsFirstAction.frameUrlsAtReady = page.frames().map((frame) => frame.url());
                if (stepCoverage) {
                  appsFirstAction.phaseAllScriptCoverage = await summarizeCoverage(
                    stepCoverage,
                    atEnd.filter(
                      (request) =>
                        new URL(request.url).origin === server.baseUrl &&
                        new URL(request.url).pathname.startsWith("/assets/") &&
                        /\.m?js$/u.test(new URL(request.url).pathname),
                    ),
                    variant.root,
                    prepared.assets,
                  );
                }
                if (values.screenshots && pair === 0) {
                  await page.screenshot({
                    path: path.join(output, `${prefix}-apps-first-ready.png`),
                  });
                }
                appsFirstAction.nativeBehavior = await verifyFirstAppAndClose(page, appSessionKey);
              } else if (isAppsPilotId(route) || (appsProbesEnabled && route === "memory")) {
                const probe = await appsProbeSnapshot(page, readyMs);
                result.appsColdProbe = probe;
                result.phaseClockEvidence = {
                  navigationStart: after.NavigationStart,
                  coldMetricTimestamp: after.Timestamp,
                };
                const clock = qualifyRouteNetworkClock(
                  requestsAtReady,
                  after.NavigationStart!,
                  probe.completedResourcesAtCutoff,
                );
                result.appsClockQualification = clock;
                if (!clock.passed) {
                  abortAfterContext = true;
                  throw new Error(
                    "Apps clock qualification failed; phase totals withheld and remaining contexts aborted",
                  );
                }
                if (
                  route === "memory" &&
                  Object.keys(probe.counts).some((method) => method.startsWith("mcp.app."))
                ) {
                  throw new Error("Memory control unexpectedly admitted an Apps request");
                }
              }
              const routeInteractions = interactionIds.filter(
                (value) =>
                  value !== "activity-lightbox-immediate" &&
                  value.startsWith(
                    route === "agents"
                      ? "agents-"
                      : route === "cron"
                        ? "cron-"
                        : route === "activity"
                          ? "activity-"
                          : "__none__",
                  ),
              );
              const warmFiles = routeInteractions.length
                ? (variant.nextPreloads[`${route}-next`] ?? [])
                : [];
              const warmup = routeInteractions.length
                ? { cpu: await metrics(cdp), started: await page.evaluate(() => performance.now()) }
                : undefined;
              if (warmup && mode === "coverage") {
                await page.coverage.startJSCoverage({
                  resetOnNavigation: false,
                  reportAnonymousScripts: false,
                });
              }
              const data = await page.evaluate(
                (cutoffMs) => ({
                  observedAtMs: performance.now(),
                  resources: performance
                    .getEntriesByType("resource")
                    .map((entry) => {
                      const resource = entry as PerformanceResourceTiming;
                      return {
                        url: resource.name,
                        initiatorType: resource.initiatorType,
                        rawBytes: resource.decodedBodySize,
                        encodedBytes: resource.encodedBodySize,
                        transferBytes: resource.transferSize,
                        startTime: resource.startTime,
                        responseEnd: resource.responseEnd,
                      };
                    })
                    .filter((resource) => resource.responseEnd <= cutoffMs),
                  rpc: (window as MockGatewayWindow).openclawControlUiE2eGateway
                    ?.findRequests()
                    .reduce<Record<string, number>>((counts, request) => {
                      counts[request.method] = (counts[request.method] ?? 0) + 1;
                      return counts;
                    }, {}),
                  alerts: [...document.querySelectorAll('[role="alert"]')]
                    .filter(
                      (node) =>
                        node.getClientRects().length > 0 &&
                        getComputedStyle(node).visibility !== "hidden",
                    )
                    .map((node) => node.textContent),
                  portalIdentity: (() => {
                    const identity = document.querySelector(
                      "openclaw-portals-page[embedded] .portals-embedded__identity",
                    );
                    if (!identity) {
                      return null;
                    }
                    const style = getComputedStyle(identity);
                    return { display: style.display, gap: style.gap };
                  })(),
                }),
                readyMs,
              );
              if (route === "activity" && activityMedia) {
                result.rpcObservedAtMs = data.observedAtMs;
                const clock = qualifyRouteNetworkClock(
                  requestsAtReady,
                  after.NavigationStart!,
                  data.resources.filter((resource) => resource.responseEnd > 0),
                );
                result.clockQualification = clock;
                if (!clock.passed) {
                  result.routeClockFailure = true;
                  result.networkAndCoverageTotalsWithheld = true;
                  throw new Error("Activity cold clock did not qualify; raw evidence retained");
                }
                result.networkAtReady = routeNetworkPhase(
                  requestsAtReady,
                  after.NavigationStart!,
                  0,
                  readyMs,
                );
              }
              // Keep the first open ahead of artifact analysis and screenshots.
              let activityImmediateCell: InteractionResult | undefined;
              if (activityImmediate) {
                const cell: InteractionResult = { id: "activity-lightbox-immediate" };
                activityImmediateCell = cell;
                result.interactions = [cell];
                const prior = new Map(
                  Array.from(requests, ([key, request]) => [key, Object.assign({}, request)]),
                );
                if (mode === "coverage") {
                  await page.coverage.startJSCoverage({
                    resetOnNavigation: false,
                    reportAnonymousScripts: false,
                  });
                }
                let stepCoverage: CoverageEntry[] | undefined;
                let failure: { error: unknown } | undefined;
                try {
                  const cpuBefore = await metrics(cdp);
                  const started = await page.evaluate(() => performance.now());
                  await page.locator(activityMediaTrigger).first().click();
                  await waitForActivityLightbox(page);
                  const ended = await page.evaluate(
                    () =>
                      new Promise<number>((resolve) => {
                        requestAnimationFrame(() => resolve(performance.now()));
                      }),
                  );
                  const cpuAfter = await metrics(cdp);
                  const atEnd = Array.from(requests.values(), (request) =>
                    Object.assign({}, request),
                  );
                  cell.coldReadyMs = readyMs;
                  cell.actionStartedMs = started;
                  cell.readinessToActionMs = started - readyMs;
                  cell.wallMs = ended - started;
                  cell.cpu = cpuDelta(cpuBefore, cpuAfter);
                  cell.newJsRequests = atEnd.filter(
                    (request) =>
                      !prior.has(request.requestId) &&
                      /\.m?js$/u.test(new URL(request.url).pathname),
                  );
                  cell.previousPendingCompleted = atEnd.filter(
                    (request) =>
                      prior.has(request.requestId) &&
                      prior.get(request.requestId)!.wireBytes === undefined &&
                      request.wireBytes !== undefined,
                  );
                  if (mode === "coverage") {
                    stepCoverage = await page.coverage.stopJSCoverage();
                  }
                  if (values.screenshots && pair === 0) {
                    await page.screenshot({
                      path: path.join(output, `${prefix}-activity-lightbox-immediate.png`),
                    });
                  }
                  await closeActivityLightbox(page);
                } catch (error) {
                  failure = { error };
                  cell.error = String(error);
                } finally {
                  if (mode === "coverage") {
                    try {
                      stepCoverage ??= await page.coverage.stopJSCoverage();
                      cell.evaluatedScriptUrls = evaluatedUrls(stepCoverage);
                      const suffix = failure ? "-failure" : "";
                      await writeFile(
                        path.join(output, `${prefix}-activity-lightbox-immediate${suffix}-v8.json`),
                        JSON.stringify(stepCoverage),
                      );
                    } catch (error) {
                      cell.coverageCaptureError = String(error);
                      failure ??= { error };
                    }
                  }
                }
                if (failure) {
                  throw failure.error;
                }
              }
              // Keep immediate navigation ahead of artifact analysis and screenshots.
              const securityCell = securityInteraction
                ? await runSecurityNavigation(
                    page,
                    cdp,
                    securityInteraction,
                    mode,
                    readyMs,
                    requests,
                    prefix,
                    coverageAtReady,
                  )
                : undefined;
              result.rpc = data.rpc;
              result.alerts = data.alerts;
              if (route === "portal-embedded") {
                result.portalIdentity = data.portalIdentity;
              }
              const unexpectedAlerts = data.alerts.filter(
                (alert) =>
                  !(
                    (route === "advanced" || route === "communications") &&
                    alert?.trim() === "Unsupported schema node. Use Raw mode."
                  ),
              );
              const jsRequests = requestsAtReady.filter((request) =>
                /\.m?js$/u.test(new URL(request.url).pathname),
              );
              result.jsRequests = jsRequests;
              result.pendingJsRequests = jsRequests.filter(
                (request) => request.wireBytes === undefined && !request.failed,
              ).length;
              result.httpJsWireBytes = jsRequests.reduce(
                (sum, request) => sum + (request.wireBytes ?? 0),
                0,
              );
              result.jsResources = data.resources.filter((resource) =>
                /\.m?js$/u.test(new URL(resource.url).pathname),
              );
              if (coverageAtReady) {
                result.coverage = await summarizeCoverage(
                  coverageAtReady,
                  jsRequests,
                  variant.root,
                  prepared.assets,
                );
                await writeFile(
                  path.join(output, `${prefix}-v8.json`),
                  JSON.stringify(coverageAtReady),
                );
              }
              if (values.screenshots && pair === 0 && !isAppsOpenId(route)) {
                await page.screenshot({
                  path: path.join(
                    output,
                    securityCell ? `${prefix}-${securityInteraction}.png` : `${prefix}.png`,
                  ),
                });
              }
              // Keep coverage and screenshots even when the visible page is not usable.
              if (unexpectedAlerts.length) {
                throw new Error(`Unexpected visible alerts: ${unexpectedAlerts.join("; ")}`);
              }
              if (warmup) {
                await page.evaluate(async (started) => {
                  const remaining = started + 2_000 - performance.now();
                  if (remaining > 0) {
                    await new Promise<void>((resolve) => {
                      setTimeout(resolve, remaining);
                    });
                  }
                }, warmup.started);
                const idleEnded = await page.evaluate(() => performance.now());
                const idleCpu = await metrics(cdp);
                const idleRequests = Array.from(requests.values(), (request) =>
                  Object.assign({}, request),
                );
                // Keep descriptor-specific readiness polling outside the idle CPU sample.
                const urls = warmFiles.map((file) => new URL(file, server.baseUrl).href);
                if (urls.length) {
                  await page.waitForFunction(
                    (expectedUrls) =>
                      expectedUrls.every((url) =>
                        performance
                          .getEntriesByName(url)
                          .some((entry) => (entry as PerformanceResourceTiming).responseEnd > 0),
                      ),
                    urls,
                  );
                }
                const warmEnded = await page.evaluate(() => performance.now());
                const verifiedCpu = await metrics(cdp);
                const warmCoverage =
                  mode === "coverage" ? await page.coverage.stopJSCoverage() : undefined;
                const evaluated = warmCoverage ? evaluatedUrls(warmCoverage) : undefined;
                const panelEvaluated =
                  evaluated && urls.length
                    ? evaluatedUrls(coverageAtReady ?? [])
                        .concat(evaluated)
                        .includes(urls[0]!)
                    : undefined;
                result.interactionWarmup = {
                  files: warmFiles,
                  minimumThinkTimeMs: 2_000,
                  postReadyWallMs: idleEnded - readyMs,
                  wallMs: idleEnded - warmup.started,
                  cpu: cpuDelta(warmup.cpu, idleCpu),
                  preloadVerification: {
                    wallMs: warmEnded - idleEnded,
                    cpu: cpuDelta(idleCpu, verifiedCpu),
                    ...(route === "activity"
                      ? {
                          network: routeNetworkPhase(
                            Array.from(requests.values()),
                            after.NavigationStart!,
                            idleEnded,
                            warmEnded,
                          ),
                        }
                      : {}),
                  },
                  evaluatedScriptUrls: evaluated,
                  panelEvaluatedBeforeAction: panelEvaluated,
                  ...(route === "activity"
                    ? {
                        requestsAtEnd: idleRequests,
                        network: routeNetworkPhase(
                          idleRequests,
                          after.NavigationStart!,
                          readyMs,
                          idleEnded,
                        ),
                      }
                    : {}),
                };
                if (warmCoverage) {
                  await writeFile(
                    path.join(output, `${prefix}-warmup-v8.json`),
                    JSON.stringify(warmCoverage),
                  );
                }
                if (panelEvaluated) {
                  throw new Error(`Next panel evaluated before interaction: ${warmFiles[0]}`);
                }
              }
              result.interactions = activityImmediateCell
                ? [activityImmediateCell]
                : appsFirstAction
                  ? [appsFirstAction]
                  : securityCell
                    ? [securityCell]
                    : [];
              for (const id of routeInteractions) {
                if (id === "activity-idle") {
                  continue;
                }
                const cell: InteractionResult = { id };
                try {
                  // Transcript probing starts with the Activity list already available.
                  if (
                    id === "cron-transcript" &&
                    !(await page.locator(".cron-activity .cron-run-entry").isVisible())
                  ) {
                    await page.locator('[data-test-id="cron-list-tab-activity"]').click();
                    await page
                      .locator('.cron-activity .cron-runs[aria-busy="false"] .cron-run-entry')
                      .waitFor();
                  }
                  const trigger =
                    id === "agents-files"
                      ? "#agents-tab-files"
                      : id === "cron-history"
                        ? '[data-test-id="cron-list-tab-activity"]'
                        : id === "activity-lightbox"
                          ? activityMediaTrigger
                          : ".cron-activity .cron-run-entry button";
                  const ready =
                    id === "agents-files"
                      ? "#agent-panel .agent-file-tabs [role=tab]"
                      : id === "cron-history"
                        ? '.cron-activity .cron-runs[aria-busy="false"] .cron-run-entry'
                        : id === "activity-lightbox"
                          ? activityLightboxImage
                          : "[data-cron-run-transcript] .chat-text";
                  const prior = new Map(
                    Array.from(requests, ([key, request]) => [key, Object.assign({}, request)]),
                  );
                  if (mode === "coverage") {
                    await page.coverage.startJSCoverage({
                      resetOnNavigation: false,
                      reportAnonymousScripts: false,
                    });
                  }
                  const cpuBefore = await metrics(cdp);
                  const started = await page.evaluate(() => performance.now());
                  await page.locator(trigger).first().click();
                  await page.locator(ready).first().waitFor({ state: "visible" });
                  if (id === "cron-transcript") {
                    await page
                      .locator(ready)
                      .filter({ hasText: "Synthetic route transcript ready." })
                      .waitFor();
                  }
                  if (id === "activity-lightbox") {
                    await waitForActivityLightbox(page);
                  }
                  const ended = await page.evaluate(
                    () =>
                      new Promise<number>((resolve) => {
                        requestAnimationFrame(() => resolve(performance.now()));
                      }),
                  );
                  const atEnd = Array.from(requests.values(), (request) =>
                    Object.assign({}, request),
                  );
                  const stepCoverage =
                    mode === "coverage" ? await page.coverage.stopJSCoverage() : undefined;
                  cell.wallMs = ended - started;
                  cell.cpu = cpuDelta(cpuBefore, await metrics(cdp));
                  cell.newJsRequests = atEnd.filter(
                    (request) =>
                      !prior.has(request.requestId) &&
                      /\.m?js$/u.test(new URL(request.url).pathname),
                  );
                  cell.previousPendingCompleted = atEnd.filter(
                    (request) =>
                      prior.has(request.requestId) &&
                      prior.get(request.requestId)!.wireBytes === undefined &&
                      request.wireBytes !== undefined,
                  );
                  if (stepCoverage) {
                    cell.evaluatedScriptUrls = evaluatedUrls(stepCoverage);
                    await writeFile(
                      path.join(output, `${prefix}-${id}-v8.json`),
                      JSON.stringify(stepCoverage),
                    );
                  }
                  if (values.screenshots && pair === 0) {
                    await page.screenshot({ path: path.join(output, `${prefix}-${id}.png`) });
                  }
                  if (id === "activity-lightbox") {
                    await closeActivityLightbox(page);
                  }
                } catch (error) {
                  cell.error = String(error);
                  if (mode === "coverage") {
                    await page.coverage.stopJSCoverage().catch(() => []);
                  }
                  await page
                    .screenshot({ path: path.join(output, `${prefix}-${id}-failure.png`) })
                    .catch(() => {});
                }
                result.interactions.push(cell);
                if (cell.error) {
                  break;
                }
              }
              if (errors.length) {
                throw new Error(errors.join("\n"));
              }
            } catch (error) {
              if (pendingColdCoverage) {
                await writeFile(
                  path.join(output, `${prefix}-cold-failure-v8.json`),
                  JSON.stringify(pendingColdCoverage),
                );
              }
              if (mode === "coverage") {
                const failedCoverage = await page.coverage.stopJSCoverage().catch(() => []);
                if (failedCoverage.length) {
                  await writeFile(
                    path.join(output, `${prefix}-failed-phase-v8.json`),
                    JSON.stringify(failedCoverage),
                  );
                }
              }
              result.error = String(error);
              result.errors = errors;
              await page
                .screenshot({ path: path.join(output, `${prefix}-failure.png`) })
                .catch(() => {});
              result.failure = await page
                .evaluate(() => ({
                  url: location.href,
                  text: document.body?.textContent,
                  snapshot: window.openclawControlUi?.snapshot(),
                }))
                .catch(() => null);
            } finally {
              results.push(result);
              try {
                await appendFile(path.join(output, "samples.jsonl"), `${JSON.stringify(result)}\n`);
              } finally {
                await context.close();
              }
              console.log(
                JSON.stringify({
                  mode,
                  profile: profile.id,
                  route,
                  variant: variant.id,
                  pair,
                  readyMs: result.readyMs,
                  cpu: result.cpu,
                  error: result.error,
                }),
              );
            }
            if (result.routeClockFailure) {
              throw new Error("Activity clock qualification failed; remaining contexts aborted");
            }
            if (result.dockClockFailure) {
              throw new Error("Dock clock qualification failed; stopped after saving the failure");
            }
            if (abortAfterContext) {
              throw new Error("Apps clock qualification failed; stopped after saving the failure");
            }
          }
        }
      }
    }
  }
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await appsSandbox?.close();
    } finally {
      try {
        await server.close();
      } finally {
        await save();
      }
    }
  }
}
if (results.some((result) => result.error || result.interactions?.some((cell) => cell.error))) {
  process.exitCode = 1;
}

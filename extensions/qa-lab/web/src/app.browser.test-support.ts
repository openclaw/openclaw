import { readFileSync } from "node:fs";
import type { QaBusStateSnapshot } from "openclaw/plugin-sdk/qa-channel-protocol";
import { afterEach, beforeEach, vi } from "vitest";
import type { Bootstrap, EvidenceEnvelope, RunnerSelection } from "./ui-types.js";

export const httpMock = vi.hoisted(() => ({ getJson: vi.fn(), postJson: vi.fn() }));
vi.mock("./http.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./http.js")>()),
  ...httpMock,
}));

import { createQaLabApp } from "./app.js";

const scenarios: Bootstrap["scenarios"] = (
  [
    ["dm-chat-baseline", "DM baseline", "dm", "flow"],
    ["browser-talk-start-stop", "Browser Talk start-stop", "control-ui", "playwright"],
  ] as const
).map(([id, title, surface, kind]) => ({
  id,
  title,
  surface,
  objective: "test",
  successCriteria: ["pass"],
  execution: { kind },
}));

export function createBootstrap(
  selection: RunnerSelection,
  controlUiUrl: string | null = null,
): Bootstrap {
  const selectedScenarioIds = selection.scenarioIds ?? scenarios.map((scenario) => scenario.id);
  return {
    baseUrl: "http://127.0.0.1:43124",
    controlUiEmbeddedUrl: null,
    controlUiUrl,
    defaults: {
      conversationId: "qa-operator",
      conversationKind: "direct",
      senderId: "qa-operator",
      senderName: "QA Operator",
    },
    kickoffTask: "Run QA",
    latestReport: null,
    runner: {
      artifacts: null,
      error: null,
      plan: {
        errors: [],
        exclusions: [],
        executionKinds: ["flow", "playwright"],
        explicitScenarioSelection: selection.scenarioIds !== null,
        profile: selection.profile,
        selectedScenarios: scenarios
          .filter((scenario) => selectedScenarioIds.includes(scenario.id))
          .map((scenario) => ({
            declaredChannel: null,
            effectiveChannel: scenario.execution?.kind === "flow" ? "qa-channel" : null,
            executionKind: scenario.execution?.kind ?? "flow",
            id: scenario.id,
            title: scenario.title,
          })),
        status: "ready",
      },
      selection,
      status: "idle",
    },
    runnerCatalog: {
      channels: ["buzz", "matrix", "telegram"],
      profiles: [
        { id: "smoke-ci", evidenceMode: "slim", channelDriver: "crabline", categoryIds: [] },
        { id: "all", evidenceMode: "full", channelDriver: "live", categoryIds: [] },
      ],
      status: "ready",
      real: [
        {
          input: "text",
          key: "openai/gpt-5.6-luna",
          name: "GPT-5.6 Luna",
          preferred: true,
          provider: "openai",
        },
      ],
    },
    scenarios,
  };
}

export async function mountRunner(
  selection: RunnerSelection,
  snapshot: QaBusStateSnapshot = {
    conversations: [],
    cursor: 0,
    events: [],
    messages: [],
    threads: [],
  },
  evidence: EvidenceEnvelope["evidence"] = null,
  controlUiUrl: string | null = null,
) {
  let bootstrap = createBootstrap(selection, controlUiUrl);
  httpMock.getJson.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/evidence?")) {
      return { evidence };
    }
    const responses: Record<string, unknown> = {
      "/api/ui-version": { version: "test" },
      "/api/bootstrap": bootstrap,
      "/api/state": snapshot,
      "/api/report": { report: null },
      "/api/outcomes": { run: null },
      "/api/capture/sessions": { sessions: [] },
      "/api/capture/startup-status": {
        status: {
          gateway: { label: "Gateway", ok: true, url: "http://127.0.0.1:18789" },
          proxy: { label: "Proxy", ok: true, url: "http://127.0.0.1:7799" },
          qaLab: { label: "QA Lab", ok: true, url: bootstrap.baseUrl },
        },
      },
    };
    if (Object.hasOwn(responses, url)) {
      return responses[url];
    }
    throw new Error(`unexpected GET ${url}`);
  });
  httpMock.postJson.mockImplementation(async (url: string, body: unknown) => {
    if (url !== "/api/scenario/suite") {
      throw new Error(`unexpected POST ${url}`);
    }
    const nextSelection = body as RunnerSelection;
    bootstrap = createBootstrap(nextSelection, controlUiUrl);
    return { runner: { selection: nextSelection } };
  });
  const root = document.createElement("div");
  document.body.append(root);
  await createQaLabApp(root);
  return root;
}

beforeEach(() => {
  vi.useFakeTimers();
  const styles = document.createElement("style");
  styles.dataset.qaLabTestStyles = "true";
  styles.textContent = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
  document.head.append(styles);
  httpMock.getJson.mockReset();
  httpMock.postJson.mockReset();
  window.localStorage.clear();
  vi.stubGlobal("localStorage", window.localStorage);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.querySelector("style[data-qa-lab-test-styles]")?.remove();
  window.localStorage.clear();
});

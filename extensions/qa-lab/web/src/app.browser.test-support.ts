import { readFileSync } from "node:fs";
import path from "node:path";
import type { QaBusStateSnapshot } from "openclaw/plugin-sdk/qa-channel-protocol";
import { afterEach, beforeEach, vi } from "vitest";
import type { Bootstrap, EvidenceEnvelope, RunnerSelection } from "./ui-types.js";

const httpMock = vi.hoisted(() => {
  class QaLabHttpError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly payload: unknown,
    ) {
      super(message);
    }
  }
  return {
    getJson: vi.fn(),
    postJson: vi.fn(),
    QaLabHttpError,
  };
});

vi.mock("./http.js", () => httpMock);

import { createQaLabApp } from "./app.js";

const scenarios: Bootstrap["scenarios"] = [
  {
    id: "dm-chat-baseline",
    title: "DM baseline",
    surface: "dm",
    objective: "test DM",
    successCriteria: ["reply"],
    execution: { kind: "flow" },
  },
  {
    id: "browser-talk-start-stop",
    title: "Browser Talk start-stop",
    surface: "control-ui",
    objective: "test browser Talk",
    successCriteria: ["playwright pass"],
    execution: { kind: "playwright" },
  },
];

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
    if (url === "/api/ui-version") {
      return { version: "test" };
    }
    if (url.startsWith("/api/evidence?")) {
      return { evidence };
    }
    if (url === "/api/bootstrap") {
      return bootstrap;
    }
    if (url === "/api/state") {
      return snapshot;
    }
    if (url === "/api/report") {
      return { report: null };
    }
    if (url === "/api/outcomes") {
      return { run: null };
    }
    if (url === "/api/capture/sessions") {
      return { sessions: [] };
    }
    if (url === "/api/capture/startup-status") {
      return {
        status: {
          gateway: { label: "Gateway", ok: true, url: "http://127.0.0.1:18789" },
          proxy: { label: "Proxy", ok: true, url: "http://127.0.0.1:7799" },
          qaLab: { label: "QA Lab", ok: true, url: bootstrap.baseUrl },
        },
      };
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

export function setupAppBrowserTests() {
  beforeEach(() => {
    vi.useFakeTimers();
    const styles = document.createElement("style");
    styles.dataset.qaLabTestStyles = "true";
    styles.textContent = readFileSync(
      path.join(process.cwd(), "extensions/qa-lab/web/src/styles.css"),
      "utf8",
    );
    document.head.append(styles);
    httpMock.getJson.mockReset();
    httpMock.postJson.mockReset();
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      clear: () => storage.clear(),
      getItem: (key: string) => storage.get(key) ?? null,
      key: (index: number) => [...storage.keys()][index] ?? null,
      get length() {
        return storage.size;
      },
      removeItem: (key: string) => storage.delete(key),
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.replaceChildren();
    document.querySelector("style[data-qa-lab-test-styles]")?.remove();
  });
}

export { httpMock };

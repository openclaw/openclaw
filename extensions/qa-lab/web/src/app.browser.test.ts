/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Bootstrap, RunnerSelection } from "./ui-types.js";

const httpMock = vi.hoisted(() => ({
  getJson: vi.fn(),
  getJsonNoStore: vi.fn(),
  postJson: vi.fn(),
}));

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

function createBootstrap(selection: RunnerSelection): Bootstrap {
  return {
    baseUrl: "http://127.0.0.1:43124",
    controlUiEmbeddedUrl: null,
    controlUiUrl: null,
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
      selection,
      status: "idle",
    },
    runnerCatalog: {
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

async function mountRunner(selection: RunnerSelection) {
  let bootstrap = createBootstrap(selection);
  httpMock.getJson.mockImplementation(async (url: string) => {
    if (url === "/api/bootstrap") {
      return bootstrap;
    }
    if (url === "/api/state") {
      return { conversations: [], events: [], messages: [], threads: [] };
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
  httpMock.getJsonNoStore.mockResolvedValue({ version: "test" });
  httpMock.postJson.mockImplementation(async (url: string, body: unknown) => {
    if (url !== "/api/scenario/suite") {
      throw new Error(`unexpected POST ${url}`);
    }
    const nextSelection = body as RunnerSelection;
    bootstrap = createBootstrap(nextSelection);
    return { runner: { selection: nextSelection } };
  });
  const root = document.createElement("div");
  document.body.append(root);
  await createQaLabApp(root);
  return root;
}

function selectValue(root: HTMLElement, selector: string, value: string) {
  const select = root.querySelector<HTMLSelectElement>(selector);
  if (!select) {
    throw new Error(`missing select ${selector}`);
  }
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  httpMock.getJson.mockReset();
  httpMock.getJsonNoStore.mockReset();
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
});

describe("QA Lab runner browser interactions", () => {
  it("submits live-provider and Crabline selections with non-flow scenarios", async () => {
    const root = await mountRunner({
      alternateModel: "openai/gpt-5.6-luna",
      channelDriver: "crabline",
      fastMode: true,
      primaryModel: "openai/gpt-5.6-luna",
      providerMode: "live-frontier",
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-action='select-all-scenarios']")?.click();
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        channelDriver: "crabline",
        providerMode: "live-frontier",
        scenarioIds: ["dm-chat-baseline", "browser-talk-start-stop"],
      }),
    );
  });

  it("changes to real channels without changing the mock provider lane", async () => {
    const root = await mountRunner({
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      channelDriver: "qa-channel",
      fastMode: false,
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      scenarioIds: ["dm-chat-baseline"],
    });

    root.querySelector<HTMLButtonElement>("[data-sidebar-panel='config']")?.click();
    selectValue(root, "#channel-driver", "live");
    root.querySelector<HTMLButtonElement>("[data-action='run-suite']")?.click();

    await vi.waitFor(() => expect(httpMock.postJson).toHaveBeenCalledTimes(1));
    expect(httpMock.postJson).toHaveBeenCalledWith(
      "/api/scenario/suite",
      expect.objectContaining({
        channelDriver: "live",
        providerMode: "mock-openai",
      }),
    );
  });
});

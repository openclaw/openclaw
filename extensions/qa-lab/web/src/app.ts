import {
  type Bootstrap,
  type OutcomesEnvelope,
  type ReportEnvelope,
  type Snapshot,
  type TabId,
  type UiState,
  renderQaLabUi,
} from "./ui-render.js";

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

export async function createQaLabApp(root: HTMLDivElement) {
  const state: UiState = {
    bootstrap: null,
    snapshot: null,
    latestReport: null,
    scenarioRun: null,
    selectedConversationId: null,
    selectedThreadId: null,
    selectedScenarioId: null,
    activeTab: "debug",
    composer: {
      conversationKind: "direct",
      conversationId: "alice",
      senderId: "alice",
      senderName: "Alice",
      text: "",
    },
    busy: false,
    error: null,
  };

  async function refresh() {
    try {
      const [bootstrap, snapshot, report, outcomes] = await Promise.all([
        getJson<Bootstrap>("/api/bootstrap"),
        getJson<Snapshot>("/api/state"),
        getJson<ReportEnvelope>("/api/report"),
        getJson<OutcomesEnvelope>("/api/outcomes"),
      ]);
      state.bootstrap = bootstrap;
      state.snapshot = snapshot;
      state.latestReport = report.report ?? bootstrap.latestReport;
      state.scenarioRun = outcomes.run;
      if (!state.selectedConversationId) {
        state.selectedConversationId = snapshot.conversations[0]?.id ?? null;
      }
      if (!state.selectedScenarioId) {
        state.selectedScenarioId = bootstrap.scenarios[0]?.id ?? null;
      }
      if (!state.composer.conversationId) {
        state.composer = {
          ...state.composer,
          conversationKind: bootstrap.defaults.conversationKind,
          conversationId: bootstrap.defaults.conversationId,
          senderId: bootstrap.defaults.senderId,
          senderName: bootstrap.defaults.senderName,
        };
      }
      state.error = null;
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
    }
    render();
  }

  async function runSelfCheck() {
    state.busy = true;
    state.error = null;
    render();
    try {
      const result = await postJson<{ report: string; outputPath: string }>(
        "/api/scenario/self-check",
        {},
      );
      state.latestReport = {
        outputPath: result.outputPath,
        markdown: result.report,
        generatedAt: new Date().toISOString(),
      };
      state.activeTab = "report";
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function resetState() {
    state.busy = true;
    render();
    try {
      await postJson("/api/reset", {});
      state.latestReport = null;
      state.selectedThreadId = null;
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function sendInbound() {
    const conversationId = state.composer.conversationId.trim();
    const text = state.composer.text.trim();
    if (!conversationId || !text) {
      state.error = "Conversation id and text are required.";
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    render();
    try {
      await postJson("/api/inbound/message", {
        conversation: {
          id: conversationId,
          kind: state.composer.conversationKind,
          ...(state.composer.conversationKind === "channel" ? { title: conversationId } : {}),
        },
        senderId: state.composer.senderId.trim() || "alice",
        senderName: state.composer.senderName.trim() || undefined,
        text,
        ...(state.selectedThreadId ? { threadId: state.selectedThreadId } : {}),
      });
      state.selectedConversationId = conversationId;
      state.composer.text = "";
      await refresh();
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  function downloadReport() {
    if (!state.latestReport?.markdown) {
      return;
    }
    const blob = new Blob([state.latestReport.markdown], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "qa-report.md";
    anchor.click();
    URL.revokeObjectURL(href);
  }

  function bindEvents() {
    root.querySelectorAll<HTMLElement>("[data-conversation-id]").forEach((node) => {
      node.onclick = () => {
        state.selectedConversationId = node.dataset.conversationId ?? null;
        state.selectedThreadId = null;
        state.activeTab = "debug";
        render();
      };
    });
    root.querySelectorAll<HTMLElement>("[data-thread-id]").forEach((node) => {
      node.onclick = () => {
        state.selectedConversationId = node.dataset.conversationId ?? null;
        state.selectedThreadId = node.dataset.threadId ?? null;
        state.activeTab = "debug";
        render();
      };
    });
    root.querySelectorAll<HTMLElement>("[data-scenario-id]").forEach((node) => {
      node.onclick = () => {
        state.selectedScenarioId = node.dataset.scenarioId ?? null;
        state.activeTab = "scenarios";
        render();
      };
    });
    root.querySelectorAll<HTMLElement>("[data-tab]").forEach((node) => {
      node.onclick = () => {
        const nextTab = node.dataset.tab as TabId | undefined;
        if (nextTab) {
          state.activeTab = nextTab;
          render();
        }
      };
    });

    root.querySelector<HTMLButtonElement>("[data-action='refresh']")!.onclick = () => {
      void refresh();
    };
    root.querySelector<HTMLButtonElement>("[data-action='reset']")!.onclick = () => {
      void resetState();
    };
    root.querySelector<HTMLButtonElement>("[data-action='self-check']")!.onclick = () => {
      void runSelfCheck();
    };
    root.querySelector<HTMLButtonElement>("[data-action='send']")?.addEventListener("click", () => {
      void sendInbound();
    });
    root
      .querySelector<HTMLButtonElement>("[data-action='download-report']")
      ?.addEventListener("click", () => {
        downloadReport();
      });

    root
      .querySelector<HTMLSelectElement>("#conversation-kind")
      ?.addEventListener("change", (event) => {
        const target = event.currentTarget as HTMLSelectElement;
        state.composer.conversationKind = target.value === "channel" ? "channel" : "direct";
      });
    root.querySelector<HTMLInputElement>("#conversation-id")?.addEventListener("input", (event) => {
      state.composer.conversationId = (event.currentTarget as HTMLInputElement).value;
    });
    root.querySelector<HTMLInputElement>("#sender-id")?.addEventListener("input", (event) => {
      state.composer.senderId = (event.currentTarget as HTMLInputElement).value;
    });
    root.querySelector<HTMLInputElement>("#sender-name")?.addEventListener("input", (event) => {
      state.composer.senderName = (event.currentTarget as HTMLInputElement).value;
    });
    root
      .querySelector<HTMLTextAreaElement>("#composer-text")
      ?.addEventListener("input", (event) => {
        state.composer.text = (event.currentTarget as HTMLTextAreaElement).value;
      });
  }

  function render() {
    const next = document.createElement("div");
    next.innerHTML = renderQaLabUi(state);

    // Keep the embedded Control UI pane mounted across polling refreshes so auth/session
    // state does not bounce while the QA-side debugger updates.
    const currentControlPane = root.querySelector<HTMLElement>(".control-pane");
    const currentControlFrame =
      currentControlPane?.querySelector<HTMLIFrameElement>(".control-frame");
    const currentQaColumn = root.querySelector<HTMLElement>(".qa-column");
    const nextControlPane = next.querySelector<HTMLElement>(".control-pane");
    const nextControlFrame = nextControlPane?.querySelector<HTMLIFrameElement>(".control-frame");
    const nextQaColumn = next.querySelector<HTMLElement>(".qa-column");
    const currentControlSrc = currentControlFrame?.getAttribute("src") ?? "";
    const nextControlSrc = nextControlFrame?.getAttribute("src") ?? "";

    if (
      currentControlPane &&
      currentQaColumn &&
      nextControlPane &&
      nextQaColumn &&
      currentControlSrc &&
      currentControlSrc === nextControlSrc
    ) {
      currentQaColumn.replaceWith(nextQaColumn);
      bindEvents();
      return;
    }

    root.replaceChildren(...Array.from(next.childNodes));
    bindEvents();
  }

  render();
  await refresh();
  setInterval(() => {
    void refresh();
  }, 1_000);
}

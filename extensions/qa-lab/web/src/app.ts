type Conversation = {
  id: string;
  kind: "direct" | "channel";
  title?: string;
};

type Thread = {
  id: string;
  conversationId: string;
  title: string;
};

type Message = {
  id: string;
  direction: "inbound" | "outbound";
  conversation: Conversation;
  senderId: string;
  senderName?: string;
  text: string;
  timestamp: number;
  threadId?: string;
  threadTitle?: string;
  deleted?: boolean;
  editedAt?: number;
  reactions: Array<{ emoji: string; senderId: string }>;
};

type BusEvent =
  | { cursor: number; kind: "thread-created"; thread: Thread }
  | { cursor: number; kind: string; message?: Message; emoji?: string };

type Snapshot = {
  conversations: Conversation[];
  threads: Thread[];
  messages: Message[];
  events: BusEvent[];
};

type ReportEnvelope = {
  report: null | {
    outputPath: string;
    markdown: string;
    generatedAt: string;
  };
};

type SeedScenario = {
  id: string;
  title: string;
  surface: string;
  objective: string;
  successCriteria: string[];
  docsRefs?: string[];
  codeRefs?: string[];
};

type Bootstrap = {
  baseUrl: string;
  latestReport: ReportEnvelope["report"];
  controlUiUrl: string | null;
  controlUiEmbeddedUrl: string | null;
  kickoffTask: string;
  scenarios: SeedScenario[];
  defaults: {
    conversationKind: "direct" | "channel";
    conversationId: string;
    senderId: string;
    senderName: string;
  };
};

type UiState = {
  bootstrap: Bootstrap | null;
  snapshot: Snapshot | null;
  latestReport: ReportEnvelope["report"];
  selectedConversationId: string | null;
  selectedThreadId: string | null;
  composer: {
    conversationKind: "direct" | "channel";
    conversationId: string;
    senderId: string;
    senderName: string;
    text: string;
  };
  busy: boolean;
  error: string | null;
};

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

function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function filteredMessages(state: UiState) {
  const messages = state.snapshot?.messages ?? [];
  return messages.filter((message) => {
    if (state.selectedConversationId && message.conversation.id !== state.selectedConversationId) {
      return false;
    }
    if (state.selectedThreadId && message.threadId !== state.selectedThreadId) {
      return false;
    }
    return true;
  });
}

function deriveSelectedConversation(state: UiState): string | null {
  if (state.selectedConversationId) {
    return state.selectedConversationId;
  }
  return state.snapshot?.conversations[0]?.id ?? null;
}

function deriveSelectedThread(state: UiState): string | null {
  if (state.selectedThreadId) {
    return state.selectedThreadId;
  }
  return null;
}

function renderScenarioList(scenarios: SeedScenario[]) {
  if (scenarios.length === 0) {
    return '<p class="empty">No repo-backed scenarios yet.</p>';
  }
  return scenarios
    .map(
      (scenario) => `
        <article class="scenario-card">
          <header>
            <strong>${escapeHtml(scenario.title)}</strong>
            <span>${escapeHtml(scenario.surface)}</span>
          </header>
          <p>${escapeHtml(scenario.objective)}</p>
          <footer>
            <code>${escapeHtml(scenario.id)}</code>
          </footer>
        </article>`,
    )
    .join("");
}

export async function createQaLabApp(root: HTMLDivElement) {
  const state: UiState = {
    bootstrap: null,
    snapshot: null,
    latestReport: null,
    selectedConversationId: null,
    selectedThreadId: null,
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
      const [bootstrap, snapshot, report] = await Promise.all([
        getJson<Bootstrap>("/api/bootstrap"),
        getJson<Snapshot>("/api/state"),
        getJson<ReportEnvelope>("/api/report"),
      ]);
      state.bootstrap = bootstrap;
      state.snapshot = snapshot;
      state.latestReport = report.report ?? bootstrap.latestReport;
      if (!state.selectedConversationId) {
        state.selectedConversationId = snapshot.conversations[0]?.id ?? null;
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
        render();
      };
    });
    root.querySelectorAll<HTMLElement>("[data-thread-id]").forEach((node) => {
      node.onclick = () => {
        state.selectedConversationId = node.dataset.conversationId ?? null;
        state.selectedThreadId = node.dataset.threadId ?? null;
        render();
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
    root.querySelector<HTMLButtonElement>("[data-action='send']")!.onclick = () => {
      void sendInbound();
    };
    root.querySelector<HTMLButtonElement>("[data-action='download-report']")!.onclick = () => {
      downloadReport();
    };

    root.querySelector<HTMLSelectElement>("#conversation-kind")!.onchange = (event) => {
      const target = event.currentTarget as HTMLSelectElement;
      state.composer.conversationKind = target.value === "channel" ? "channel" : "direct";
    };
    root.querySelector<HTMLInputElement>("#conversation-id")!.oninput = (event) => {
      state.composer.conversationId = (event.currentTarget as HTMLInputElement).value;
    };
    root.querySelector<HTMLInputElement>("#sender-id")!.oninput = (event) => {
      state.composer.senderId = (event.currentTarget as HTMLInputElement).value;
    };
    root.querySelector<HTMLInputElement>("#sender-name")!.oninput = (event) => {
      state.composer.senderName = (event.currentTarget as HTMLInputElement).value;
    };
    root.querySelector<HTMLTextAreaElement>("#composer-text")!.oninput = (event) => {
      state.composer.text = (event.currentTarget as HTMLTextAreaElement).value;
    };
  }

  function render() {
    const selectedConversationId = deriveSelectedConversation(state);
    const selectedThreadId = deriveSelectedThread(state);
    const conversations = state.snapshot?.conversations ?? [];
    const threads = (state.snapshot?.threads ?? []).filter(
      (thread) => !selectedConversationId || thread.conversationId === selectedConversationId,
    );
    const messages = filteredMessages({
      ...state,
      selectedConversationId,
      selectedThreadId,
    });
    const events = (state.snapshot?.events ?? []).slice(-20).reverse();
    const scenarios = state.bootstrap?.scenarios ?? [];
    const hasControlUi = Boolean(state.bootstrap?.controlUiEmbeddedUrl);
    const kickoffTask = state.bootstrap?.kickoffTask ?? "";
    const dashboardShellClass = hasControlUi ? "dashboard split-dashboard" : "dashboard";

    root.innerHTML = `
      <div class="${dashboardShellClass}">
        ${
          hasControlUi
            ? `
          <section class="control-pane panel">
            <div class="panel-header">
              <div>
                <p class="eyebrow">Agent Control</p>
                <h2>Control UI</h2>
              </div>
              ${
                state.bootstrap?.controlUiUrl
                  ? `<a class="button-link" href="${escapeHtml(state.bootstrap.controlUiUrl)}" target="_blank" rel="noreferrer">Open full tab</a>`
                  : ""
              }
            </div>
            <iframe class="control-frame" src="${escapeHtml(state.bootstrap?.controlUiEmbeddedUrl ?? "")}" title="OpenClaw Control UI"></iframe>
          </section>`
            : ""
        }
        <div class="shell qa-column">
          <header class="topbar">
            <div>
              <p class="eyebrow">Private QA Workspace</p>
              <h1>QA Lab</h1>
              <p class="subtle">Slack-ish QA surface, repo-backed scenario plan, protocol report.</p>
            </div>
            <div class="toolbar">
              <button data-action="refresh"${state.busy ? " disabled" : ""}>Refresh</button>
              <button data-action="reset"${state.busy ? " disabled" : ""}>Reset</button>
              <button class="accent" data-action="self-check"${state.busy ? " disabled" : ""}>Run Self-Check</button>
            </div>
          </header>
          <section class="statusbar">
            <span class="pill">Bus ${state.bootstrap ? "online" : "booting"}</span>
            <span class="pill">${hasControlUi ? "Control UI linked" : "Control UI external"}</span>
            <span class="pill">Scenarios ${scenarios.length}</span>
            <span class="pill">Conversation ${selectedConversationId ?? "none"}</span>
            <span class="pill">Thread ${selectedThreadId ?? "root"}</span>
            ${state.latestReport ? `<span class="pill success">Report ${escapeHtml(state.latestReport.outputPath)}</span>` : '<span class="pill">No report yet</span>'}
            ${state.error ? `<span class="pill error">${escapeHtml(state.error)}</span>` : ""}
          </section>
          <main class="workspace">
          <aside class="rail">
            <section class="panel">
              <h2>Conversations</h2>
              <div class="stack">
                ${conversations
                  .map(
                    (conversation) => `
                      <button class="list-item${conversation.id === selectedConversationId ? " selected" : ""}" data-conversation-id="${escapeHtml(conversation.id)}">
                        <strong>${escapeHtml(conversation.title || conversation.id)}</strong>
                        <span>${conversation.kind}</span>
                      </button>`,
                  )
                  .join("")}
              </div>
            </section>
            <section class="panel">
              <h2>Threads</h2>
              <div class="stack">
                <button class="list-item${!selectedThreadId ? " selected" : ""}" data-conversation-id="${escapeHtml(selectedConversationId ?? "")}">
                  <strong>Main timeline</strong>
                  <span>root</span>
                </button>
                ${threads
                  .map(
                    (thread) => `
                      <button class="list-item${thread.id === selectedThreadId ? " selected" : ""}" data-thread-id="${escapeHtml(thread.id)}" data-conversation-id="${escapeHtml(thread.conversationId)}">
                        <strong>${escapeHtml(thread.title)}</strong>
                        <span>${escapeHtml(thread.id)}</span>
                      </button>`,
                  )
                  .join("")}
              </div>
            </section>
          </aside>
          <section class="center">
            <section class="panel transcript">
              <h2>Transcript</h2>
              <div class="messages">
                ${
                  messages.length === 0
                    ? '<p class="empty">No messages in this slice yet.</p>'
                    : messages
                        .map(
                          (message) => `
                            <article class="message ${message.direction}">
                              <header>
                                <strong>${escapeHtml(message.senderName || message.senderId)}</strong>
                                <span>${message.direction}</span>
                                <time>${formatTime(message.timestamp)}</time>
                              </header>
                              <p>${escapeHtml(message.text)}</p>
                              <footer>
                                <span>${escapeHtml(message.id)}</span>
                                ${message.threadId ? `<span>thread ${escapeHtml(message.threadId)}</span>` : ""}
                                ${message.editedAt ? "<span>edited</span>" : ""}
                                ${message.deleted ? "<span>deleted</span>" : ""}
                                ${message.reactions.length ? `<span>${message.reactions.map((reaction) => reaction.emoji).join(" ")}</span>` : ""}
                              </footer>
                            </article>`,
                        )
                        .join("")
                }
              </div>
            </section>
            <section class="panel composer">
              <h2>Inject inbound</h2>
              <div class="composer-grid">
                <label>
                  <span>Kind</span>
                  <select id="conversation-kind">
                    <option value="direct"${state.composer.conversationKind === "direct" ? " selected" : ""}>Direct</option>
                    <option value="channel"${state.composer.conversationKind === "channel" ? " selected" : ""}>Channel</option>
                  </select>
                </label>
                <label>
                  <span>Conversation</span>
                  <input id="conversation-id" value="${escapeHtml(state.composer.conversationId)}" />
                </label>
                <label>
                  <span>Sender id</span>
                  <input id="sender-id" value="${escapeHtml(state.composer.senderId)}" />
                </label>
                <label>
                  <span>Sender name</span>
                  <input id="sender-name" value="${escapeHtml(state.composer.senderName)}" />
                </label>
              </div>
              <label class="textarea-label">
                <span>Message</span>
                <textarea id="composer-text" rows="4" placeholder="Ask the agent to do something interesting...">${escapeHtml(state.composer.text)}</textarea>
              </label>
              <div class="toolbar lower">
                <button class="accent" data-action="send"${state.busy ? " disabled" : ""}>Send inbound</button>
              </div>
            </section>
          </section>
          <aside class="rail right">
            <section class="panel">
              <h2>Kickoff task</h2>
              <pre class="report">${escapeHtml(kickoffTask || "No kickoff task loaded.")}</pre>
            </section>
            <section class="panel">
              <h2>Seed scenarios</h2>
              <div class="scenario-list">
                ${renderScenarioList(scenarios)}
              </div>
            </section>
            <section class="panel">
              <div class="panel-header">
                <h2>Latest report</h2>
                <button data-action="download-report"${state.latestReport ? "" : " disabled"}>Export</button>
              </div>
              <pre class="report">${escapeHtml(state.latestReport?.markdown ?? "Run the self-check to generate a Markdown protocol report.")}</pre>
            </section>
            <section class="panel events">
              <h2>Event stream</h2>
              <div class="stack">
                ${events
                  .map((event) => {
                    const tail =
                      "thread" in event
                        ? `${event.thread.conversationId}/${event.thread.id}`
                        : event.message
                          ? `${event.message.senderId}: ${event.message.text}`
                          : "";
                    return `
                      <div class="event-row">
                        <strong>${escapeHtml(event.kind)}</strong>
                        <span>#${event.cursor}</span>
                        <code>${escapeHtml(tail)}</code>
                      </div>`;
                  })
                  .join("")}
              </div>
            </section>
          </aside>
          </main>
        </div>
      </div>`;
    bindEvents();
  }

  render();
  await refresh();
  setInterval(() => {
    void refresh();
  }, 1_000);
}

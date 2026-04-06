export type Conversation = {
  id: string;
  kind: "direct" | "channel";
  title?: string;
};

export type Thread = {
  id: string;
  conversationId: string;
  title: string;
};

export type Message = {
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

export type BusEvent =
  | { cursor: number; kind: "thread-created"; thread: Thread }
  | { cursor: number; kind: string; message?: Message; emoji?: string };

export type Snapshot = {
  conversations: Conversation[];
  threads: Thread[];
  messages: Message[];
  events: BusEvent[];
};

export type ReportEnvelope = {
  report: null | {
    outputPath: string;
    markdown: string;
    generatedAt: string;
  };
};

export type SeedScenario = {
  id: string;
  title: string;
  surface: string;
  objective: string;
  successCriteria: string[];
  docsRefs?: string[];
  codeRefs?: string[];
};

export type Bootstrap = {
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

export type ScenarioStep = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
};

export type ScenarioOutcome = {
  id: string;
  name: string;
  status: "pending" | "running" | "pass" | "fail" | "skip";
  details?: string;
  steps?: ScenarioStep[];
  startedAt?: string;
  finishedAt?: string;
};

export type ScenarioRun = {
  kind: "suite" | "self-check";
  status: "idle" | "running" | "completed";
  startedAt?: string;
  finishedAt?: string;
  scenarios: ScenarioOutcome[];
  counts: {
    total: number;
    pending: number;
    running: number;
    passed: number;
    failed: number;
    skipped: number;
  };
};

export type OutcomesEnvelope = {
  run: ScenarioRun | null;
};

export type TabId = "debug" | "scenarios" | "report" | "events";

export type UiState = {
  bootstrap: Bootstrap | null;
  snapshot: Snapshot | null;
  latestReport: ReportEnvelope["report"];
  scenarioRun: ScenarioRun | null;
  selectedConversationId: string | null;
  selectedThreadId: string | null;
  selectedScenarioId: string | null;
  activeTab: TabId;
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

export function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatIso(iso?: string) {
  if (!iso) {
    return "n/a";
  }
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
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

export function deriveSelectedConversation(state: UiState): string | null {
  if (state.selectedConversationId) {
    return state.selectedConversationId;
  }
  return state.snapshot?.conversations[0]?.id ?? null;
}

export function deriveSelectedThread(state: UiState): string | null {
  return state.selectedThreadId ?? null;
}

export function filteredMessages(state: UiState) {
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

function findScenarioOutcome(state: UiState, scenario: SeedScenario) {
  return (
    state.scenarioRun?.scenarios.find((outcome) => outcome.id === scenario.id) ??
    state.scenarioRun?.scenarios.find((outcome) => outcome.name === scenario.title) ??
    null
  );
}

function renderStatusChip(status: ScenarioOutcome["status"]) {
  const label =
    status === "pending"
      ? "seeded"
      : status === "pass"
        ? "pass"
        : status === "fail"
          ? "fail"
          : status;
  return `<span class="status-chip status-${status}">${escapeHtml(label)}</span>`;
}

function renderRefs(refs: string[] | undefined, kind: "docs" | "code") {
  if (!refs?.length) {
    return `<p class="empty">No ${kind} refs attached.</p>`;
  }
  return refs.map((ref) => `<code>${escapeHtml(ref)}</code>`).join("");
}

function renderScenarioBoard(state: UiState, scenarios: SeedScenario[]) {
  if (scenarios.length === 0) {
    return '<p class="empty">No repo-backed scenarios yet.</p>';
  }
  return scenarios
    .map((scenario) => {
      const outcome = findScenarioOutcome(state, scenario);
      return `
        <button class="scenario-card scenario-card-button${scenario.id === state.selectedScenarioId ? " selected" : ""}" data-scenario-id="${escapeHtml(scenario.id)}">
          <header>
            <span class="scenario-surface">${escapeHtml(scenario.surface)}</span>
            ${renderStatusChip(outcome?.status ?? "pending")}
          </header>
          <strong>${escapeHtml(scenario.title)}</strong>
          <p>${escapeHtml(scenario.objective)}</p>
          <footer>
            <code>${escapeHtml(scenario.id)}</code>
            <span>${outcome?.steps?.length ?? scenario.successCriteria.length} checkpoints</span>
          </footer>
        </button>`;
    })
    .join("");
}

function renderScenarioInspector(state: UiState, scenarios: SeedScenario[]) {
  const scenario =
    scenarios.find((candidate) => candidate.id === state.selectedScenarioId) ??
    scenarios[0] ??
    null;
  if (!scenario) {
    return '<section class="panel"><h2>Scenario outcome</h2><p class="empty">No scenario selected.</p></section>';
  }
  const outcome = findScenarioOutcome(state, scenario);
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Scenario inspector</p>
          <h2>${escapeHtml(scenario.title)}</h2>
        </div>
        ${renderStatusChip(outcome?.status ?? "pending")}
      </div>
      <p class="scenario-objective">${escapeHtml(scenario.objective)}</p>
      <div class="meta-grid">
        <div>
          <span class="meta-label">Surface</span>
          <strong>${escapeHtml(scenario.surface)}</strong>
        </div>
        <div>
          <span class="meta-label">Started</span>
          <strong>${escapeHtml(formatIso(outcome?.startedAt))}</strong>
        </div>
        <div>
          <span class="meta-label">Finished</span>
          <strong>${escapeHtml(formatIso(outcome?.finishedAt))}</strong>
        </div>
        <div>
          <span class="meta-label">Run lane</span>
          <strong>${escapeHtml(state.scenarioRun?.kind ?? "seed only")}</strong>
        </div>
      </div>
      <div class="inspector-section">
        <h3>Success criteria</h3>
        <ul class="criteria-list">
          ${scenario.successCriteria.map((criterion) => `<li>${escapeHtml(criterion)}</li>`).join("")}
        </ul>
      </div>
      <div class="inspector-section">
        <h3>Observed outcome</h3>
        ${
          outcome
            ? `
              <p class="outcome-summary">${escapeHtml(outcome.details ?? "No summary details captured.")}</p>
              <div class="step-list">
                ${
                  outcome.steps?.length
                    ? outcome.steps
                        .map(
                          (step) => `
                            <article class="step-card">
                              <header>
                                <strong>${escapeHtml(step.name)}</strong>
                                ${renderStatusChip(step.status)}
                              </header>
                              ${
                                step.details
                                  ? `<pre class="step-details">${escapeHtml(step.details)}</pre>`
                                  : `<p class="empty">No extra details.</p>`
                              }
                            </article>`,
                        )
                        .join("")
                    : '<p class="empty">No step-level data captured yet.</p>'
                }
              </div>`
            : '<p class="empty">Not executed in the current run yet. Seed plan only.</p>'
        }
      </div>
      <div class="inspector-section">
        <h3>Docs refs</h3>
        <div class="ref-grid">${renderRefs(scenario.docsRefs, "docs")}</div>
      </div>
      <div class="inspector-section">
        <h3>Code refs</h3>
        <div class="ref-grid">${renderRefs(scenario.codeRefs, "code")}</div>
      </div>
    </section>`;
}

function renderRunPanel(state: UiState) {
  const run = state.scenarioRun;
  if (!run) {
    return `
      <section class="panel">
        <h2>Run state</h2>
        <p class="empty">No structured scenario run yet. Seed plan loaded; outcomes arrive once a suite or self-check starts.</p>
      </section>`;
  }
  return `
    <section class="panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Live run</p>
          <h2>${escapeHtml(run.kind === "suite" ? "Scenario suite" : "Self-check")}</h2>
        </div>
        <span class="status-chip status-${run.status === "completed" ? "pass" : run.status === "running" ? "running" : "pending"}">${escapeHtml(run.status)}</span>
      </div>
      <div class="run-grid">
        <div><span class="meta-label">Total</span><strong>${run.counts.total}</strong></div>
        <div><span class="meta-label">Pass</span><strong>${run.counts.passed}</strong></div>
        <div><span class="meta-label">Fail</span><strong>${run.counts.failed}</strong></div>
        <div><span class="meta-label">Pending</span><strong>${run.counts.pending}</strong></div>
      </div>
      <p class="subtle">Started ${escapeHtml(formatIso(run.startedAt))} · Finished ${escapeHtml(formatIso(run.finishedAt))}</p>
    </section>`;
}

function renderTabContent(state: UiState, scenarios: SeedScenario[]) {
  const selectedConversationId = deriveSelectedConversation(state);
  const selectedThreadId = deriveSelectedThread(state);
  const messages = filteredMessages({
    ...state,
    selectedConversationId,
    selectedThreadId,
  });
  const events = (state.snapshot?.events ?? []).slice(-40).reverse();
  const kickoffTask = state.bootstrap?.kickoffTask ?? "";

  if (state.activeTab === "scenarios") {
    return `
      <section class="panel plan-panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Seed plan</p>
            <h2>Scenario catalog</h2>
          </div>
          <span class="subtle">Click any scenario for full criteria and evidence.</span>
        </div>
        <pre class="report kickoff-report">${escapeHtml(kickoffTask || "No kickoff task loaded.")}</pre>
        <div class="scenario-board">
          ${renderScenarioBoard(state, scenarios)}
        </div>
      </section>`;
  }

  if (state.activeTab === "report") {
    return `
      <section class="panel">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Protocol</p>
            <h2>Latest report</h2>
          </div>
          <button data-action="download-report"${state.latestReport ? "" : " disabled"}>Export</button>
        </div>
        <pre class="report report-full">${escapeHtml(state.latestReport?.markdown ?? "Run the suite or self-check to capture a Markdown protocol report.")}</pre>
      </section>`;
  }

  if (state.activeTab === "events") {
    return `
      <section class="panel events">
        <div class="panel-header">
          <div>
            <p class="eyebrow">Wire view</p>
            <h2>Event stream</h2>
          </div>
          <span class="subtle">Newest first.</span>
        </div>
        <div class="stack event-list">
          ${
            events.length === 0
              ? '<p class="empty">No events yet.</p>'
              : events
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
                  .join("")
          }
        </div>
      </section>`;
  }

  return `
    <section class="panel transcript">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Live lane</p>
          <h2>Transcript</h2>
        </div>
        <span class="subtle">${escapeHtml(selectedConversationId ?? "No conversation selected")} · ${escapeHtml(selectedThreadId ?? "root thread")}</span>
      </div>
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
      <div class="panel-header">
        <div>
          <p class="eyebrow">Manual probe</p>
          <h2>Inject inbound</h2>
        </div>
        <span class="subtle">Useful for one-off regression pokes.</span>
      </div>
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
        <textarea id="composer-text" rows="5" placeholder="Ask the agent to prove something specific...">${escapeHtml(state.composer.text)}</textarea>
      </label>
      <div class="toolbar lower">
        <button class="accent" data-action="send"${state.busy ? " disabled" : ""}>Send inbound</button>
      </div>
    </section>`;
}

export function renderQaLabUi(state: UiState) {
  const selectedConversationId = deriveSelectedConversation(state);
  const selectedThreadId = deriveSelectedThread(state);
  const conversations = state.snapshot?.conversations ?? [];
  const threads = (state.snapshot?.threads ?? []).filter(
    (thread) => !selectedConversationId || thread.conversationId === selectedConversationId,
  );
  const scenarios = state.bootstrap?.scenarios ?? [];
  const hasControlUi = Boolean(state.bootstrap?.controlUiEmbeddedUrl);
  const dashboardShellClass = hasControlUi ? "dashboard split-dashboard" : "dashboard";
  const run = state.scenarioRun;

  return `
    <div class="${dashboardShellClass}">
      ${
        hasControlUi
          ? `
        <section class="control-pane panel">
          <div class="panel-header">
            <div>
              <p class="eyebrow">Agent control</p>
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
            <p class="eyebrow">Private QA workspace</p>
            <h1>QA Lab Debugger</h1>
            <p class="subtle">Editorial control-room view for seeded scenarios, live traffic, and protocol evidence.</p>
          </div>
          <div class="toolbar">
            <button data-action="refresh"${state.busy ? " disabled" : ""}>Refresh</button>
            <button data-action="reset"${state.busy ? " disabled" : ""}>Reset</button>
            <button class="accent" data-action="self-check"${state.busy ? " disabled" : ""}>Run self-check</button>
          </div>
        </header>
        <section class="statusbar">
          <span class="pill">${hasControlUi ? "Split view linked" : "QA-only view"}</span>
          <span class="pill">Scenarios ${scenarios.length}</span>
          <span class="pill">Conversation ${selectedConversationId ?? "none"}</span>
          <span class="pill">Thread ${selectedThreadId ?? "root"}</span>
          ${
            run
              ? `<span class="pill success">${escapeHtml(run.kind)} ${escapeHtml(run.status)} · ${run.counts.passed}/${run.counts.total} pass</span>`
              : '<span class="pill">No structured run yet</span>'
          }
          ${state.latestReport ? `<span class="pill">Report ${escapeHtml(state.latestReport.outputPath)}</span>` : '<span class="pill">No report yet</span>'}
          ${state.error ? `<span class="pill error">${escapeHtml(state.error)}</span>` : ""}
        </section>
        <main class="workspace">
          <aside class="rail">
            ${renderRunPanel(state)}
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
            <nav class="tabbar">
              <button class="tab-button${state.activeTab === "debug" ? " active" : ""}" data-tab="debug">Live debug</button>
              <button class="tab-button${state.activeTab === "scenarios" ? " active" : ""}" data-tab="scenarios">Seed scenarios</button>
              <button class="tab-button${state.activeTab === "report" ? " active" : ""}" data-tab="report">Protocol</button>
              <button class="tab-button${state.activeTab === "events" ? " active" : ""}" data-tab="events">Events</button>
            </nav>
            ${renderTabContent(state, scenarios)}
          </section>
          <aside class="right">
            <section class="panel">
              <div class="panel-header">
                <div>
                  <p class="eyebrow">Seed scenario deck</p>
                  <h2>Scenario navigator</h2>
                </div>
                <span class="subtle">Click to inspect.</span>
              </div>
              <div class="scenario-list">
                ${renderScenarioBoard(state, scenarios)}
              </div>
            </section>
            ${renderScenarioInspector(state, scenarios)}
          </aside>
        </main>
      </div>
    </div>`;
}

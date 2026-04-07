/* ===== Shared types (unchanged from the bus protocol) ===== */

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
  runner: RunnerSnapshot;
  runnerCatalog: {
    status: "loading" | "ready" | "failed";
    real: RunnerModelOption[];
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

export type RunnerSelection = {
  providerMode: "mock-openai" | "live-openai";
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  scenarioIds: string[];
};

export type RunnerSnapshot = {
  status: "idle" | "running" | "completed" | "failed";
  selection: RunnerSelection;
  startedAt?: string;
  finishedAt?: string;
  artifacts: null | {
    outputDir: string;
    reportPath: string;
    summaryPath: string;
    watchUrl: string;
  };
  error: string | null;
};

export type RunnerModelOption = {
  key: string;
  name: string;
  provider: string;
  input: string;
  preferred: boolean;
};

export type OutcomesEnvelope = {
  run: ScenarioRun | null;
};

export type TabId = "chat" | "results" | "report" | "events";

export type UiState = {
  theme: "light" | "dark";
  bootstrap: Bootstrap | null;
  snapshot: Snapshot | null;
  latestReport: ReportEnvelope["report"];
  scenarioRun: ScenarioRun | null;
  selectedConversationId: string | null;
  selectedThreadId: string | null;
  selectedScenarioId: string | null;
  activeTab: TabId;
  runnerDraft: RunnerSelection | null;
  runnerDraftDirty: boolean;
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

/* ===== Helpers ===== */

export function formatTime(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatIso(iso?: string) {
  if (!iso) {
    return "—";
  }
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function esc(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const MOCK_MODELS: RunnerModelOption[] = [
  {
    key: "mock-openai/gpt-5.4",
    name: "GPT-5.4 (mock)",
    provider: "mock-openai",
    input: "text",
    preferred: true,
  },
  {
    key: "mock-openai/gpt-5.4-alt",
    name: "GPT-5.4 Alt (mock)",
    provider: "mock-openai",
    input: "text",
    preferred: false,
  },
];

export function deriveSelectedConversation(state: UiState): string | null {
  return state.selectedConversationId ?? state.snapshot?.conversations[0]?.id ?? null;
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
    state.scenarioRun?.scenarios.find((o) => o.id === scenario.id) ??
    state.scenarioRun?.scenarios.find((o) => o.name === scenario.title) ??
    null
  );
}

function statusDotClass(status: ScenarioOutcome["status"] | "pending"): string {
  return `scenario-item-dot scenario-item-dot-${status}`;
}

function badgeHtml(status: string): string {
  const tone = status === "failed" ? "fail" : status === "completed" ? "pass" : status;
  return `<span class="badge badge-${esc(tone)}">${esc(status)}</span>`;
}

function deriveSelection(state: UiState): RunnerSelection | null {
  return state.runnerDraft ?? state.bootstrap?.runner.selection ?? null;
}

/* ===== Render: Header ===== */

function renderHeader(state: UiState): string {
  const runner = state.bootstrap?.runner ?? null;
  const run = state.scenarioRun;
  const controlUrl = state.bootstrap?.controlUiUrl;

  return `
    <header class="header">
      <div class="header-left">
        <span class="header-title">QA Lab</span>
        <div class="header-status">
          ${runner ? badgeHtml(runner.status) : ""}
          ${run ? `<span class="badge badge-accent">${run.counts.passed}/${run.counts.total} pass</span>` : ""}
          ${state.error ? `<span class="badge badge-fail">${esc(state.error)}</span>` : ""}
        </div>
      </div>
      <div class="header-right">
        ${controlUrl ? `<a class="header-link" href="${esc(controlUrl)}" target="_blank" rel="noreferrer">Control UI</a>` : ""}
        <button class="btn-ghost btn-sm" data-action="refresh"${state.busy ? " disabled" : ""}>Refresh</button>
        <button class="btn-ghost btn-sm" data-action="reset"${state.busy ? " disabled" : ""}>Reset</button>
        <button class="theme-toggle" data-action="toggle-theme" title="Toggle theme">${state.theme === "dark" ? "\u2600" : "\u263E"}</button>
      </div>
    </header>`;
}

/* ===== Render: Sidebar ===== */

function renderModelSelect(params: {
  id: string;
  label: string;
  value: string;
  options: RunnerModelOption[];
  disabled: boolean;
}): string {
  const values = new Set(params.options.map((o) => o.key));
  const options = [...params.options];
  if (!values.has(params.value) && params.value.trim()) {
    options.unshift({
      key: params.value,
      name: params.value,
      provider: params.value.split("/")[0] ?? "custom",
      input: "text",
      preferred: false,
    });
  }
  return `
    <div class="config-field">
      <span class="config-label">${esc(params.label)}</span>
      <select id="${esc(params.id)}"${params.disabled ? " disabled" : ""}>
        ${options
          .map(
            (o) =>
              `<option value="${esc(o.key)}"${o.key === params.value ? " selected" : ""}>${esc(o.key)}</option>`,
          )
          .join("")}
      </select>
    </div>`;
}

function renderSidebar(state: UiState): string {
  const scenarios = state.bootstrap?.scenarios ?? [];
  const selection = deriveSelection(state);
  const runner = state.bootstrap?.runner ?? null;
  const run = state.scenarioRun;
  const isRunning = runner?.status === "running";
  const realModels = state.bootstrap?.runnerCatalog.real ?? [];
  const modelOptions =
    selection?.providerMode === "live-openai" && realModels.length > 0 ? realModels : MOCK_MODELS;
  const selectedIds = new Set(selection?.scenarioIds ?? []);

  return `
    <aside class="sidebar">
      <!-- Configuration -->
      <div class="sidebar-section">
        <div class="sidebar-section-title"><h3>Configuration</h3></div>
        <div class="config-field">
          <span class="config-label">Provider lane</span>
          <select id="provider-mode"${isRunning ? " disabled" : ""}>
            <option value="mock-openai"${selection?.providerMode === "mock-openai" ? " selected" : ""}>Synthetic (mock)</option>
            <option value="live-openai"${selection?.providerMode === "live-openai" ? " selected" : ""}>Real providers</option>
          </select>
        </div>
        ${renderModelSelect({
          id: "primary-model",
          label: "Primary model",
          value: selection?.primaryModel ?? "",
          options: modelOptions,
          disabled: isRunning,
        })}
        ${renderModelSelect({
          id: "alternate-model",
          label: "Alternate model",
          value: selection?.alternateModel ?? "",
          options: modelOptions,
          disabled: isRunning,
        })}
        <div class="config-row">
          <label><input id="fast-mode" type="checkbox"${selection?.fastMode ? " checked" : ""}${isRunning ? " disabled" : ""} /> Fast mode</label>
        </div>
        ${
          selection?.providerMode === "live-openai"
            ? `<div class="config-hint">${esc(
                state.bootstrap?.runnerCatalog.status === "loading"
                  ? "Loading model catalog\u2026"
                  : state.bootstrap?.runnerCatalog.status === "failed"
                    ? "Catalog unavailable; using manual input."
                    : `${realModels.length} models available`,
              )}</div>`
            : ""
        }
      </div>

      <!-- Scenarios -->
      <div class="sidebar-section sidebar-scenarios">
        <div class="sidebar-section-title">
          <h3>Scenarios (${selectedIds.size}/${scenarios.length})</h3>
          <div class="btn-group">
            <button class="btn-sm btn-ghost" data-action="select-all-scenarios"${isRunning ? " disabled" : ""}>All</button>
            <button class="btn-sm btn-ghost" data-action="clear-scenarios"${isRunning ? " disabled" : ""}>None</button>
          </div>
        </div>
        <div class="scenario-scroll">
          ${scenarios
            .map((s) => {
              const outcome = findScenarioOutcome(state, s);
              const status = outcome?.status ?? "pending";
              return `
                <label class="scenario-item">
                  <input type="checkbox" data-scenario-toggle-id="${esc(s.id)}"${selectedIds.has(s.id) ? " checked" : ""}${isRunning ? " disabled" : ""} />
                  <span class="${statusDotClass(status)}"></span>
                  <div class="scenario-item-info">
                    <span class="scenario-item-title">${esc(s.title)}</span>
                    <span class="scenario-item-meta">${esc(s.surface)} · ${esc(s.id)}</span>
                  </div>
                </label>`;
            })
            .join("")}
        </div>
      </div>

      <!-- Actions -->
      <div class="sidebar-actions">
        <button class="btn-primary" data-action="run-suite"${isRunning || !selectedIds.size || state.busy ? " disabled" : ""}>
          Run ${selectedIds.size} scenario${selectedIds.size === 1 ? "" : "s"}
        </button>
        <div class="btn-row">
          <button data-action="self-check"${isRunning || state.busy ? " disabled" : ""}>Self-check</button>
          <button data-action="kickoff"${isRunning || state.busy ? " disabled" : ""}>Kickoff</button>
        </div>
      </div>

      <!-- Run status -->
      ${run || runner ? renderRunStatus(state) : ""}
    </aside>`;
}

function renderRunStatus(state: UiState): string {
  const run = state.scenarioRun;
  const runner = state.bootstrap?.runner ?? null;
  if (!run && !runner) {
    return "";
  }

  return `
    <div class="sidebar-section run-status">
      <div class="sidebar-section-title">
        <h3>Run Status</h3>
        ${runner ? badgeHtml(runner.status) : ""}
      </div>
      ${
        run
          ? `<div class="run-counts">
              <div class="run-count"><span class="run-count-value">${run.counts.total}</span><span class="run-count-label">Total</span></div>
              <div class="run-count"><span class="run-count-value count-pass">${run.counts.passed}</span><span class="run-count-label">Pass</span></div>
              <div class="run-count"><span class="run-count-value count-fail">${run.counts.failed}</span><span class="run-count-label">Fail</span></div>
              <div class="run-count"><span class="run-count-value">${run.counts.pending + run.counts.running}</span><span class="run-count-label">Left</span></div>
            </div>`
          : ""
      }
      <div class="run-meta">
        ${runner?.startedAt ? `Started ${esc(formatIso(runner.startedAt))}` : ""}
        ${runner?.finishedAt ? `<br>Finished ${esc(formatIso(runner.finishedAt))}` : ""}
        ${runner?.error ? `<br><span style="color:var(--danger)">${esc(runner.error)}</span>` : ""}
      </div>
    </div>`;
}

/* ===== Render: Tab bar ===== */

function renderTabBar(state: UiState): string {
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "chat", label: "Chat" },
    { id: "results", label: "Results" },
    { id: "report", label: "Report" },
    { id: "events", label: "Events" },
  ];
  return `
    <nav class="tab-bar">
      ${tabs
        .map(
          (t) =>
            `<button class="tab-btn${state.activeTab === t.id ? " active" : ""}" data-tab="${t.id}">${t.label}</button>`,
        )
        .join("")}
      <div class="tab-spacer"></div>
    </nav>`;
}

/* ===== Render: Chat tab ===== */

function renderChatView(state: UiState): string {
  const conversations = state.snapshot?.conversations ?? [];
  const channels = conversations.filter((c) => c.kind === "channel");
  const dms = conversations.filter((c) => c.kind === "direct");
  const threads = (state.snapshot?.threads ?? []).filter(
    (t) => !state.selectedConversationId || t.conversationId === state.selectedConversationId,
  );
  const selectedConv = deriveSelectedConversation(state);
  const selectedThread = deriveSelectedThread(state);
  const activeConversation = conversations.find((c) => c.id === selectedConv);
  const messages = filteredMessages({
    ...state,
    selectedConversationId: selectedConv,
    selectedThreadId: selectedThread,
  });

  return `
    <div class="chat-view">
      <!-- Channel / DM sidebar -->
      <aside class="chat-sidebar">
        <div class="chat-sidebar-scroll">
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-heading">Channels</div>
            <div class="chat-sidebar-list">
              ${
                channels.length === 0
                  ? '<div class="chat-sidebar-item" style="color:var(--text-tertiary);font-size:12px;cursor:default">No channels</div>'
                  : channels
                      .map(
                        (c) => `
                          <button class="chat-sidebar-item${c.id === selectedConv ? " active" : ""}" data-conversation-id="${esc(c.id)}">
                            <span class="chat-sidebar-icon">#</span>
                            <span class="chat-sidebar-label">${esc(c.title || c.id)}</span>
                          </button>`,
                      )
                      .join("")
              }
            </div>
          </div>
          <div class="chat-sidebar-section">
            <div class="chat-sidebar-heading">Direct Messages</div>
            <div class="chat-sidebar-list">
              ${
                dms.length === 0
                  ? '<div class="chat-sidebar-item" style="color:var(--text-tertiary);font-size:12px;cursor:default">No DMs</div>'
                  : dms
                      .map(
                        (c) => `
                          <button class="chat-sidebar-item${c.id === selectedConv ? " active" : ""}" data-conversation-id="${esc(c.id)}">
                            <span class="chat-sidebar-icon">\u25CF</span>
                            <span class="chat-sidebar-label">${esc(c.title || c.id)}</span>
                          </button>`,
                      )
                      .join("")
              }
            </div>
          </div>
          ${
            threads.length > 0
              ? `<div class="chat-sidebar-section">
                  <div class="chat-sidebar-heading">Threads</div>
                  <div class="chat-sidebar-list">
                    <button class="chat-sidebar-item${!selectedThread ? " active" : ""}" data-thread-select="root">
                      <span class="chat-sidebar-icon">\u2302</span>
                      <span class="chat-sidebar-label">Main timeline</span>
                    </button>
                    ${threads
                      .map(
                        (t) => `
                          <button class="chat-sidebar-item${t.id === selectedThread ? " active" : ""}" data-thread-select="${esc(t.id)}" data-thread-conv="${esc(t.conversationId)}">
                            <span class="chat-sidebar-icon">\u21B3</span>
                            <span class="chat-sidebar-label">${esc(t.title)}</span>
                          </button>`,
                      )
                      .join("")}
                  </div>
                </div>`
              : ""
          }
        </div>
      </aside>

      <!-- Main chat area -->
      <div class="chat-main">
        <!-- Channel header -->
        <div class="chat-channel-header">
          <span class="chat-channel-name">${esc(activeConversation?.title || selectedConv || "No conversation")}</span>
          ${activeConversation ? `<span class="chat-channel-kind">${activeConversation.kind}</span>` : ""}
          ${state.bootstrap?.runner.status === "running" ? '<span class="live-indicator"><span class="live-dot"></span>LIVE</span>' : ""}
        </div>

        <!-- Messages -->
        <div class="chat-messages" id="chat-messages">
          ${
            messages.length === 0
              ? '<div class="chat-empty">No messages yet. Run scenarios or send a message below.</div>'
              : messages.map((m) => renderMessage(m)).join("")
          }
        </div>

        <!-- Composer -->
        <div class="chat-composer">
          <div class="composer-context">
            <select id="conversation-kind">
              <option value="direct"${state.composer.conversationKind === "direct" ? " selected" : ""}>DM</option>
              <option value="channel"${state.composer.conversationKind === "channel" ? " selected" : ""}>Channel</option>
            </select>
            <span>as</span>
            <input id="sender-name" value="${esc(state.composer.senderName)}" placeholder="Name" />
            <span>in</span>
            <input id="conversation-id" value="${esc(state.composer.conversationId)}" placeholder="Conversation" />
            <input id="sender-id" type="hidden" value="${esc(state.composer.senderId)}" />
          </div>
          <div class="composer-input">
            <textarea id="composer-text" rows="1" placeholder="Type a message\u2026 (Enter to send, Shift+Enter for newline)">${esc(state.composer.text)}</textarea>
            <button class="btn-primary composer-send" data-action="send"${state.busy ? " disabled" : ""}>Send</button>
          </div>
        </div>
      </div>
    </div>`;
}

function messageAvatar(m: Message): { emoji: string; bg: string; role: string } {
  if (m.direction === "outbound") {
    return { emoji: "\uD83E\uDD80", bg: "#7c6cff", role: "Claw" }; // 🦀
  }
  return { emoji: "\uD83E\uDD9E", bg: "#d97706", role: "Clawfather" }; // 🦞
}

function renderMessage(m: Message): string {
  const name = m.senderName || m.senderId;
  const avatar = messageAvatar(m);
  const dirClass = m.direction === "inbound" ? "msg-direction-inbound" : "msg-direction-outbound";

  const metaTags: string[] = [];
  if (m.threadId) {
    metaTags.push(`<span class="msg-tag">thread ${esc(m.threadId)}</span>`);
  }
  if (m.editedAt) {
    metaTags.push('<span class="msg-tag">edited</span>');
  }
  if (m.deleted) {
    metaTags.push('<span class="msg-tag">deleted</span>');
  }

  const reactions =
    m.reactions.length > 0
      ? `<span class="msg-reactions">${m.reactions.map((r) => `<span class="msg-reaction">${esc(r.emoji)}</span>`).join("")}</span>`
      : "";

  return `
    <div class="msg msg-${m.direction}">
      <div class="msg-avatar" style="background:${avatar.bg}">${avatar.emoji}</div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-sender">${esc(name)}</span>
          <span class="msg-role">${esc(avatar.role)}</span>
          <span class="msg-direction ${dirClass}">${m.direction === "inbound" ? "\u2B06" : "\u2B07"}</span>
          <span class="msg-time">${formatTime(m.timestamp)}</span>
        </div>
        <div class="msg-text">${esc(m.text)}</div>
        ${metaTags.length > 0 || reactions ? `<div class="msg-meta">${metaTags.join("")}${reactions}</div>` : ""}
      </div>
    </div>`;
}

/* ===== Render: Results tab ===== */

function renderResultsView(state: UiState): string {
  const scenarios = state.bootstrap?.scenarios ?? [];
  const selected = scenarios.find((s) => s.id === state.selectedScenarioId) ?? scenarios[0] ?? null;

  return `
    <div class="results-view">
      <div class="results-list">
        ${scenarios.length === 0 ? '<div class="empty-state">No scenarios loaded.</div>' : ""}
        ${scenarios
          .map((s) => {
            const outcome = findScenarioOutcome(state, s);
            const status = outcome?.status ?? "pending";
            const isSelected = s.id === (selected?.id ?? null);
            return `
              <button class="result-card${isSelected ? " selected" : ""}" data-scenario-id="${esc(s.id)}">
                <span class="result-card-dot scenario-item-dot-${status}"></span>
                <div class="result-card-info">
                  <span class="result-card-title">${esc(s.title)}</span>
                  <span class="result-card-sub">${esc(s.surface)} · ${outcome?.steps?.length ?? s.successCriteria.length} steps</span>
                </div>
                ${badgeHtml(status)}
              </button>`;
          })
          .join("")}
      </div>
      <div class="results-inspector">
        ${selected ? renderInspector(state, selected) : '<div class="inspector-empty">Select a scenario</div>'}
      </div>
    </div>`;
}

function renderInspector(state: UiState, scenario: SeedScenario): string {
  const outcome = findScenarioOutcome(state, scenario);

  return `
    <div class="inspector-header">
      <div>
        <div class="inspector-title">${esc(scenario.title)}</div>
        ${badgeHtml(outcome?.status ?? "pending")}
      </div>
    </div>
    <div class="inspector-objective">${esc(scenario.objective)}</div>
    <div class="inspector-meta">
      <div class="inspector-meta-item"><span class="inspector-meta-label">Surface</span><span class="inspector-meta-value">${esc(scenario.surface)}</span></div>
      <div class="inspector-meta-item"><span class="inspector-meta-label">Started</span><span class="inspector-meta-value">${esc(formatIso(outcome?.startedAt))}</span></div>
      <div class="inspector-meta-item"><span class="inspector-meta-label">Finished</span><span class="inspector-meta-value">${esc(formatIso(outcome?.finishedAt))}</span></div>
      <div class="inspector-meta-item"><span class="inspector-meta-label">Run</span><span class="inspector-meta-value">${esc(state.scenarioRun?.kind ?? "seed only")}</span></div>
    </div>

    <div class="inspector-section">
      <div class="inspector-section-title">Success Criteria</div>
      <ul class="criteria-list">
        ${scenario.successCriteria.map((c) => `<li class="criteria-item"><span class="criteria-bullet"></span>${esc(c)}</li>`).join("")}
      </ul>
    </div>

    <div class="inspector-section">
      <div class="inspector-section-title">Observed Outcome</div>
      ${
        outcome
          ? `
            ${outcome.details ? `<div style="margin-bottom:12px;color:var(--text-secondary);font-size:13px">${esc(outcome.details)}</div>` : ""}
            <div class="step-list">
              ${
                outcome.steps?.length
                  ? outcome.steps
                      .map(
                        (step) => `
                          <div class="step-card">
                            <div class="step-card-header">
                              <span class="step-card-name">${esc(step.name)}</span>
                              ${badgeHtml(step.status)}
                            </div>
                            ${step.details ? `<div class="step-card-details">${esc(step.details)}</div>` : ""}
                          </div>`,
                      )
                      .join("")
                  : '<div class="empty-state">No step data yet.</div>'
              }
            </div>`
          : '<div class="empty-state">Not executed yet — seed plan only.</div>'
      }
    </div>

    ${
      scenario.docsRefs?.length
        ? `<div class="inspector-section">
            <div class="inspector-section-title">Docs</div>
            <div class="ref-list">${scenario.docsRefs.map((r) => `<span class="ref-tag">${esc(r)}</span>`).join("")}</div>
          </div>`
        : ""
    }
    ${
      scenario.codeRefs?.length
        ? `<div class="inspector-section">
            <div class="inspector-section-title">Code</div>
            <div class="ref-list">${scenario.codeRefs.map((r) => `<span class="ref-tag">${esc(r)}</span>`).join("")}</div>
          </div>`
        : ""
    }`;
}

/* ===== Render: Report tab ===== */

function renderReportView(state: UiState): string {
  return `
    <div class="report-view">
      <div class="report-toolbar">
        <span class="report-toolbar-title">Protocol Report</span>
        <button class="btn-sm" data-action="download-report"${state.latestReport ? "" : " disabled"}>Export Markdown</button>
      </div>
      <div class="report-content">
        <pre class="report-pre">${esc(state.latestReport?.markdown ?? "Run the suite or self-check to generate a report.")}</pre>
      </div>
    </div>`;
}

/* ===== Render: Events tab ===== */

function renderEventsView(state: UiState): string {
  const events = (state.snapshot?.events ?? []).slice(-60).toReversed();

  return `
    <div class="events-view">
      <div class="events-header">
        <span class="events-header-title">Event Stream</span>
        <span class="text-dimmed text-sm">${events.length} events (newest first)</span>
      </div>
      <div class="events-scroll">
        ${
          events.length === 0
            ? '<div class="empty-state" style="padding:20px">No events yet.</div>'
            : events
                .map((e) => {
                  const detail =
                    "thread" in e
                      ? `${e.thread.conversationId}/${e.thread.id}`
                      : e.message
                        ? `${e.message.senderId}: ${e.message.text}`
                        : "";
                  return `
                    <div class="event-row">
                      <span class="event-kind">${esc(e.kind)}</span>
                      <span class="event-cursor">#${e.cursor}</span>
                      <span class="event-detail">${esc(detail)}</span>
                    </div>`;
                })
                .join("")
        }
      </div>
    </div>`;
}

/* ===== Render: Active tab switch ===== */

function renderActiveTab(state: UiState): string {
  switch (state.activeTab) {
    case "chat":
      return renderChatView(state);
    case "results":
      return renderResultsView(state);
    case "report":
      return renderReportView(state);
    case "events":
      return renderEventsView(state);
    default:
      return renderChatView(state);
  }
}

/* ===== Main render ===== */

export function renderQaLabUi(state: UiState): string {
  return `
    <div class="app-shell" data-theme="${state.theme}">
      ${renderHeader(state)}
      <div class="layout">
        ${renderSidebar(state)}
        <main class="main-content">
          ${renderTabBar(state)}
          <div class="tab-content">
            ${renderActiveTab(state)}
          </div>
        </main>
      </div>
    </div>`;
}

import { findScenarioOutcome } from "./ui-render-scenario.js";
import { badgeHtml, esc, formatIso } from "./ui-render-utils.js";
import type { TabId, UiState } from "./ui-types.js";

const MOCK_MODELS = ["mock-openai/gpt-5.6-luna", "mock-openai/gpt-5.6-luna-alt"];

export function renderHeader(state: UiState): string {
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
        <button class="btn-ghost btn-sm" data-action="toggle-sidebar">${state.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}</button>
        <button class="btn-ghost btn-sm" data-action="refresh"${state.busy ? " disabled" : ""}>Refresh</button>
        <button class="btn-ghost btn-sm" data-action="reset"${state.busy ? " disabled" : ""}>Reset</button>
        <button class="theme-toggle" data-action="toggle-theme" title="Toggle theme">${state.theme === "dark" ? "\u2600" : "\u263E"}</button>
      </div>
    </header>`;
}

export function renderSidebar(state: UiState): string {
  const scenarios = state.bootstrap?.scenarios ?? [];
  const selection = state.runnerDraft ?? state.bootstrap?.runner.selection ?? null;
  const runner = state.bootstrap?.runner ?? null;
  const run = state.scenarioRun;
  const isRunning = runner?.status === "running";
  const realModels = state.bootstrap?.runnerCatalog.real ?? [];
  const modelOptions =
    selection?.providerMode === "live-frontier" && realModels.length > 0
      ? realModels.map((model) => model.key)
      : MOCK_MODELS;
  const plan = state.runnerPlanOverride ?? state.bootstrap?.runner.plan ?? null;
  const resolvedIds = plan?.selectedScenarios.map((scenario) => scenario.id) ?? [];
  const selectedIds = new Set(
    selection?.scenarioIds ?? (state.runnerDraftDirty ? [] : resolvedIds),
  );
  const profiles = state.bootstrap?.runnerCatalog.profiles ?? [];
  const channels = state.bootstrap?.runnerCatalog.channels ?? [];
  const hasRunnableSelection =
    selection?.scenarioIds === null
      ? Boolean(selection.profile)
      : Boolean(selection?.scenarioIds.length);

  const renderSelect = (
    id: string,
    label: string,
    value: string | undefined,
    options: ReadonlyArray<string | readonly [string, string]>,
  ) => `
    <div class="config-field">
      <label class="config-label" for="${esc(id)}">${esc(label)}</label>
      <select id="${esc(id)}"${isRunning ? " disabled" : ""}>
        ${options
          .map((option) => {
            const [key, text] = typeof option === "string" ? [option, option] : option;
            return `<option value="${esc(key)}"${key === value ? " selected" : ""}>${esc(text)}</option>`;
          })
          .join("")}
      </select>
    </div>`;
  const renderModel = (id: string, label: string, value: string) =>
    renderSelect(
      id,
      label,
      value,
      !modelOptions.includes(value) && value.trim() ? [value, ...modelOptions] : modelOptions,
    );

  return `
    <aside class="sidebar${state.sidebarCollapsed ? " is-collapsed" : ""}"${state.sidebarCollapsed || state.activeTab === "evidence" ? " inert" : ""}>
      <div class="sidebar-panel-tabs">
        <button class="btn-sm btn-ghost sidebar-panel-tab${state.sidebarPanel === "scenarios" ? " active" : ""}" data-sidebar-panel="scenarios">Scenarios</button>
        <button class="btn-sm btn-ghost sidebar-panel-tab${state.sidebarPanel === "config" ? " active" : ""}" data-sidebar-panel="config">Config</button>
        <button class="btn-sm btn-ghost sidebar-panel-tab${state.sidebarPanel === "run" ? " active" : ""}" data-sidebar-panel="run">Run</button>
      </div>
      ${
        state.sidebarPanel === "config"
          ? `<div class="sidebar-section sidebar-panel-body">
              <div class="sidebar-section-title"><h3>Configuration</h3></div>
              ${renderSelect(
                "run-profile",
                "Profile",
                selection?.profile,
                profiles.map((profile) => profile.id),
              )}
              ${renderSelect("provider-mode", "Provider lane", selection?.providerMode, [
                ["mock-openai", "Synthetic (mock)"],
                ["live-frontier", "Real frontier providers"],
              ])}
              ${renderSelect("channel-driver", "Channel driver", selection?.channelDriver, [
                ["qa-channel", "Synthetic QA channel"],
                ["crabline", "Crabline channel driver"],
                ["live", "Real channels"],
              ])}
              ${renderSelect("execution-channel", "Execution channel", selection?.channel || "", [
                ["", "Catalog/default"],
                ...channels,
              ])}
              ${renderSelect("evidence-mode", "Evidence mode", selection?.evidenceMode, [
                ["full", "Full"],
                ["slim", "Slim"],
              ])}
              ${renderSelect(
                "runtime-pair",
                "Runtime pair",
                selection?.runtimePair ? "openclaw,codex" : "",
                [
                  ["", "Single runtime"],
                  ["openclaw,codex", "OpenClaw × Codex"],
                ],
              )}
              ${renderSelect(
                "runtime-pair-lane",
                "Runtime-pair lane",
                selection?.runtimePairLane || "",
                [["", "Profile/default"], "core", "extended", "soak"],
              )}
              ${renderModel("primary-model", "Primary model", selection?.primaryModel ?? "")}
              ${renderModel("alternate-model", "Alternate model", selection?.alternateModel ?? "")}
              ${
                selection?.providerMode === "live-frontier"
                  ? `<div class="config-hint">${esc(
                      state.bootstrap?.runnerCatalog.status === "loading"
                        ? "Loading model catalog\u2026"
                        : state.bootstrap?.runnerCatalog.status === "failed"
                          ? "Catalog unavailable; using manual input."
                          : `${realModels.length} models available`,
                    )}</div>`
                  : ""
              }
            </div>`
          : state.sidebarPanel === "run"
            ? `<div class="sidebar-panel-body">${run || runner ? renderRunStatus(state) : '<div class="sidebar-section"><div class="text-dimmed text-sm">No run data yet.</div></div>'}</div>`
            : `<div class="sidebar-section sidebar-scenarios sidebar-panel-body">
                <div class="sidebar-section-title">
                  <h3>Scenarios (${selection?.scenarioIds === null ? "profile" : selectedIds.size}/${scenarios.length})</h3>
                  <div class="btn-group">
                    <button class="btn-sm btn-ghost" data-action="select-all-scenarios"${isRunning ? " disabled" : ""}>All</button>
                    <button class="btn-sm btn-ghost" data-action="clear-scenarios"${isRunning ? " disabled" : ""}>Profile</button>
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
                          <span class="scenario-item-dot scenario-item-dot-${status}"></span>
                          <div class="scenario-item-info">
                            <span class="scenario-item-title">${esc(s.title)}</span>
                            <span class="scenario-item-meta">${esc(s.surface)} · ${esc(s.execution?.kind ?? "flow")} · ${esc(s.id)}</span>
                          </div>
                        </label>`;
                    })
                    .join("")}
                </div>
              </div>`
      }

      <!-- Actions -->
      <div class="sidebar-actions">
        <button class="btn-primary" data-action="run-suite"${isRunning || !hasRunnableSelection || state.busy ? " disabled" : ""}>
          ${selection?.scenarioIds === null ? `Resolve & run ${esc(selection.profile)}` : `Run ${selectedIds.size} scenario${selectedIds.size === 1 ? "" : "s"}`}
        </button>
        <div class="btn-row">
          <button data-action="self-check"${isRunning || state.busy ? " disabled" : ""}>Self-check</button>
          <button data-action="kickoff"${isRunning || state.busy ? " disabled" : ""}>Kickoff</button>
        </div>
      </div>
    </aside>`;
}

function renderRunStatus(state: UiState): string {
  const run = state.scenarioRun;
  const runner = state.bootstrap?.runner ?? null;
  const plan = state.runnerPlanOverride ?? (state.runnerDraftDirty ? null : (runner?.plan ?? null));
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
        ${plan ? `<strong>Resolved plan:</strong> ${plan.selectedScenarios.length} selected · ${esc(plan.executionKinds.join(", ") || "none")}` : ""}
        ${plan?.exclusions.length ? `<br>${plan.exclusions.length} excluded: ${esc(plan.exclusions.map((item) => `${item.scenarioId} (${item.reasons.join(", ")})`).join("; "))}` : ""}
        ${plan?.errors.length ? `<br><span style="color:var(--danger)">${esc(plan.errors.join(" "))}</span>` : ""}
        ${runner?.startedAt ? `Started ${esc(formatIso(runner.startedAt))}` : ""}
        ${runner?.finishedAt ? `<br>Finished ${esc(formatIso(runner.finishedAt))}` : ""}
        ${runner?.error ? `<br><span style="color:var(--danger)">${esc(runner.error)}</span>` : ""}
      </div>
    </div>`;
}

export function renderTabBar(state: UiState): string {
  const tabs: Array<{ id: TabId; label: string }> = [
    { id: "chat", label: "Chat" },
    { id: "results", label: "Results" },
    { id: "evidence", label: "Evidence Archive" },
    { id: "report", label: "Report" },
    { id: "events", label: "Events" },
    { id: "capture", label: "Capture" },
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

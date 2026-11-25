import type { CaptureViewModel } from "./ui-render-capture-model.js";
import { esc } from "./ui-render-utils.js";

function renderCaptureSelect(
  label: string,
  id: string,
  selected: string | number,
  options: ReadonlyArray<string | readonly [value: string | number, label: string]>,
  disabled = false,
): string {
  return `<label>${label}
      <select id="capture-${id}"${disabled ? " disabled" : ""}>
        ${options
          .map((option) => {
            const [value, text] = typeof option === "string" ? [option, option] : option;
            return `<option value="${esc(String(value))}"${selected === value ? " selected" : ""}>${esc(text)}</option>`;
          })
          .join("\n        ")}
      </select>
    </label>`;
}

function renderCaptureFilter(
  label: string,
  id: string,
  values: string[],
  selected: string[],
): string {
  return `<label>${label}
      <select id="capture-${id}-filter" multiple size="${Math.min(6, Math.max(3, values.length || 3))}">
        ${values
          .map(
            (value) =>
              `<option value="${esc(value)}"${selected.includes(value) ? " selected" : ""}>${esc(value)}</option>`,
          )
          .join("")}
      </select>
    </label>`;
}

export function renderCaptureControls(model: CaptureViewModel): string {
  const {
    state,
    sessionIds,
    sessions,
    availableKinds,
    availableProviders,
    availableHosts,
    activeFilters,
    activeWindowStartPct,
    draftWindowStartPct,
    selectedSessions,
    selectedEvent,
  } = model;
  return `  <div class="capture-controls-shell">
    <div class="capture-controls-toolbar">
      <div class="capture-controls-summary">
        <span class="capture-chip capture-chip-muted">${selectedSessions.length || 0} session${selectedSessions.length === 1 ? "" : "s"}</span>
        <span class="capture-chip capture-chip-muted">${state.captureViewMode}</span>
        ${
          state.captureQueryPreset !== "none"
            ? `<span class="capture-chip capture-chip-muted">analysis: ${esc(state.captureQueryPreset)}</span>`
            : `<span class="capture-chip capture-chip-muted">raw only</span>`
        }
        <span class="capture-chip capture-chip-muted">${activeFilters.length} filter${activeFilters.length === 1 ? "" : "s"}</span>
        ${
          state.captureViewMode === "timeline"
            ? `<span class="capture-chip capture-chip-muted">lanes: ${esc(state.captureTimelineLaneMode)}</span>`
            : ""
        }
      </div>
      <div class="capture-controls-actions">
        ${
          selectedSessions.length > 0
            ? `<button class="btn-sm" type="button" id="capture-summary-toggle">
                ${state.captureSummaryExpanded ? "Hide summary" : "Show summary"}
              </button>`
            : ""
        }
        ${
          activeFilters.length > 0
            ? `<button
                id="capture-clear-filters"
                class="secondary-button capture-clear-filters"
                type="button"
              >Clear filters</button>`
            : ""
        }
        <button class="btn-sm" type="button" id="capture-controls-toggle">
          ${state.captureControlsExpanded ? "Collapse controls" : "Show controls"}
        </button>
      </div>
    </div>
    ${
      state.captureControlsExpanded
        ? `<div class="capture-controls-panel">
  <div class="capture-controls-grid">
    <label class="capture-session-filter">Session
      <select id="capture-session" multiple size="${Math.min(3, Math.max(2, sessions.length || 2))}">
        ${sessions
          .map(
            (session) =>
              `<option value="${esc(session.id)}"${
                sessionIds.includes(session.id) ? " selected" : ""
              }>${esc(new Date(session.startedAt).toLocaleString())} · ${esc(session.mode)} · ${session.eventCount} events</option>`,
          )
          .join("")}
      </select>
    </label>
    <div class="capture-inline-actions">
      <label class="capture-saved-view-filter">Saved view
        <select id="capture-saved-view">
          <option value="">apply saved view…</option>
          ${state.captureSavedViews
            .map((view) => `<option value="${esc(view.id)}">${esc(view.name)}</option>`)
            .join("")}
        </select>
      </label>
      <button id="capture-save-view" class="btn-sm" type="button">Save view</button>
      <button
        id="capture-delete-view"
        class="btn-sm"
        type="button"${state.captureSavedViews.length === 0 ? " disabled" : ""}
      >Delete view</button>
    </div>
    ${
      selectedSessions.length > 0
        ? `<div class="capture-selected-sessions-shell">
            <div class="capture-selected-sessions-summary">
              <span class="capture-chip capture-chip-muted">${selectedSessions.length} selected</span>
              ${
                selectedSessions.length > 1
                  ? `<button
                      id="capture-toggle-selected-sessions"
                      class="btn-sm"
                      type="button"
                    >${state.captureSelectedSessionsExpanded ? "Hide selected" : "Manage selected"}</button>`
                  : ""
              }
            </div>
            ${
              state.captureSelectedSessionsExpanded || selectedSessions.length === 1
                ? `<div class="capture-selected-sessions">
                    ${selectedSessions
                      .map(
                        (session) => `<button
                          type="button"
                          class="capture-selected-session-chip"
                          data-capture-session-remove="${esc(session.id)}"
                          title="Remove ${esc(new Date(session.startedAt).toLocaleString())}"
                          aria-label="Remove ${esc(new Date(session.startedAt).toLocaleString())}"
                        >
                          <span class="capture-selected-session-chip-label">${esc(new Date(session.startedAt).toLocaleString())}</span>
                          <svg class="capture-selected-session-chip-x" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            <path d="m6 6 12 12M6 18 18 6" />
                          </svg>
                        </button>`,
                      )
                      .join("")}
                  </div>`
                : ""
            }
          </div>`
        : ""
    }
    <div class="capture-inline-actions">
      <button
        id="capture-delete-selected-sessions"
        class="btn-sm"
        type="button"${selectedSessions.length === 0 ? " disabled" : ""}
      >Delete selected data</button>
      <button
        id="capture-purge-all"
        class="btn-sm"
        type="button"${sessions.length === 0 ? " disabled" : ""}
      >Purge all data</button>
    </div>
    ${renderCaptureSelect("Analysis", "preset", state.captureQueryPreset, [
      ["none", "none (show raw events only)"],
      "double-sends",
      "retry-storms",
      "cache-busting",
      "ws-duplicate-frames",
      "missing-ack",
      "error-bursts",
    ])}
    ${renderCaptureFilter("Kind", "kind", availableKinds, state.captureKindFilter)}
    ${renderCaptureFilter("Provider", "provider", availableProviders, state.captureProviderFilter)}
    ${renderCaptureFilter("Host", "host", availableHosts, state.captureHostFilter)}
    ${renderCaptureSelect("View", "view-mode", state.captureViewMode, ["list", "timeline"])}
    ${
      state.captureViewMode === "timeline"
        ? `
    ${renderCaptureSelect("Timeline Lanes", "timeline-lane-mode", state.captureTimelineLaneMode, ["domain", "provider", "flow"])}
    ${renderCaptureSelect("Lane Sort", "timeline-lane-sort", state.captureTimelineLaneSort, [
      ["most-events", "most events"],
      ["most-errors", "most errors"],
      "severity",
      "alphabetical",
    ])}
    <label class="capture-search-field">Lane Search
      <input
        id="capture-timeline-lane-search"
        type="search"
        value="${esc(state.captureTimelineLaneSearch)}"
        placeholder="provider, host, flow..."
        spellcheck="false"
      />
    </label>
    ${renderCaptureSelect(
      "Timeline Zoom",
      "timeline-zoom",
      state.captureTimelineZoom,
      [75, 100, 150, 200, 300].map((zoom) => [zoom, `${zoom}%`] as const),
    )}
    ${renderCaptureSelect("Sparkline", "timeline-sparkline-mode", state.captureTimelineSparklineMode, ["session-relative", "lane-relative"])}
    <button
      id="capture-timeline-clear-window"
      class="secondary-button capture-clear-filters"
      type="button"${activeWindowStartPct == null && draftWindowStartPct == null ? " disabled" : ""}
    >Clear window</button>
    <label class="capture-checkbox">
      <input
        id="capture-timeline-focus-flow"
        type="checkbox"${
          state.captureTimelineFocusSelectedFlow ? " checked" : ""
        }${selectedEvent?.flowId ? "" : " disabled"}
      />
      <span>focus selected flow</span>
    </label>
    ${renderCaptureSelect(
      "Focused Lanes",
      "timeline-focused-lane-mode",
      state.captureTimelineFocusedLaneMode,
      [
        ["all", "show all"],
        ["only-matching", "only matching"],
        ["collapse-background", "collapse background"],
      ],
      !(state.captureTimelineFocusSelectedFlow && selectedEvent?.flowId),
    )}
    ${renderCaptureSelect(
      "Focus Threshold",
      "timeline-focused-lane-threshold",
      state.captureTimelineFocusedLaneThreshold,
      [
        ["any", "any presence"],
        ["events-2", "2+ events"],
        ["percent-10", "10%+ of lane"],
        ["percent-25", "25%+ of lane"],
      ],
      !(state.captureTimelineFocusSelectedFlow && selectedEvent?.flowId),
    )}`
        : `
    ${renderCaptureSelect("Group", "group-mode", state.captureGroupMode, [
      ["none", "flat stream"],
      ["burst", "burst clusters"],
      ["flow", "flow id"],
      ["host-path", "host + path"],
    ])}`
    }
    ${renderCaptureSelect("Detail Pane", "detail-placement", state.captureDetailPlacement, ["right", "bottom"])}
    ${renderCaptureSelect("Headers", "header-mode", state.captureHeaderMode, [["key", "key only"], "all", "hidden"])}
    <label class="capture-search-field">Search
      <input
        id="capture-search-filter"
        type="search"
        value="${esc(state.captureSearchText)}"
        placeholder="host, path, method, status, payload..."
        spellcheck="false"
      />
    </label>
    <label class="capture-checkbox">
      <input id="capture-errors-only" type="checkbox"${state.captureErrorsOnly ? " checked" : ""} />
      <span>errors only</span>
    </label>
  </div></div>`
        : ""
    }
  </div>
  ${
    state.captureControlsExpanded && activeFilters.length > 0
      ? `<div class="capture-active-filters">
          <span class="capture-summary-label" style="margin:0">Active Filters</span>
          <div class="capture-chip-row">
            ${activeFilters.map((filter) => `<span class="capture-chip capture-chip-muted">${esc(filter)}</span>`).join("")}
          </div>
        </div>`
      : ""
  }
`;
}

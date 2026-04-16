import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  buildFullWorkflowArgs,
  deriveQuestionSavePath,
  friendlyError,
  manifestOutputCategories,
  normalizePathList,
  normalizeScenarios,
  summarizeQa,
} from "./workbench.js";

type ApiResult<T = unknown> = {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  json?: T;
  jsonParseError?: string;
  error?: string;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type ToolCheck = {
  name: string;
  id: string;
  status: string;
  detail: string;
  category: string;
  profile: string;
};

type DoctorResult = {
  ok: boolean;
  checks: ToolCheck[];
};

type WorkspaceArtifacts = {
  workspace: string;
  runId: string;
  manifest: Record<string, unknown> | null;
  qaReport: Record<string, unknown> | null;
  workflowReport: Record<string, unknown> | null;
  reportMarkdown: string | null;
  files: string[];
  filesTruncated: boolean;
};

type AppState = {
  workspace: string;
  runId: string;
  inputPaths: string;
  questionPath: string;
  scenarios: string;
  skipBridges: boolean;
  busy: boolean;
  status: string;
  doctor: DoctorResult | null;
  artifacts: WorkspaceArtifacts | null;
  commandLog: string[];
  onboarded: boolean;
};

const state: AppState = {
  workspace: localStorage.getItem("clawmodeler.workspace") || "/tmp/clawmodeler-workbench",
  runId: localStorage.getItem("clawmodeler.runId") || "demo",
  inputPaths: localStorage.getItem("clawmodeler.inputPaths") || "",
  questionPath: localStorage.getItem("clawmodeler.questionPath") || "",
  scenarios: localStorage.getItem("clawmodeler.scenarios") || "baseline",
  skipBridges: localStorage.getItem("clawmodeler.skipBridges") === "true",
  busy: false,
  status: "Ready",
  doctor: null,
  artifacts: null,
  commandLog: [],
  onboarded: localStorage.getItem("clawmodeler.onboarded") === "true",
};

function markOnboarded() {
  state.onboarded = true;
  localStorage.setItem("clawmodeler.onboarded", "true");
}

function requireAppRoot(): HTMLDivElement {
  const element = document.querySelector<HTMLDivElement>("#app");
  if (!element) {
    throw new Error("Missing #app root");
  }
  return element;
}

const appRoot = requireAppRoot();

function escapeHtml(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function stringField(payload: Record<string, unknown>, key: string, fallback = ""): string {
  const value = payload[key];
  return typeof value === "string" ? value : fallback;
}

function saveForm() {
  localStorage.setItem("clawmodeler.workspace", state.workspace);
  localStorage.setItem("clawmodeler.runId", state.runId);
  localStorage.setItem("clawmodeler.inputPaths", state.inputPaths);
  localStorage.setItem("clawmodeler.questionPath", state.questionPath);
  localStorage.setItem("clawmodeler.scenarios", state.scenarios);
  localStorage.setItem("clawmodeler.skipBridges", String(state.skipBridges));
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

async function tauriApi<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  if (path === "/api/clawmodeler/doctor") {
    return await invoke<ApiResult<T>>("clawmodeler_doctor");
  }
  if (path === "/api/clawmodeler/tools") {
    return await invoke<ApiResult<T>>("clawmodeler_tools");
  }
  if (path.startsWith("/api/clawmodeler/workspace")) {
    const url = new URL(path, "http://127.0.0.1");
    return await invoke<ApiResult<T>>("clawmodeler_workspace", {
      workspace: url.searchParams.get("workspace") ?? "",
      runId: url.searchParams.get("runId") ?? "demo",
    });
  }
  const payload = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (path === "/api/clawmodeler/init") {
    return await invoke<ApiResult<T>>("clawmodeler_run", {
      args: ["init", "--workspace", stringField(payload, "workspace")],
    });
  }
  if (path === "/api/clawmodeler/demo-full") {
    return await invoke<ApiResult<T>>("clawmodeler_run", {
      args: [
        "workflow",
        "demo-full",
        "--workspace",
        stringField(payload, "workspace"),
        "--run-id",
        stringField(payload, "runId", "demo"),
      ],
    });
  }
  if (path === "/api/clawmodeler/diagnose") {
    const args = ["workflow", "diagnose", "--workspace", stringField(payload, "workspace")];
    const runId = stringField(payload, "runId").trim();
    if (runId) {
      args.push("--run-id", runId);
    }
    return await invoke<ApiResult<T>>("clawmodeler_run", { args });
  }
  if (path === "/api/clawmodeler/report-only") {
    return await invoke<ApiResult<T>>("clawmodeler_run", {
      args: [
        "workflow",
        "report-only",
        "--workspace",
        stringField(payload, "workspace"),
        "--run-id",
        stringField(payload, "runId", "demo"),
      ],
    });
  }
  if (path === "/api/clawmodeler/run") {
    return await invoke<ApiResult<T>>("clawmodeler_run", { args: payload.args });
  }
  throw new Error(`Unsupported ClawModeler API path: ${path}`);
}

async function api<T = unknown>(path: string, body?: unknown): Promise<ApiResult<T>> {
  if (isTauriRuntime()) {
    const payload = await tauriApi<T>(path, body);
    if (!payload.ok) {
      throw apiError(payload.stderr || payload.error || "ClawModeler command failed", payload);
    }
    return payload;
  }

  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json()) as ApiResult<T>;
  if (!response.ok || !payload.ok) {
    throw apiError(payload.stderr || payload.error || `HTTP ${response.status}`, payload);
  }
  return payload;
}

type ApiError<T> = Error & { payload?: ApiResult<T> };

function apiError<T>(message: string, payload: ApiResult<T>): ApiError<T> {
  const error = new Error(message) as ApiError<T>;
  error.payload = payload;
  return error;
}

async function runAction<T>(label: string, task: () => Promise<ApiResult<T>>) {
  state.busy = true;
  state.status = label;
  state.commandLog = [`${new Date().toLocaleTimeString()} ${label}`, ...state.commandLog].slice(
    0,
    12,
  );
  render();
  try {
    const result = await task();
    state.status = "Done";
    if (result.stdout) {
      state.commandLog = [result.stdout.trim(), ...state.commandLog].slice(0, 12);
    }
    await refreshArtifacts(false);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    state.status = friendlyError(raw);
  } finally {
    state.busy = false;
    render();
  }
}

async function refreshDoctor() {
  await runAction("Checking local modeling stack", async () => {
    try {
      const result = await api<DoctorResult>("/api/clawmodeler/doctor");
      state.doctor = result.json ?? null;
      return result;
    } catch (error) {
      const payload = (error as ApiError<DoctorResult>).payload;
      if (payload?.json) {
        state.doctor = payload.json;
      }
      throw error;
    }
  });
}

async function refreshArtifacts(showBusy = true) {
  saveForm();
  const path = `/api/clawmodeler/workspace?workspace=${encodeURIComponent(
    state.workspace,
  )}&runId=${encodeURIComponent(state.runId)}`;
  if (showBusy) {
    state.busy = true;
    state.status = "Reading workspace artifacts";
    render();
  }
  try {
    const result = await api<WorkspaceArtifacts>(path);
    state.artifacts = result.json ?? null;
    state.status = "Workspace loaded";
  } catch (error) {
    if (showBusy) {
      const raw = error instanceof Error ? error.message : String(error);
      state.status = friendlyError(raw);
    }
  } finally {
    if (showBusy) {
      state.busy = false;
      render();
    }
  }
}

async function pickWorkspaceFolder() {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Pick workspace folder",
    });
    if (typeof selected === "string" && selected) {
      state.workspace = selected;
      saveForm();
      render();
    }
  } catch (error) {
    state.status = friendlyError(error instanceof Error ? error.message : String(error));
    render();
  }
}

async function pickInputFiles() {
  try {
    const selected = await open({
      directory: false,
      multiple: true,
      title: "Pick input files",
      filters: [
        { name: "Planning data", extensions: ["geojson", "json", "csv", "parquet", "tsv"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (Array.isArray(selected) && selected.length > 0) {
      const existing = state.inputPaths.trim();
      const existingSet = new Set(
        existing
          ? existing
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
          : [],
      );
      const toAdd = selected.filter((path) => !existingSet.has(path.trim()));
      if (toAdd.length > 0) {
        const appended = toAdd.join("\n");
        state.inputPaths = existing ? `${existing}\n${appended}` : appended;
        saveForm();
        render();
      }
    }
  } catch (error) {
    state.status = friendlyError(error instanceof Error ? error.message : String(error));
    render();
  }
}

async function pickQuestionFile() {
  try {
    const selected = await open({
      directory: false,
      multiple: false,
      title: "Pick question.json",
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (typeof selected === "string" && selected) {
      state.questionPath = selected;
      saveForm();
      render();
    }
  } catch (error) {
    state.status = friendlyError(error instanceof Error ? error.message : String(error));
    render();
  }
}

async function createStarterQuestion() {
  let selected: string | null;
  try {
    selected = await save({
      title: "Save starter question.json",
      defaultPath: deriveQuestionSavePath(state.workspace, state.questionPath),
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
  } catch (error) {
    state.status = friendlyError(error instanceof Error ? error.message : String(error));
    render();
    return;
  }
  if (typeof selected !== "string" || !selected) {
    return;
  }
  await runAction("Creating starter question.json", async () => {
    const result = await api<{ question_path: string; created: boolean }>("/api/clawmodeler/run", {
      args: ["scaffold", "question", "--path", selected, "--force"],
    });
    const created = result.json?.question_path ?? selected;
    state.questionPath = created;
    saveForm();
    return result;
  });
}

function bindControls() {
  appRoot.querySelector<HTMLInputElement>("#workspace")?.addEventListener("input", (event) => {
    state.workspace = (event.target as HTMLInputElement).value;
    saveForm();
  });
  appRoot.querySelector<HTMLInputElement>("#run-id")?.addEventListener("input", (event) => {
    state.runId = (event.target as HTMLInputElement).value;
    saveForm();
  });
  appRoot.querySelector<HTMLTextAreaElement>("#input-paths")?.addEventListener("input", (event) => {
    state.inputPaths = (event.target as HTMLTextAreaElement).value;
    saveForm();
  });
  appRoot.querySelector<HTMLInputElement>("#question-path")?.addEventListener("input", (event) => {
    state.questionPath = (event.target as HTMLInputElement).value;
    saveForm();
  });
  appRoot.querySelector<HTMLInputElement>("#scenarios")?.addEventListener("input", (event) => {
    state.scenarios = (event.target as HTMLInputElement).value;
    saveForm();
  });
  appRoot.querySelector<HTMLInputElement>("#skip-bridges")?.addEventListener("change", (event) => {
    state.skipBridges = (event.target as HTMLInputElement).checked;
    saveForm();
  });

  appRoot
    .querySelector<HTMLButtonElement>("[data-action='doctor']")
    ?.addEventListener("click", () => {
      void refreshDoctor();
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='init']")
    ?.addEventListener("click", () => {
      void runAction("Creating workspace", () =>
        api("/api/clawmodeler/init", { workspace: state.workspace }),
      );
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='demo']")
    ?.addEventListener("click", () => {
      markOnboarded();
      void runAction("Running demo workflow", () =>
        api("/api/clawmodeler/demo-full", { workspace: state.workspace, runId: state.runId }),
      );
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='dismiss-welcome']")
    ?.addEventListener("click", () => {
      markOnboarded();
      render();
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='pick-workspace']")
    ?.addEventListener("click", () => {
      void pickWorkspaceFolder();
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='pick-inputs']")
    ?.addEventListener("click", () => {
      void pickInputFiles();
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='pick-question']")
    ?.addEventListener("click", () => {
      void pickQuestionFile();
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='create-question']")
    ?.addEventListener("click", () => {
      void createStarterQuestion();
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='full']")
    ?.addEventListener("click", () => {
      const inputs = normalizePathList(state.inputPaths);
      const question = state.questionPath.trim();
      if (inputs.length === 0 || !question) {
        state.status =
          "Before running the full workflow, fill in at least one input path and a question.json path. New? Try 'Run the demo' first — no files required.";
        render();
        return;
      }
      void runAction("Running full workflow", () =>
        api("/api/clawmodeler/run", {
          args: buildFullWorkflowArgs({
            workspace: state.workspace,
            inputs,
            question,
            runId: state.runId,
            scenarios: normalizeScenarios(state.scenarios),
            skipBridges: state.skipBridges,
          }),
        }),
      );
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='diagnose']")
    ?.addEventListener("click", () => {
      void runAction("Diagnosing workspace", () =>
        api("/api/clawmodeler/diagnose", { workspace: state.workspace, runId: state.runId }),
      );
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='report']")
    ?.addEventListener("click", () => {
      void runAction("Regenerating report", () =>
        api("/api/clawmodeler/report-only", { workspace: state.workspace, runId: state.runId }),
      );
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='refresh']")
    ?.addEventListener("click", () => {
      void refreshArtifacts();
    });
}

function renderWelcome(): string {
  if (state.onboarded || state.artifacts?.manifest) {
    return "";
  }
  return `
    <section class="welcome-banner">
      <div class="welcome-copy">
        <p class="eyebrow">Start here</p>
        <h2>New to ClawModeler? Run the demo first.</h2>
        <p>One click builds a complete sample analysis — workspace, scenarios, QA gates, and a plain-English report. No files or setup required.</p>
      </div>
      <div class="welcome-cta">
        <button data-action="demo" class="primary-cta" ${state.busy ? "disabled" : ""}>Run the demo</button>
        <button data-action="dismiss-welcome" class="link-btn" ${state.busy ? "disabled" : ""}>Skip — I'll set up my own project</button>
      </div>
    </section>
  `;
}

function renderDoctor() {
  if (!state.doctor) {
    return `<p class="muted">Doctor checks which local tools are installed. You need Python 3 — everything else is optional for the demo.</p>`;
  }
  const checks = state.doctor.checks.slice(0, 18);
  return `
    <div class="tool-grid">
      ${checks
        .map(
          (check) => `
            <div class="tool-row">
              <span class="status-dot ${escapeHtml(check.status)}"></span>
              <span>${escapeHtml(check.name)}</span>
              <small>${escapeHtml(check.profile)} / ${escapeHtml(check.category)}</small>
            </div>
          `,
        )
        .join("")}
    </div>
  `;
}

function renderArtifacts() {
  const artifacts = state.artifacts;
  const qa = summarizeQa(artifacts?.qaReport ?? null);
  const categories = manifestOutputCategories(artifacts?.manifest ?? null);
  const report = artifacts?.reportMarkdown?.trim();

  return `
    <section class="panel qa-panel ${qa.tone}">
      <div>
        <p class="eyebrow"><span class="step-num">3</span> ClawQA</p>
        <h2>${escapeHtml(qa.label)}</h2>
        <p>${qa.blockers.length > 0 ? escapeHtml(qa.blockers.join(", ")) : "No blockers recorded."}</p>
      </div>
      <div class="metric-stack">
        <span>${escapeHtml(artifacts?.runId ?? state.runId)}</span>
        <small>run id</small>
      </div>
    </section>

    <section class="panel">
      <div class="section-head">
        <div>
          <p class="eyebrow">Outputs</p>
          <h2>Artifacts</h2>
        </div>
        <span>${categories.length} categories</span>
      </div>
      ${
        artifacts?.files.length
          ? `<ul class="artifact-list">${artifacts.files
              .slice(0, 80)
              .map((file) => `<li>${escapeHtml(file)}</li>`)
              .join("")}</ul>`
          : `<p class="muted">Run a workflow to create manifests, tables, bridge packages, and reports.</p>`
      }
    </section>

    <section class="panel report-panel">
      <div class="section-head">
        <div>
          <p class="eyebrow"><span class="step-num">4</span> Narrative</p>
          <h2>Report Preview</h2>
        </div>
        <span>${report ? "Markdown" : "Waiting"}</span>
      </div>
      <pre>${escapeHtml(report || "No report yet. Run a workflow to generate a plain-English summary you can share with a client or stakeholder.")}</pre>
    </section>
  `;
}

function render() {
  appRoot.innerHTML = `
    <main class="shell">
      <aside class="rail">
        <div class="brand">
          <div class="brand-mark">CM</div>
          <div>
            <strong>ClawModeler</strong>
            <span>Screening workbench</span>
          </div>
        </div>
        <nav>
          <a href="#workspace">Workspace</a>
          <a href="#run">Run</a>
          <a href="#qa">QA</a>
          <a href="#report">Report</a>
        </nav>
        <p class="rail-note">Screening-level outputs. Use a detailed modeling workflow for final engineering decisions.</p>
      </aside>

      <section class="content">
        <header class="topbar">
          <div>
            <p class="eyebrow">Transportation sketch-planning, on your computer</p>
            <h1>Run a screening analysis without spreadsheets or cloud uploads.</h1>
          </div>
          <div class="run-state ${state.busy ? "busy" : ""}">
            <span></span>
            ${escapeHtml(state.status)}
          </div>
        </header>

        ${renderWelcome()}

        <section class="map-strip" aria-label="Planning map">
          <div class="route r1"></div>
          <div class="route r2"></div>
          <div class="route r3"></div>
          <div class="zone z1">North</div>
          <div class="zone z2">Core</div>
          <div class="zone z3">South</div>
        </section>

        <div class="layout">
          <section class="panel workspace-panel" id="workspace">
            <div class="section-head">
              <div>
                <p class="eyebrow"><span class="step-num">1</span> Workspace</p>
                <h2>Project Setup</h2>
              </div>
              <button data-action="doctor" ${state.busy ? "disabled" : ""}>Doctor</button>
            </div>

            <label>
              <span class="label-row">
                <span>Workspace path</span>
                <button type="button" data-action="pick-workspace" class="pick-btn" ${!isTauriRuntime() || state.busy ? "disabled" : ""} title="${isTauriRuntime() ? "Browse for a folder" : "Available in the desktop app"}">Pick folder…</button>
              </span>
              <input id="workspace" value="${escapeHtml(state.workspace)}" spellcheck="false" />
              <small class="help">Folder on your computer where ClawModeler stores this project's files. Pick an empty folder — it will be created if it doesn't exist.</small>
            </label>
            <label>
              Run ID
              <input id="run-id" value="${escapeHtml(state.runId)}" spellcheck="false" />
              <small class="help">Short name for this analysis run (e.g., "demo", "2026-baseline"). Used to name the output folder.</small>
            </label>
            <label>
              <span class="label-row">
                <span>Input paths</span>
                <button type="button" data-action="pick-inputs" class="pick-btn" ${!isTauriRuntime() || state.busy ? "disabled" : ""} title="${isTauriRuntime() ? "Browse for data files to add" : "Available in the desktop app"}">Add files…</button>
              </span>
              <textarea id="input-paths" rows="5" spellcheck="false" placeholder="/path/zones.geojson&#10;/path/socio.csv&#10;/path/projects.csv">${escapeHtml(
                state.inputPaths,
              )}</textarea>
              <small class="help">One path per line. Typical inputs: zones (GeoJSON), socio-economic data (CSV), projects (CSV). Leave blank to use the built-in demo.</small>
            </label>
            <label>
              <span class="label-row">
                <span>Question JSON</span>
                <span class="label-row-actions">
                  <button type="button" data-action="create-question" class="pick-btn" ${!isTauriRuntime() || state.busy ? "disabled" : ""} title="${isTauriRuntime() ? "Write a starter question.json you can edit" : "Available in the desktop app"}">Create starter…</button>
                  <button type="button" data-action="pick-question" class="pick-btn" ${!isTauriRuntime() || state.busy ? "disabled" : ""} title="${isTauriRuntime() ? "Browse for a question.json file" : "Available in the desktop app"}">Pick file…</button>
                </span>
              </span>
              <input id="question-path" value="${escapeHtml(
                state.questionPath,
              )}" placeholder="/path/question.json" spellcheck="false" />
              <small class="help">Path to a question.json file describing what you want to analyze (scope, metrics, timeframe). Not needed for the demo.</small>
            </label>
            <label>
              Scenarios
              <input id="scenarios" value="${escapeHtml(
                state.scenarios,
              )}" placeholder="baseline build" spellcheck="false" />
              <small class="help">Space- or comma-separated names for the scenarios to run (e.g., "baseline build"). Defaults to "baseline".</small>
            </label>
            <label class="check-row">
              <input id="skip-bridges" type="checkbox" ${state.skipBridges ? "checked" : ""} />
              Skip bridge packages
            </label>
            <small class="help check-help">Bridge packages prep handoff to SUMO/MATSim/UrbanSim/TBEST/DTALite. Skip this unless you're handing off to those tools.</small>
          </section>

          <section class="panel actions-panel" id="run">
            <div class="section-head">
              <div>
                <p class="eyebrow"><span class="step-num">2</span> Run</p>
                <h2>Workflow</h2>
              </div>
              <button data-action="refresh" ${state.busy ? "disabled" : ""}>Refresh</button>
            </div>
            <p class="panel-hint">New here? Click <strong>Run Demo</strong> to see a complete sample analysis — no inputs needed.</p>
            <div class="button-grid">
              <button data-action="init" ${state.busy ? "disabled" : ""}>Create Workspace</button>
              <button data-action="demo" ${state.busy ? "disabled" : ""}>Run Demo</button>
              <button data-action="full" ${state.busy ? "disabled" : ""}>Run Full Workflow</button>
              <button data-action="diagnose" ${state.busy ? "disabled" : ""}>Diagnose</button>
              <button data-action="report" ${state.busy ? "disabled" : ""}>Regenerate Report</button>
            </div>

            <div class="doctor">
              ${renderDoctor()}
            </div>

            <div class="log">
              ${state.commandLog.map((entry) => `<pre>${escapeHtml(entry)}</pre>`).join("")}
            </div>
          </section>
        </div>

        <div id="qa" class="results">
          ${renderArtifacts()}
        </div>
      </section>
    </main>
  `;
  bindControls();
}

render();
void refreshDoctor();

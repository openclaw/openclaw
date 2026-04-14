import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import {
  buildFullWorkflowArgs,
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
};

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
      throw new Error(payload.stderr || payload.error || "ClawModeler command failed");
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
    const detail = payload.stderr || payload.error || `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return payload;
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
    state.status = error instanceof Error ? error.message : String(error);
  } finally {
    state.busy = false;
    render();
  }
}

async function refreshDoctor() {
  await runAction("Checking local modeling stack", async () => {
    const result = await api<DoctorResult>("/api/clawmodeler/doctor");
    state.doctor = result.json ?? null;
    return result;
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
      state.status = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (showBusy) {
      state.busy = false;
      render();
    }
  }
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
      void runAction("Running demo workflow", () =>
        api("/api/clawmodeler/demo-full", { workspace: state.workspace, runId: state.runId }),
      );
    });
  appRoot
    .querySelector<HTMLButtonElement>("[data-action='full']")
    ?.addEventListener("click", () => {
      const inputs = normalizePathList(state.inputPaths);
      const question = state.questionPath.trim();
      if (inputs.length === 0 || !question) {
        state.status = "Add input paths and a question.json path before running the full workflow.";
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

function renderDoctor() {
  if (!state.doctor) {
    return `<p class="muted">Run Doctor to check local Python, DuckDB, routing, reporting, and bridge tools.</p>`;
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
        <p class="eyebrow">ClawQA</p>
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
          <p class="eyebrow">Narrative</p>
          <h2>Report Preview</h2>
        </div>
        <span>${report ? "Markdown" : "Waiting"}</span>
      </div>
      <pre>${escapeHtml(report || "No report has been exported for this run yet.")}</pre>
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
        <p class="rail-note">Screening outputs only. Detailed engineering analysis requires a documented external workflow.</p>
      </aside>

      <section class="content">
        <header class="topbar">
          <div>
            <p class="eyebrow">Local-first transportation modeling</p>
            <h1>Build, run, and verify a sketch-planning workspace.</h1>
          </div>
          <div class="run-state ${state.busy ? "busy" : ""}">
            <span></span>
            ${escapeHtml(state.status)}
          </div>
        </header>

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
                <p class="eyebrow">Workspace</p>
                <h2>Project Setup</h2>
              </div>
              <button data-action="doctor" ${state.busy ? "disabled" : ""}>Doctor</button>
            </div>

            <label>
              Workspace path
              <input id="workspace" value="${escapeHtml(state.workspace)}" spellcheck="false" />
            </label>
            <label>
              Run ID
              <input id="run-id" value="${escapeHtml(state.runId)}" spellcheck="false" />
            </label>
            <label>
              Input paths
              <textarea id="input-paths" rows="5" spellcheck="false" placeholder="/path/zones.geojson&#10;/path/socio.csv&#10;/path/projects.csv">${escapeHtml(
                state.inputPaths,
              )}</textarea>
            </label>
            <label>
              Question JSON
              <input id="question-path" value="${escapeHtml(
                state.questionPath,
              )}" placeholder="/path/question.json" spellcheck="false" />
            </label>
            <label>
              Scenarios
              <input id="scenarios" value="${escapeHtml(
                state.scenarios,
              )}" placeholder="baseline build" spellcheck="false" />
            </label>
            <label class="check-row">
              <input id="skip-bridges" type="checkbox" ${state.skipBridges ? "checked" : ""} />
              Skip bridge packages
            </label>
          </section>

          <section class="panel actions-panel" id="run">
            <div class="section-head">
              <div>
                <p class="eyebrow">Run</p>
                <h2>Workflow</h2>
              </div>
              <button data-action="refresh" ${state.busy ? "disabled" : ""}>Refresh</button>
            </div>
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

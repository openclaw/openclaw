/**
 * Iris Dashboard — Main application
 * Vanilla JS, no framework dependencies.
 */

import { DashboardApiClient } from "./api.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

const cfg = window.__IRIS_DASHBOARD_CONFIG__ ?? { apiBase: "/iris-dashboard/api" };
const api = new DashboardApiClient(cfg.apiBase ?? "/iris-dashboard/api");

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  tasks: [],
  total: 0,
  loading: false,
  error: null,
  filters: {
    status: "",
    categoria: "",
    pessoa: "",
    search: "",
    sort_by: "criado_em",
    sort_dir: "desc",
    include_deleted: false,
    limit: 50,
    offset: 0,
  },
  editingTask: null, // Task being edited (null = not editing)
  creatingTask: false,
  theme: localStorage.getItem("iris-dash-theme") || "dark",
};

// Apply theme immediately
document.documentElement.setAttribute("data-theme", state.theme);

// ─── Realtime (polling + optional WS) ────────────────────────────────────────

let pollInterval = null;
let wsConnection = null;

function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(() => {
    loadTasks(false); // silent reload
  }, 5000);
}

function stopPolling() {
  clearInterval(pollInterval);
  pollInterval = null;
}

function tryRealtimeWebSocket() {
  if (!cfg.supabaseUrl || !cfg.supabaseKey) return;
  if (wsConnection) return;

  try {
    const wsUrl =
      cfg.supabaseUrl.replace(/^https?/, cfg.supabaseUrl.startsWith("https") ? "wss" : "ws") +
      `/realtime/v1/websocket?apikey=${encodeURIComponent(cfg.supabaseKey)}&vsn=1.0.0`;

    const ws = new WebSocket(wsUrl);
    let heartbeatTimer = null;
    let ref = 0;

    ws.onopen = () => {
      updateStatusDot(true);
      // Join the public:tasks channel
      ref++;
      ws.send(
        JSON.stringify({
          topic: "realtime:public:tasks",
          event: "phx_join",
          payload: {
            config: {
              broadcast: {},
              presence: {},
              postgres_changes: [{ event: "*", schema: "public", table: "tasks" }],
            },
          },
          ref: String(ref),
        }),
      );
      // Heartbeat every 25s
      heartbeatTimer = setInterval(() => {
        ref++;
        ws.send(
          JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref) }),
        );
      }, 25000);
      // Stop polling when WS is live
      stopPolling();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.event === "postgres_changes" || msg.payload?.data?.type !== undefined) {
          loadTasks(false);
        }
      } catch {
        /* ignore parse errors */
      }
    };

    ws.onclose = () => {
      updateStatusDot(false);
      clearInterval(heartbeatTimer);
      wsConnection = null;
      // Fall back to polling
      startPolling();
      // Reconnect after 10s
      setTimeout(tryRealtimeWebSocket, 10000);
    };

    ws.onerror = () => {
      ws.close();
    };

    wsConnection = ws;
  } catch {
    startPolling();
  }
}

// ─── Data loading ─────────────────────────────────────────────────────────────

async function loadTasks(showSpinner = true) {
  if (showSpinner) {
    state.loading = true;
    renderTaskList();
  }
  state.error = null;

  try {
    const params = {};
    for (const [k, v] of Object.entries(state.filters)) {
      if (v !== "" && v !== false && v !== null) params[k] = v;
    }
    const data = await api.listTasks(params);
    state.tasks = data.items;
    state.total = data.page.total;
  } catch (err) {
    state.error = err.message;
    showToast(err.message, "error");
  } finally {
    state.loading = false;
    renderTaskList();
    renderPagination();
  }
}

// ─── Rendering ────────────────────────────────────────────────────────────────

function renderTaskList() {
  const container = document.getElementById("tasks-container");
  if (!container) return;

  if (state.loading) {
    container.innerHTML = Array(6)
      .fill(0)
      .map((_, i) => `<div class="skeleton skeleton-card stagger-${i + 1}"></div>`)
      .join("");
    return;
  }

  if (state.error && state.tasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="icon">⚠️</div>
        <h3>Erro ao carregar tarefas</h3>
        <p>${escHtml(state.error)}</p>
      </div>`;
    return;
  }

  if (state.tasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <div class="icon">📋</div>
        <h3>Nenhuma tarefa encontrada</h3>
        <p>Crie uma nova tarefa ou ajuste os filtros.</p>
      </div>`;
    return;
  }

  container.innerHTML = state.tasks.map((task, i) => renderTaskCard(task, i)).join("");
}

function renderTaskCard(task, idx) {
  const delay = Math.min(idx, 5) + 1;
  const isDeleted = !!task.deleted_at;

  const statusBadge = `<span class="badge badge-${task.status}">${statusLabel(task.status)}</span>`;
  const catBadge = `<span class="badge badge-cat">${catLabel(task.categoria)}</span>`;
  const prioBadge = `<span class="badge badge-prio">P${task.prioridade}</span>`;
  const pessoaBadge = task.pessoa
    ? `<span class="badge badge-cat">👤 ${escHtml(task.pessoa)}</span>`
    : "";
  const vencBadge = task.vencimento_em
    ? `<span class="badge badge-cat">📅 ${fmtDate(task.vencimento_em)}</span>`
    : "";

  const actions = isDeleted
    ? `<button class="btn btn-secondary btn-sm" onclick="window._restoreTask('${task.id}')">↩ Restaurar</button>`
    : `
      <button class="btn btn-secondary btn-sm" onclick="window._editTask('${task.id}')">✏️ Editar</button>
      ${
        task.status !== "concluido"
          ? `<button class="btn btn-secondary btn-sm" onclick="window._completeTask('${task.id}')">✅ Concluir</button>`
          : ""
      }
      <button class="btn btn-danger btn-sm" onclick="window._deleteTask('${task.id}')">🗑</button>
    `;

  return `
    <div class="task-card${isDeleted ? " deleted" : ""} stagger-${delay}" data-id="${task.id}">
      <div class="task-card-header">
        <div class="task-titulo">${escHtml(task.titulo)}</div>
      </div>
      ${task.descricao ? `<div class="task-descricao">${escHtml(task.descricao)}</div>` : ""}
      <div class="task-meta">
        ${statusBadge}${catBadge}${prioBadge}${pessoaBadge}${vencBadge}
      </div>
      <div class="task-actions">${actions}</div>
    </div>`;
}

function renderPagination() {
  const el = document.getElementById("pagination");
  if (!el) return;

  const { limit, offset } = state.filters;
  const total = state.total;
  if (total <= limit) {
    el.innerHTML = `<span>${total} tarefa${total !== 1 ? "s" : ""}</span>`;
    return;
  }

  const page = Math.floor(offset / limit) + 1;
  const pages = Math.ceil(total / limit);
  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;

  el.innerHTML = `
    <button class="btn btn-secondary btn-sm" ${hasPrev ? "" : "disabled"} onclick="window._prevPage()">←</button>
    <span>Página ${page} de ${pages} · ${total} tarefas</span>
    <button class="btn btn-secondary btn-sm" ${hasNext ? "" : "disabled"} onclick="window._nextPage()">→</button>
  `;
}

// ─── Modal ────────────────────────────────────────────────────────────────────

function openModal(task = null) {
  const isEdit = !!task;
  state.editingTask = task;
  state.creatingTask = !isEdit;

  const title = isEdit ? "Editar Tarefa" : "Nova Tarefa";
  const titulo = task?.titulo ?? "";
  const descricao = task?.descricao ?? "";
  const status = task?.status ?? "pendente";
  const categoria = task?.categoria ?? "backlog";
  const prioridade = task?.prioridade ?? 3;
  const pessoa = task?.pessoa ?? "";
  const origem = task?.origem ?? "iris";
  const venc = task?.vencimento_em ? task.vencimento_em.slice(0, 10) : "";

  const html = `
    <div class="modal-backdrop" id="modal-backdrop" onclick="window._closeModal(event)">
      <div class="modal" onclick="event.stopPropagation()">
        <h2 class="modal-title">${title}</h2>
        <form id="task-form" onsubmit="window._submitTask(event)">
          <div class="form-group">
            <label class="form-label" for="f-titulo">Título *</label>
            <input class="form-input" id="f-titulo" name="titulo" required maxlength="200"
              value="${escHtml(titulo)}" placeholder="Descreva a tarefa..." autofocus>
          </div>
          <div class="form-group">
            <label class="form-label" for="f-descricao">Descrição</label>
            <textarea class="form-textarea" id="f-descricao" name="descricao"
              placeholder="Detalhes adicionais...">${escHtml(descricao)}</textarea>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="f-status">Status</label>
              <select class="form-select" id="f-status" name="status">
                ${statusOptions(status)}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="f-categoria">Categoria</label>
              <select class="form-select" id="f-categoria" name="categoria">
                ${catOptions(categoria)}
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="f-prioridade">Prioridade</label>
              <select class="form-select" id="f-prioridade" name="prioridade">
                <option value="1" ${prioridade === 1 ? "selected" : ""}>1 — Crítica</option>
                <option value="2" ${prioridade === 2 ? "selected" : ""}>2 — Alta</option>
                <option value="3" ${prioridade === 3 ? "selected" : ""}>3 — Média</option>
                <option value="4" ${prioridade === 4 ? "selected" : ""}>4 — Baixa</option>
                <option value="5" ${prioridade === 5 ? "selected" : ""}>5 — Mínima</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="f-origem">Origem</label>
              <select class="form-select" id="f-origem" name="origem">
                <option value="iris" ${origem === "iris" ? "selected" : ""}>Iris</option>
                <option value="lucas" ${origem === "lucas" ? "selected" : ""}>Lucas</option>
                <option value="sistema" ${origem === "sistema" ? "selected" : ""}>Sistema</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="f-pessoa">Pessoa</label>
              <input class="form-input" id="f-pessoa" name="pessoa" value="${escHtml(pessoa)}"
                placeholder="Nome da pessoa...">
            </div>
            <div class="form-group">
              <label class="form-label" for="f-vencimento">Vencimento</label>
              <input class="form-input" type="date" id="f-vencimento" name="vencimento_em"
                value="${escHtml(venc)}">
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" onclick="window._closeModal()">Cancelar</button>
            <button type="submit" class="btn btn-primary">${isEdit ? "Salvar" : "Criar"}</button>
          </div>
        </form>
      </div>
    </div>`;

  document.getElementById("modal-root").innerHTML = html;
  document.getElementById("f-titulo").focus();
}

function closeModal() {
  document.getElementById("modal-root").innerHTML = "";
  state.editingTask = null;
  state.creatingTask = false;
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function submitTask(ev) {
  ev.preventDefault();
  const form = ev.target;
  const fd = new FormData(form);
  const input = {
    titulo: fd.get("titulo"),
    descricao: fd.get("descricao") || null,
    status: fd.get("status"),
    categoria: fd.get("categoria"),
    prioridade: parseInt(fd.get("prioridade"), 10),
    pessoa: fd.get("pessoa") || null,
    origem: fd.get("origem"),
    vencimento_em: fd.get("vencimento_em") || null,
  };

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;

  try {
    if (state.editingTask) {
      await api.updateTask(state.editingTask.id, input);
      showToast("Tarefa atualizada!", "ok");
    } else {
      await api.createTask(input);
      showToast("Tarefa criada!", "ok");
    }
    closeModal();
    await loadTasks();
  } catch (err) {
    showToast(err.message, "error");
    btn.disabled = false;
  }
}

async function editTask(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (task) openModal(task);
}

async function completeTask(id) {
  try {
    await api.updateTask(id, { status: "concluido" });
    showToast("Tarefa concluída! ✅", "ok");
    await loadTasks(false);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteTask(id) {
  try {
    await api.deleteTask(id);
    showToast("Tarefa removida.", "ok");
    await loadTasks(false);
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function restoreTask(id) {
  try {
    await api.restoreTask(id);
    showToast("Tarefa restaurada!", "ok");
    await loadTasks(false);
  } catch (err) {
    showToast(err.message, "error");
  }
}

function prevPage() {
  const { limit, offset } = state.filters;
  if (offset <= 0) return;
  state.filters.offset = Math.max(0, offset - limit);
  loadTasks();
}

function nextPage() {
  const { limit, offset } = state.filters;
  if (offset + limit >= state.total) return;
  state.filters.offset = offset + limit;
  loadTasks();
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", state.theme);
  localStorage.setItem("iris-dash-theme", state.theme);
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = state.theme === "dark" ? "☀️" : "🌙";
}

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(message, type = "ok") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ─── Status dot ───────────────────────────────────────────────────────────────

function updateStatusDot(connected) {
  const dot = document.querySelector(".status-dot");
  if (!dot) return;
  dot.className = `status-dot ${connected ? "ok" : "error"}`;
  const label = document.getElementById("status-label");
  if (label) label.textContent = connected ? "Realtime" : "Polling";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("pt-BR");
  } catch {
    return iso;
  }
}

function statusLabel(s) {
  return (
    {
      pendente: "Pendente",
      em_andamento: "Em andamento",
      concluido: "Concluído",
      cancelado: "Cancelado",
    }[s] ?? s
  );
}

function catLabel(c) {
  return (
    {
      follow_up: "Follow-up",
      backlog: "Backlog",
      urgente: "Urgente",
      proximo: "Próximo",
      outros: "Outros",
    }[c] ?? c
  );
}

function statusOptions(selected) {
  return ["pendente", "em_andamento", "concluido", "cancelado"]
    .map(
      (s) => `<option value="${s}" ${s === selected ? "selected" : ""}>${statusLabel(s)}</option>`,
    )
    .join("");
}

function catOptions(selected) {
  return ["follow_up", "backlog", "urgente", "proximo", "outros"]
    .map((c) => `<option value="${c}" ${c === selected ? "selected" : ""}>${catLabel(c)}</option>`)
    .join("");
}

// ─── Wire up DOM ──────────────────────────────────────────────────────────────

// Expose to inline handlers
window._editTask = editTask;
window._completeTask = completeTask;
window._deleteTask = deleteTask;
window._restoreTask = restoreTask;
window._prevPage = prevPage;
window._nextPage = nextPage;
window._closeModal = (ev) => {
  if (!ev || ev.target === document.getElementById("modal-backdrop")) closeModal();
};
window._submitTask = submitTask;

document.addEventListener("DOMContentLoaded", () => {
  // Filter controls
  const statusSel = document.getElementById("filter-status");
  const catSel = document.getElementById("filter-categoria");
  const searchInput = document.getElementById("filter-search");
  const pessoaInput = document.getElementById("filter-pessoa");
  const deletedChk = document.getElementById("filter-deleted");
  const sortSel = document.getElementById("filter-sort");
  const newBtn = document.getElementById("btn-new");
  const themeBtn = document.getElementById("theme-toggle");

  if (statusSel) {
    statusSel.addEventListener("change", () => {
      state.filters.status = statusSel.value;
      state.filters.offset = 0;
      loadTasks();
    });
  }

  if (catSel) {
    catSel.addEventListener("change", () => {
      state.filters.categoria = catSel.value;
      state.filters.offset = 0;
      loadTasks();
    });
  }

  if (searchInput) {
    let debounce;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.filters.search = searchInput.value.trim();
        state.filters.offset = 0;
        loadTasks();
      }, 350);
    });
  }

  if (pessoaInput) {
    let debounce;
    pessoaInput.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        state.filters.pessoa = pessoaInput.value.trim();
        state.filters.offset = 0;
        loadTasks();
      }, 350);
    });
  }

  if (deletedChk) {
    deletedChk.addEventListener("change", () => {
      state.filters.include_deleted = deletedChk.checked;
      state.filters.offset = 0;
      loadTasks();
    });
  }

  if (sortSel) {
    sortSel.addEventListener("change", () => {
      const [by, dir] = sortSel.value.split(":");
      state.filters.sort_by = by;
      state.filters.sort_dir = dir;
      state.filters.offset = 0;
      loadTasks();
    });
  }

  if (newBtn) {
    newBtn.addEventListener("click", () => openModal());
  }

  if (themeBtn) {
    themeBtn.textContent = state.theme === "dark" ? "☀️" : "🌙";
    themeBtn.addEventListener("click", toggleTheme);
  }

  // Keyboard shortcut: N = new task
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "n" && !ev.ctrlKey && !ev.metaKey && document.activeElement.tagName === "BODY") {
      openModal();
    }
    if (ev.key === "Escape") closeModal();
  });

  // Initial load
  loadTasks();
  tryRealtimeWebSocket();
  startPolling(); // polling always runs as baseline
});

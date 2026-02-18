/**
 * MABOS Stakeholder Dashboard — Client-Side Application
 */

const API = "/mabos/api";

// ── State ──
let currentView = "overview";
let statusData = null;

// ── Navigation ──
function navigate(view, params) {
  currentView = view;
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === view);
  });
  render(view, params);
}

// ── Render Router ──
function render(view, params) {
  const main = document.getElementById("main-content");
  main.innerHTML = '<div class="loading">Loading...</div>';

  switch (view) {
    case "overview":
      renderOverview(main);
      break;
    case "decisions":
      renderDecisions(main);
      break;
    case "agents":
      renderAgentDetail(main, params);
      break;
    case "businesses":
      renderBusinesses(main, params);
      break;
    case "contractors":
      renderContractors(main);
      break;
    default:
      renderOverview(main);
  }
}

// ── API Helpers ──
async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error("API error:", err);
    return null;
  }
}

// ── Overview View ──
async function renderOverview(container) {
  const data = await fetchJSON(`${API}/status`);
  if (!data) {
    container.innerHTML =
      '<div class="empty-state"><h3>Could not load status</h3><p>Check that the MABOS server is running.</p></div>';
    return;
  }
  statusData = data;

  const agentCount = data.agents?.length || 0;
  const businessCount = data.businessCount || 0;
  const bdiStatus = data.bdiHeartbeat || "unknown";

  let html = `
    <div class="view-header">
      <h2>System Overview</h2>
      <span class="badge badge-info">v${data.version || "0.1.0"}</span>
    </div>

    <div class="grid">
      <div class="card">
        <div class="stat">${agentCount}</div>
        <div class="stat-label">BDI Agents</div>
      </div>
      <div class="card">
        <div class="stat">${businessCount}</div>
        <div class="stat-label">Managed Businesses</div>
      </div>
      <div class="card">
        <div class="stat"><span class="badge badge-active">${bdiStatus}</span></div>
        <div class="stat-label">BDI Heartbeat (${data.bdiIntervalMinutes || 30}min)</div>
      </div>
      <div class="card">
        <div class="stat">20</div>
        <div class="stat-label">Reasoning Tools</div>
      </div>
    </div>`;

  // Agent summary table
  if (data.agents && data.agents.length > 0) {
    html += `
      <h3 class="section-header">Agents</h3>
      <div class="card">
        <table>
          <tr><th>Agent</th><th>Beliefs</th><th>Goals</th><th>Intentions</th><th>Desires</th><th></th></tr>
          ${data.agents
            .map(
              (a) => `
            <tr>
              <td><strong>${a.agentId}</strong></td>
              <td>${a.beliefCount || 0}</td>
              <td>${a.goalCount || 0}</td>
              <td>${a.intentionCount || 0}</td>
              <td>${a.desireCount || 0}</td>
              <td><a class="btn btn-secondary btn-sm" onclick="navigate('agents', {id:'${a.agentId}'})">View</a></td>
            </tr>
          `,
            )
            .join("")}
        </table>
      </div>`;
  } else {
    html += `
      <div class="empty-state">
        <h3>No agents found</h3>
        <p>Run <code>mabos onboard &lt;business-name&gt;</code> to get started.</p>
      </div>`;
  }

  container.innerHTML = html;
}

// ── Decisions View ──
async function renderDecisions(container) {
  const data = await fetchJSON(`${API}/decisions`);

  let html = `
    <div class="view-header">
      <h2>Decision Queue</h2>
    </div>`;

  if (!data || !data.decisions || data.decisions.length === 0) {
    html += `<div class="empty-state"><h3>No pending decisions</h3><p>All clear! Agents are operating within their authority.</p></div>`;
    container.innerHTML = html;
    return;
  }

  for (const d of data.decisions) {
    const urgencyClass = `urgency-${d.urgency || "medium"}`;
    const badgeClass = `badge-${d.urgency || "medium"}`;

    html += `
      <div class="decision-card ${urgencyClass}">
        <div class="decision-header">
          <span class="decision-title">${escapeHtml(d.title || d.id)}</span>
          <span class="badge ${badgeClass}">${d.urgency || "medium"}</span>
        </div>
        <div class="decision-meta">
          <span>Agent: <strong>${escapeHtml(d.agent || "unknown")}</strong></span>
          <span>Business: <strong>${escapeHtml(d.business_id || "")}</strong></span>
          ${d.created ? `<span>Created: ${d.created}</span>` : ""}
          ${d.deadline ? `<span>Deadline: ${d.deadline}</span>` : ""}
        </div>
        <div class="decision-body">
          <p>${escapeHtml(d.description || "")}</p>
        </div>`;

    if (d.options && d.options.length > 0) {
      html += `<ul class="decision-options">`;
      for (const opt of d.options) {
        html += `<li><strong>${escapeHtml(opt.label || opt.id)}</strong> &mdash; ${escapeHtml(opt.impact || "")}${opt.cost ? ` ($${opt.cost})` : ""}${opt.risk ? ` | Risk: ${escapeHtml(opt.risk)}` : ""}</li>`;
      }
      html += `</ul>`;
    }

    if (d.recommendation) {
      html += `<div class="decision-recommendation">Agent Recommendation: ${escapeHtml(d.recommendation)}</div>`;
    }

    html += `
        <div class="btn-group">
          <button class="btn btn-primary btn-sm" onclick="resolveDecision('${d.business_id}','${d.id}','approved')">Approve</button>
          <button class="btn btn-secondary btn-sm" onclick="resolveDecision('${d.business_id}','${d.id}','deferred')">Defer</button>
          <button class="btn btn-danger btn-sm" onclick="resolveDecision('${d.business_id}','${d.id}','rejected')">Reject</button>
        </div>
      </div>`;
  }

  container.innerHTML = html;
}

async function resolveDecision(businessId, decisionId, resolution) {
  const feedback = resolution === "rejected" ? prompt("Reason for rejection (optional):") : null;

  try {
    const res = await fetch(`${API}/decisions/${decisionId}/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        business_id: businessId,
        decision_id: decisionId,
        resolution,
        feedback: feedback || undefined,
      }),
    });
    if (res.ok) {
      navigate("decisions");
    } else {
      alert("Failed to resolve decision");
    }
  } catch (err) {
    alert("Error: " + err.message);
  }
}

// ── Agent Detail View ──
async function renderAgentDetail(container, params) {
  const agentId = params?.id;
  if (!agentId) {
    container.innerHTML = '<div class="empty-state"><h3>Select an agent</h3></div>';
    return;
  }

  const data = await fetchJSON(`${API}/agents/${agentId}`);
  if (!data) {
    container.innerHTML = `<div class="empty-state"><h3>Agent not found</h3><p>${escapeHtml(agentId)}</p></div>`;
    return;
  }

  let html = `
    <div class="view-header">
      <h2>Agent: ${escapeHtml(agentId)}</h2>
      <a class="btn btn-secondary btn-sm" onclick="navigate('overview')">Back</a>
    </div>

    <div class="grid">
      <div class="card"><div class="stat">${data.beliefCount || 0}</div><div class="stat-label">Beliefs</div></div>
      <div class="card"><div class="stat">${data.goalCount || 0}</div><div class="stat-label">Goals</div></div>
      <div class="card"><div class="stat">${data.intentionCount || 0}</div><div class="stat-label">Intentions</div></div>
      <div class="card"><div class="stat">${data.desireCount || 0}</div><div class="stat-label">Desires</div></div>
    </div>

    <div class="cognitive-grid">`;

  if (data.beliefs && data.beliefs.length > 0) {
    html += `<div class="cognitive-card"><h3>Beliefs</h3>`;
    for (const b of data.beliefs.slice(0, 20)) {
      html += `<div class="cognitive-item">${escapeHtml(b)}</div>`;
    }
    html += `</div>`;
  }

  if (data.goals && data.goals.length > 0) {
    html += `<div class="cognitive-card"><h3>Goals</h3>`;
    for (const g of data.goals.slice(0, 20)) {
      html += `<div class="cognitive-item">${escapeHtml(g)}</div>`;
    }
    html += `</div>`;
  }

  if (data.intentions && data.intentions.length > 0) {
    html += `<div class="cognitive-card"><h3>Intentions</h3>`;
    for (const i of data.intentions.slice(0, 20)) {
      html += `<div class="cognitive-item">${escapeHtml(i)}</div>`;
    }
    html += `</div>`;
  }

  if (data.desires && data.desires.length > 0) {
    html += `<div class="cognitive-card"><h3>Desires</h3>`;
    for (const d of data.desires.slice(0, 20)) {
      html += `<div class="cognitive-item">${escapeHtml(d)}</div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
}

// ── Businesses View ──
async function renderBusinesses(container, params) {
  if (params?.id) {
    return renderBusinessDetail(container, params.id);
  }

  const data = await fetchJSON(`${API}/businesses`);
  if (!data || !data.businesses || data.businesses.length === 0) {
    container.innerHTML = `
      <div class="view-header"><h2>Businesses</h2></div>
      <div class="empty-state"><h3>No businesses found</h3><p>Run <code>mabos onboard</code> to create one.</p></div>`;
    return;
  }

  let html = `
    <div class="view-header"><h2>Businesses</h2></div>
    <div class="grid">`;

  for (const b of data.businesses) {
    html += `
      <div class="card" style="cursor:pointer" onclick="navigate('businesses', {id:'${escapeHtml(b.id)}'})">
        <div class="card-header">
          <span class="card-title">${escapeHtml(b.industry || "general")}</span>
          <span class="badge badge-active">${escapeHtml(b.status || "active")}</span>
        </div>
        <h3 style="margin-bottom:8px">${escapeHtml(b.name || b.id)}</h3>
        <div class="stat-label">${b.agentCount || 0} agents</div>
      </div>`;
  }

  html += `</div>`;
  container.innerHTML = html;
}

async function renderBusinessDetail(container, businessId) {
  const metrics = await fetchJSON(`${API}/metrics/${businessId}`);

  let html = `
    <div class="view-header">
      <h2>Business: ${escapeHtml(businessId)}</h2>
      <a class="btn btn-secondary btn-sm" onclick="navigate('businesses')">Back</a>
    </div>`;

  if (metrics && metrics.metrics) {
    html += `<div class="grid">`;
    for (const [key, val] of Object.entries(metrics.metrics)) {
      html += `
        <div class="card">
          <div class="stat">${typeof val === "number" ? val.toLocaleString() : escapeHtml(String(val))}</div>
          <div class="stat-label">${escapeHtml(key)}</div>
        </div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="empty-state"><h3>No metrics available</h3></div>`;
  }

  container.innerHTML = html;
}

// ── Contractors View ──
async function renderContractors(container) {
  const data = await fetchJSON(`${API}/contractors`);

  let html = `<div class="view-header"><h2>Contractor Pool</h2></div>`;

  if (!data || !data.contractors || data.contractors.length === 0) {
    html += `<div class="empty-state"><h3>No contractors</h3><p>Use <code>contractor_add</code> to add contractors.</p></div>`;
    container.innerHTML = html;
    return;
  }

  html += `
    <div class="card">
      <table>
        <tr><th>Name</th><th>Skills</th><th>Trust Score</th><th>Status</th><th>Utilization</th></tr>
        ${data.contractors
          .map((c) => {
            const trustPct = ((c.trust_score || 0.5) * 100).toFixed(0);
            const barColor =
              c.trust_score > 0.7
                ? "var(--success-text)"
                : c.trust_score > 0.4
                  ? "var(--warning)"
                  : "var(--danger-text)";
            return `
            <tr>
              <td><strong>${escapeHtml(c.name || c.id)}</strong></td>
              <td>${(c.skills || []).map((s) => `<span class="badge badge-info">${escapeHtml(s)}</span>`).join(" ")}</td>
              <td>
                ${trustPct}%
                <div class="trust-bar"><div class="trust-bar-fill" style="width:${trustPct}%;background:${barColor}"></div></div>
              </td>
              <td><span class="badge ${c.status === "active" ? "badge-active" : "badge-low"}">${c.status || "unknown"}</span></td>
              <td>${c.utilization ? (c.utilization * 100).toFixed(0) + "%" : "-"}</td>
            </tr>`;
          })
          .join("")}
      </table>
    </div>`;

  container.innerHTML = html;
}

// ── Utility ──
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  // Wire up nav
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      navigate(el.dataset.view);
    });
  });

  // Initial render
  navigate("overview");
});

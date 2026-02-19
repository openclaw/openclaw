/**
 * MABOS Stakeholder Dashboard — Client-Side Application
 * Expanded with MABOS namespace, business switcher, and comprehensive routing
 */

(function () {
  var API = "/mabos/api";

  // ── Shared Utilities ──
  MABOS.escapeHtml = function (str) {
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  };

  MABOS.slugify = function (str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  };

  MABOS.fetchJSON = async function (url) {
    try {
      var res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (err) {
      console.error("API error:", err);
      return null;
    }
  };

  MABOS.postJSON = async function (url, data) {
    try {
      var res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return await res.json();
    } catch (err) {
      console.error("API error:", err);
      return null;
    }
  };

  MABOS.putJSON = async function (url, data) {
    try {
      var res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
      return await res.json();
    } catch (err) {
      console.error("API error:", err);
      return null;
    }
  };

  // ── State ──
  MABOS.state = {
    currentView: "overview",
    currentBusiness: localStorage.getItem("mabos_current_business") || null,
    businesses: [],
    statusData: null,
  };

  // ── Navigation ──
  MABOS.navigate = function (view, params) {
    MABOS.state.currentView = view;
    document.querySelectorAll(".nav-item").forEach(function (el) {
      el.classList.toggle("active", el.dataset.view === view);
    });
    render(view, params);
  };

  // Keep global for onclick compatibility
  window.navigate = MABOS.navigate;

  // ── Business Switcher ──
  MABOS.loadBusinesses = async function () {
    var data = await MABOS.fetchJSON(API + "/businesses");
    MABOS.state.businesses = (data && data.businesses) || [];
    renderBusinessSwitcher();
  };

  function renderBusinessSwitcher() {
    var container = document.getElementById("business-switcher");
    if (!container) return;
    var businesses = MABOS.state.businesses;

    if (businesses.length === 0) {
      container.innerHTML =
        '<div class="business-switcher"><select disabled><option>No businesses</option></select></div>';
      return;
    }

    var html =
      '<div class="business-switcher"><label style="font-size:0.75em;color:var(--text-muted);display:block;margin-bottom:4px">Active Business</label><select id="business-select">';
    html += '<option value="">All Businesses</option>';
    businesses.forEach(function (b) {
      var sel = MABOS.state.currentBusiness === b.id ? " selected" : "";
      html +=
        '<option value="' +
        MABOS.escapeHtml(b.id) +
        '"' +
        sel +
        ">" +
        MABOS.escapeHtml(b.name || b.id) +
        "</option>";
    });
    html += "</select></div>";
    container.innerHTML = html;

    document.getElementById("business-select").addEventListener("change", function () {
      MABOS.state.currentBusiness = this.value || null;
      if (this.value) {
        localStorage.setItem("mabos_current_business", this.value);
      } else {
        localStorage.removeItem("mabos_current_business");
      }
      // Re-render current view
      render(MABOS.state.currentView);
    });
  }

  // ── Render Router ──
  function render(view, params) {
    var main = document.getElementById("main-content");
    main.innerHTML = '<div class="loading">Loading...</div>';

    switch (view) {
      case "overview":
        renderOverview(main);
        break;
      case "onboard":
        MABOS.renderWizard(main);
        break;
      case "decisions":
        renderDecisions(main);
        break;
      case "agents":
        renderAgentDetail(main, params);
        break;
      case "agents-mgmt":
        MABOS.renderAgentManagement(main, MABOS.state.currentBusiness);
        break;
      case "goals":
        MABOS.renderGoalModel(main, MABOS.state.currentBusiness);
        break;
      case "workflows":
        renderWorkflows(main, params);
        break;
      case "performance":
        MABOS.renderPerformance(main, MABOS.state.currentBusiness);
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

  // ── Workflows View (Kanban/Gantt toggle) ──
  function renderWorkflows(main, params) {
    var biz = MABOS.state.currentBusiness;
    if (!biz) {
      main.innerHTML =
        '<div class="view-header"><h2>Workflows</h2></div><div class="empty-state"><h3>Select a business first</h3><p>Use the business switcher in the sidebar to select a business.</p></div>';
      return;
    }

    var mode = (params && params.mode) || "kanban";
    var html = '<div class="view-header"><h2>Workflows</h2><div class="btn-group">';
    html +=
      '<button class="btn btn-sm ' +
      (mode === "kanban" ? "btn-primary" : "btn-secondary") +
      '" id="wf-kanban">Kanban</button>';
    html +=
      '<button class="btn btn-sm ' +
      (mode === "gantt" ? "btn-primary" : "btn-secondary") +
      '" id="wf-gantt">Gantt</button>';
    html += "</div></div>";
    html += '<div id="workflow-content"></div>';
    main.innerHTML = html;

    document.getElementById("wf-kanban").addEventListener("click", function () {
      renderWorkflows(main, { mode: "kanban" });
    });
    document.getElementById("wf-gantt").addEventListener("click", function () {
      renderWorkflows(main, { mode: "gantt" });
    });

    var content = document.getElementById("workflow-content");
    if (mode === "gantt") {
      MABOS.renderGantt(content, biz);
    } else {
      MABOS.renderKanban(content, biz);
    }
  }

  // ── Overview View ──
  async function renderOverview(container) {
    var data = await MABOS.fetchJSON(API + "/status");
    if (!data) {
      container.innerHTML =
        '<div class="empty-state"><h3>Could not load status</h3><p>Check that the MABOS server is running.</p></div>';
      return;
    }
    MABOS.state.statusData = data;

    var agentCount = (data.agents && data.agents.length) || 0;
    var businessCount = data.businessCount || 0;
    var bdiStatus = data.bdiHeartbeat || "unknown";

    var html =
      '<div class="view-header">' +
      "<h2>System Overview</h2>" +
      '<span class="badge badge-info">v' +
      (data.version || "0.1.0") +
      "</span>" +
      "</div>" +
      '<div class="grid">' +
      '<div class="card"><div class="stat">' +
      agentCount +
      '</div><div class="stat-label">BDI Agents</div></div>' +
      '<div class="card"><div class="stat">' +
      businessCount +
      '</div><div class="stat-label">Managed Businesses</div></div>' +
      '<div class="card"><div class="stat"><span class="badge badge-active">' +
      bdiStatus +
      '</span></div><div class="stat-label">BDI Heartbeat (' +
      (data.bdiIntervalMinutes || 30) +
      "min)</div></div>" +
      '<div class="card"><div class="stat">20</div><div class="stat-label">Reasoning Tools</div></div>' +
      "</div>";

    if (data.agents && data.agents.length > 0) {
      html +=
        '<h3 class="section-header">Agents</h3>' +
        '<div class="card"><table>' +
        "<tr><th>Agent</th><th>Beliefs</th><th>Goals</th><th>Intentions</th><th>Desires</th><th></th></tr>";
      data.agents.forEach(function (a) {
        html +=
          "<tr>" +
          "<td><strong>" +
          (a.agentId || "") +
          "</strong></td>" +
          "<td>" +
          (a.beliefCount || 0) +
          "</td>" +
          "<td>" +
          (a.goalCount || 0) +
          "</td>" +
          "<td>" +
          (a.intentionCount || 0) +
          "</td>" +
          "<td>" +
          (a.desireCount || 0) +
          "</td>" +
          "<td><a class=\"btn btn-secondary btn-sm\" onclick=\"navigate('agents', {id:'" +
          a.agentId +
          "'})\">View</a></td>" +
          "</tr>";
      });
      html += "</table></div>";
    } else {
      html +=
        '<div class="empty-state"><h3>No agents found</h3><p>Use <a href="#" onclick="navigate(\'onboard\');return false" style="color:var(--accent)">Onboard Business</a> to get started.</p></div>';
    }

    container.innerHTML = html;
  }

  // ── Decisions View ──
  async function renderDecisions(container) {
    var data = await MABOS.fetchJSON(API + "/decisions");

    var html = '<div class="view-header"><h2>Decision Queue</h2></div>';

    if (!data || !data.decisions || data.decisions.length === 0) {
      html +=
        '<div class="empty-state"><h3>No pending decisions</h3><p>All clear! Agents are operating within their authority.</p></div>';
      container.innerHTML = html;
      return;
    }

    data.decisions.forEach(function (d) {
      var urgencyClass = "urgency-" + (d.urgency || "medium");
      var badgeClass = "badge-" + (d.urgency || "medium");

      html +=
        '<div class="decision-card ' +
        urgencyClass +
        '">' +
        '<div class="decision-header">' +
        '<span class="decision-title">' +
        MABOS.escapeHtml(d.title || d.id) +
        "</span>" +
        '<span class="badge ' +
        badgeClass +
        '">' +
        (d.urgency || "medium") +
        "</span>" +
        "</div>" +
        '<div class="decision-meta">' +
        "<span>Agent: <strong>" +
        MABOS.escapeHtml(d.agent || "unknown") +
        "</strong></span>" +
        "<span>Business: <strong>" +
        MABOS.escapeHtml(d.business_id || "") +
        "</strong></span>" +
        (d.created ? "<span>Created: " + d.created + "</span>" : "") +
        (d.deadline ? "<span>Deadline: " + d.deadline + "</span>" : "") +
        "</div>" +
        '<div class="decision-body"><p>' +
        MABOS.escapeHtml(d.description || "") +
        "</p></div>";

      if (d.options && d.options.length > 0) {
        html += '<ul class="decision-options">';
        d.options.forEach(function (opt) {
          html +=
            "<li><strong>" +
            MABOS.escapeHtml(opt.label || opt.id) +
            "</strong> &mdash; " +
            MABOS.escapeHtml(opt.impact || "") +
            (opt.cost ? " ($" + opt.cost + ")" : "") +
            (opt.risk ? " | Risk: " + MABOS.escapeHtml(opt.risk) : "") +
            "</li>";
        });
        html += "</ul>";
      }

      if (d.recommendation) {
        html +=
          '<div class="decision-recommendation">Agent Recommendation: ' +
          MABOS.escapeHtml(d.recommendation) +
          "</div>";
      }

      html +=
        '<div class="btn-group">' +
        '<button class="btn btn-primary btn-sm" onclick="resolveDecision(\'' +
        d.business_id +
        "','" +
        d.id +
        "','approved')\">Approve</button>" +
        '<button class="btn btn-secondary btn-sm" onclick="resolveDecision(\'' +
        d.business_id +
        "','" +
        d.id +
        "','deferred')\">Defer</button>" +
        '<button class="btn btn-danger btn-sm" onclick="resolveDecision(\'' +
        d.business_id +
        "','" +
        d.id +
        "','rejected')\">Reject</button>" +
        "</div></div>";
    });

    container.innerHTML = html;
  }

  window.resolveDecision = async function (businessId, decisionId, resolution) {
    var feedback = resolution === "rejected" ? prompt("Reason for rejection (optional):") : null;
    try {
      var res = await fetch(API + "/decisions/" + decisionId + "/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          business_id: businessId,
          decision_id: decisionId,
          resolution: resolution,
          feedback: feedback || undefined,
        }),
      });
      if (res.ok) {
        MABOS.navigate("decisions");
      } else {
        alert("Failed to resolve decision");
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  // ── Agent Detail View ──
  async function renderAgentDetail(container, params) {
    var agentId = params && params.id;
    if (!agentId) {
      container.innerHTML = '<div class="empty-state"><h3>Select an agent</h3></div>';
      return;
    }

    var data = await MABOS.fetchJSON(API + "/agents/" + agentId);
    if (!data) {
      container.innerHTML =
        '<div class="empty-state"><h3>Agent not found</h3><p>' +
        MABOS.escapeHtml(agentId) +
        "</p></div>";
      return;
    }

    var html =
      '<div class="view-header">' +
      "<h2>Agent: " +
      MABOS.escapeHtml(agentId) +
      "</h2>" +
      '<a class="btn btn-secondary btn-sm" onclick="navigate(\'overview\')">Back</a>' +
      "</div>" +
      '<div class="grid">' +
      '<div class="card"><div class="stat">' +
      (data.beliefCount || 0) +
      '</div><div class="stat-label">Beliefs</div></div>' +
      '<div class="card"><div class="stat">' +
      (data.goalCount || 0) +
      '</div><div class="stat-label">Goals</div></div>' +
      '<div class="card"><div class="stat">' +
      (data.intentionCount || 0) +
      '</div><div class="stat-label">Intentions</div></div>' +
      '<div class="card"><div class="stat">' +
      (data.desireCount || 0) +
      '</div><div class="stat-label">Desires</div></div>' +
      '</div><div class="cognitive-grid">';

    var sections = [
      { key: "beliefs", label: "Beliefs" },
      { key: "goals", label: "Goals" },
      { key: "intentions", label: "Intentions" },
      { key: "desires", label: "Desires" },
    ];

    sections.forEach(function (s) {
      var items = data[s.key];
      if (items && items.length > 0) {
        html += '<div class="cognitive-card"><h3>' + s.label + "</h3>";
        items.slice(0, 20).forEach(function (item) {
          html += '<div class="cognitive-item">' + MABOS.escapeHtml(item) + "</div>";
        });
        html += "</div>";
      }
    });

    html += "</div>";
    container.innerHTML = html;
  }

  // ── Businesses View ──
  async function renderBusinesses(container, params) {
    if (params && params.id) {
      return renderBusinessDetail(container, params.id);
    }

    var data = await MABOS.fetchJSON(API + "/businesses");
    if (!data || !data.businesses || data.businesses.length === 0) {
      container.innerHTML =
        '<div class="view-header"><h2>Businesses</h2></div>' +
        '<div class="empty-state"><h3>No businesses found</h3><p>Use <a href="#" onclick="navigate(\'onboard\');return false" style="color:var(--accent)">Onboard Business</a> to create one.</p></div>';
      return;
    }

    var html = '<div class="view-header"><h2>Businesses</h2></div><div class="grid">';
    data.businesses.forEach(function (b) {
      html +=
        '<div class="card" style="cursor:pointer" onclick="navigate(\'businesses\', {id:\'' +
        MABOS.escapeHtml(b.id) +
        "'})\">" +
        '<div class="card-header"><span class="card-title">' +
        MABOS.escapeHtml(b.industry || "general") +
        '</span><span class="badge badge-active">' +
        MABOS.escapeHtml(b.status || "active") +
        "</span></div>" +
        '<h3 style="margin-bottom:8px">' +
        MABOS.escapeHtml(b.name || b.id) +
        "</h3>" +
        '<div class="stat-label">' +
        (b.agentCount || 0) +
        " agents</div>" +
        "</div>";
    });
    html += "</div>";
    container.innerHTML = html;
  }

  async function renderBusinessDetail(container, businessId) {
    var metrics = await MABOS.fetchJSON(API + "/metrics/" + businessId);

    var html =
      '<div class="view-header">' +
      "<h2>Business: " +
      MABOS.escapeHtml(businessId) +
      "</h2>" +
      '<a class="btn btn-secondary btn-sm" onclick="navigate(\'businesses\')">Back</a>' +
      "</div>";

    if (metrics && metrics.metrics && typeof metrics.metrics === "object") {
      var entries = Object.entries(metrics.metrics);
      if (entries.length > 0) {
        html += '<div class="grid">';
        entries.forEach(function (entry) {
          var key = entry[0];
          var val = entry[1];
          html +=
            '<div class="card"><div class="stat">' +
            (typeof val === "number" ? val.toLocaleString() : MABOS.escapeHtml(String(val))) +
            '</div><div class="stat-label">' +
            MABOS.escapeHtml(key) +
            "</div></div>";
        });
        html += "</div>";
      } else {
        html += '<div class="empty-state"><h3>No metrics available</h3></div>';
      }
    } else {
      html += '<div class="empty-state"><h3>No metrics available</h3></div>';
    }

    container.innerHTML = html;
  }

  // ── Contractors View ──
  async function renderContractors(container) {
    var data = await MABOS.fetchJSON(API + "/contractors");

    var html = '<div class="view-header"><h2>Contractor Pool</h2></div>';

    if (!data || !data.contractors || data.contractors.length === 0) {
      html +=
        '<div class="empty-state"><h3>No contractors</h3><p>Use <code>contractor_add</code> to add contractors.</p></div>';
      container.innerHTML = html;
      return;
    }

    html +=
      '<div class="card"><table>' +
      "<tr><th>Name</th><th>Skills</th><th>Trust Score</th><th>Status</th><th>Utilization</th></tr>";

    data.contractors.forEach(function (c) {
      var trustPct = ((c.trust_score || 0.5) * 100).toFixed(0);
      var barColor =
        c.trust_score > 0.7
          ? "var(--success-text)"
          : c.trust_score > 0.4
            ? "var(--warning)"
            : "var(--danger-text)";
      html +=
        "<tr>" +
        "<td><strong>" +
        MABOS.escapeHtml(c.name || c.id) +
        "</strong></td>" +
        "<td>" +
        (c.skills || [])
          .map(function (s) {
            return '<span class="badge badge-info">' + MABOS.escapeHtml(s) + "</span>";
          })
          .join(" ") +
        "</td>" +
        "<td>" +
        trustPct +
        '%<div class="trust-bar"><div class="trust-bar-fill" style="width:' +
        trustPct +
        "%;background:" +
        barColor +
        '"></div></div></td>' +
        '<td><span class="badge ' +
        (c.status === "active" ? "badge-active" : "badge-low") +
        '">' +
        (c.status || "unknown") +
        "</span></td>" +
        "<td>" +
        (c.utilization ? (c.utilization * 100).toFixed(0) + "%" : "-") +
        "</td>" +
        "</tr>";
    });

    html += "</table></div>";
    container.innerHTML = html;
  }

  // ── Init ──
  document.addEventListener("DOMContentLoaded", async function () {
    // Wire up nav
    document.querySelectorAll(".nav-item").forEach(function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault();
        MABOS.navigate(el.dataset.view);
      });
    });

    // Load businesses for switcher
    await MABOS.loadBusinesses();

    // Initial render
    MABOS.navigate("overview");
  });
})();

/**
 * MABOS Dashboard — Agent Management
 */

(function () {
  MABOS.renderAgentManagement = async function (container, businessId) {
    if (!businessId) {
      container.innerHTML =
        '<div class="empty-state"><h3>Select a business first</h3><p>Use the business switcher in the sidebar.</p></div>';
      return;
    }

    container.innerHTML = '<div class="loading">Loading agents...</div>';
    var data = await MABOS.fetchJSON("/mabos/api/businesses/" + businessId + "/agents");
    var agents = (data && data.agents) || [];

    if (agents.length === 0) {
      container.innerHTML =
        '<div class="view-header"><h2>Agent Management</h2></div><div class="empty-state"><h3>No agents found</h3><p>Agents are created during business onboarding.</p></div>';
      return;
    }

    var html =
      '<div class="view-header"><h2>Agent Management</h2><span class="badge badge-info">' +
      agents.length +
      " agents</span></div>";
    html += '<div class="card"><table>';
    html +=
      "<tr><th>Agent</th><th>Type</th><th>Status</th><th>Beliefs</th><th>Goals</th><th>Intentions</th><th>Desires</th><th></th></tr>";

    agents.forEach(function (a) {
      var statusBadge =
        a.status === "active"
          ? "badge-active"
          : a.status === "disabled"
            ? "badge-low"
            : "badge-pending";
      var typeBadge = a.type === "core" ? "badge-info" : "badge-pending";
      html += "<tr>";
      html += "<td><strong>" + MABOS.escapeHtml(a.name || a.id) + "</strong></td>";
      html += '<td><span class="badge ' + typeBadge + '">' + a.type + "</span></td>";
      html +=
        '<td><span class="badge ' + statusBadge + '">' + (a.status || "active") + "</span></td>";
      html += "<td>" + (a.beliefs || 0) + "</td>";
      html += "<td>" + (a.goals || 0) + "</td>";
      html += "<td>" + (a.intentions || 0) + "</td>";
      html += "<td>" + (a.desires || 0) + "</td>";
      html +=
        '<td><button class="btn btn-secondary btn-sm" data-agent-config="' +
        a.id +
        '">Configure</button></td>';
      html += "</tr>";
    });

    html += "</table></div>";
    html += '<div id="agent-config-panel"></div>';
    container.innerHTML = html;

    // Bind configure buttons
    container.querySelectorAll("[data-agent-config]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var agentId = btn.dataset.agentConfig;
        var agent = agents.find(function (a) {
          return a.id === agentId;
        });
        if (agent)
          renderAgentConfig(document.getElementById("agent-config-panel"), agent, businessId);
      });
    });
  };

  function renderAgentConfig(panel, agent, businessId) {
    if (!panel) return;

    var autonomyLevels = ["low", "medium", "high"];
    var autonomyOpts = autonomyLevels
      .map(function (l) {
        return (
          '<option value="' +
          l +
          '"' +
          (agent.autonomy_level === l ? " selected" : "") +
          ">" +
          l.charAt(0).toUpperCase() +
          l.slice(1) +
          "</option>"
        );
      })
      .join("");

    var html = '<div class="card" style="margin-top:16px">';
    html +=
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
    html += '<h3 style="margin:0">Configure: ' + MABOS.escapeHtml(agent.name || agent.id) + "</h3>";
    html += '<button class="btn btn-secondary btn-sm" id="agent-config-close">Close</button>';
    html += "</div>";

    // Cognitive state summary cards
    html += '<div class="grid" style="margin-bottom:16px">';
    html +=
      '<div class="card"><div class="stat">' +
      (agent.beliefs || 0) +
      '</div><div class="stat-label">Beliefs</div></div>';
    html +=
      '<div class="card"><div class="stat">' +
      (agent.goals || 0) +
      '</div><div class="stat-label">Goals</div></div>';
    html +=
      '<div class="card"><div class="stat">' +
      (agent.intentions || 0) +
      '</div><div class="stat-label">Intentions</div></div>';
    html +=
      '<div class="card"><div class="stat">' +
      (agent.desires || 0) +
      '</div><div class="stat-label">Desires</div></div>';
    html += "</div>";

    // Status toggle
    html += '<div class="form-group">';
    html += '<label class="form-label">Status</label>';
    html += '<div class="agent-toggle">';
    html +=
      '<label class="toggle-switch"><input type="checkbox" id="agent-status-toggle"' +
      (agent.status !== "disabled" ? " checked" : "") +
      '><span class="toggle-slider"></span></label>';
    html +=
      '<span id="agent-status-label">' +
      (agent.status !== "disabled" ? "Active" : "Disabled") +
      "</span>";
    html += "</div></div>";

    // Autonomy level
    html += '<div class="form-group">';
    html += '<label class="form-label">Autonomy Level</label>';
    html += '<select class="form-select" id="agent-autonomy">' + autonomyOpts + "</select>";
    html += '<div style="color:var(--text-muted);font-size:0.8em;margin-top:4px">';
    html +=
      "Low: all actions require approval. Medium: routine actions auto-approved. High: only high-cost actions require approval.";
    html += "</div></div>";

    // Approval threshold
    html += '<div class="form-group">';
    html += '<label class="form-label">Approval Threshold ($)</label>';
    html +=
      '<input type="number" class="form-input" id="agent-threshold" value="' +
      (agent.approval_threshold_usd || 100) +
      '" min="0" step="10">';
    html +=
      '<div style="color:var(--text-muted);font-size:0.8em;margin-top:4px">Actions above this cost require stakeholder approval.</div>';
    html += "</div>";

    html +=
      '<div class="btn-group"><button class="btn btn-primary btn-sm" id="agent-config-save">Save Configuration</button></div>';
    html += "</div>";
    panel.innerHTML = html;

    // Bind events
    document.getElementById("agent-config-close").addEventListener("click", function () {
      panel.innerHTML = "";
    });

    document.getElementById("agent-status-toggle").addEventListener("change", function () {
      document.getElementById("agent-status-label").textContent = this.checked
        ? "Active"
        : "Disabled";
    });

    document.getElementById("agent-config-save").addEventListener("click", async function () {
      var status = document.getElementById("agent-status-toggle").checked ? "active" : "disabled";
      var autonomy = document.getElementById("agent-autonomy").value;
      var threshold = parseInt(document.getElementById("agent-threshold").value, 10) || 100;

      var result = await MABOS.putJSON(
        "/mabos/api/businesses/" + businessId + "/agents/" + agent.id,
        {
          status: status,
          autonomy_level: autonomy,
          approval_threshold_usd: threshold,
        },
      );

      if (result && result.ok) {
        agent.status = status;
        agent.autonomy_level = autonomy;
        agent.approval_threshold_usd = threshold;
        alert("Configuration saved.");
      } else {
        alert("Failed to save configuration.");
      }
    });
  }
})();

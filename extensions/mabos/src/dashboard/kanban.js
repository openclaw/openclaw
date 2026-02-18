/**
 * MABOS Dashboard — Kanban Board View
 */

(function () {
  var expandedCard = null;

  MABOS.renderKanban = async function (container, businessId) {
    if (!businessId) {
      container.innerHTML = '<div class="empty-state"><h3>Select a business first</h3></div>';
      return;
    }

    var data = await MABOS.fetchJSON("/mabos/api/businesses/" + businessId + "/tasks");
    var tasks = (data && data.tasks) || [];

    if (tasks.length === 0) {
      container.innerHTML =
        '<div class="empty-state"><h3>No tasks found</h3><p>Tasks appear when agents create plans in Plans.md files.</p></div>';
      return;
    }

    var columns = {
      proposed: { title: "Proposed", tasks: [] },
      active: { title: "Active", tasks: [] },
      "in progress": { title: "In Progress", tasks: [] },
      in_progress: { title: "In Progress", tasks: [] },
      completed: { title: "Completed", tasks: [] },
    };

    tasks.forEach(function (t) {
      var status = (t.status || "proposed").toLowerCase().replace(/_/g, " ");
      if (columns[status]) {
        columns[status].tasks.push(t);
      } else if (status === "in progress" || status === "in_progress") {
        columns["in progress"].tasks.push(t);
      } else {
        columns.proposed.tasks.push(t);
      }
    });

    // Merge in_progress into "in progress"
    if (columns["in_progress"]) {
      columns["in progress"].tasks = columns["in progress"].tasks.concat(
        columns["in_progress"].tasks,
      );
    }

    var displayColumns = ["proposed", "active", "in progress", "completed"];
    var html = '<div class="kanban-board">';

    displayColumns.forEach(function (key) {
      var col = columns[key];
      if (!col) return;
      html += '<div class="kanban-column">';
      html +=
        '<div class="kanban-column-header"><span>' +
        col.title +
        '</span><span class="badge badge-info">' +
        col.tasks.length +
        "</span></div>";
      html += '<div class="kanban-column-body">';

      col.tasks.forEach(function (t) {
        var isExpanded = expandedCard === t.id;
        html +=
          '<div class="kanban-card' +
          (isExpanded ? " kanban-card-expanded" : "") +
          '" data-task-id="' +
          t.id +
          '">';
        html +=
          '<div class="kanban-card-title">' + MABOS.escapeHtml(t.description || t.id) + "</div>";
        html += '<div class="kanban-card-meta">';
        html +=
          '<span class="badge badge-info" style="font-size:0.7em">' +
          MABOS.escapeHtml(t.plan_name || t.plan_id || "") +
          "</span> ";
        html +=
          '<span class="kanban-agent-badge">' +
          MABOS.escapeHtml(t.assigned_to || t.agent_id || "") +
          "</span>";
        if (t.estimated_duration && t.estimated_duration !== "-") {
          html +=
            ' <span style="color:var(--text-muted);font-size:0.75em">' +
            MABOS.escapeHtml(t.estimated_duration) +
            "</span>";
        }
        html += "</div>";

        if (isExpanded) {
          html += '<div class="kanban-card-details">';
          html += "<div><strong>Full ID:</strong> " + t.id + "</div>";
          html += "<div><strong>Type:</strong> " + MABOS.escapeHtml(t.type || "-") + "</div>";
          html += "<div><strong>Agent:</strong> " + MABOS.escapeHtml(t.agent_id || "-") + "</div>";
          if (t.depends_on && t.depends_on.length > 0 && t.depends_on[0]) {
            html += "<div><strong>Dependencies:</strong> " + t.depends_on.join(", ") + "</div>";
          }
          html +=
            '<div style="margin-top:8px"><label class="form-label" style="font-size:0.8em">Update Status:</label>';
          html +=
            '<select class="form-select" style="font-size:0.8em" data-update-task="' + t.id + '">';
          ["proposed", "active", "in progress", "completed"].forEach(function (s) {
            var sel =
              (t.status || "proposed").toLowerCase().replace(/_/g, " ") === s ? " selected" : "";
            html +=
              '<option value="' +
              s +
              '"' +
              sel +
              ">" +
              s.charAt(0).toUpperCase() +
              s.slice(1) +
              "</option>";
          });
          html += "</select></div>";
          html += "</div>";
        }

        html += "</div>";
      });

      html += "</div></div>";
    });

    html += "</div>";
    container.innerHTML = html;

    // Bind click to expand
    container.querySelectorAll(".kanban-card").forEach(function (card) {
      card.addEventListener("click", function (e) {
        if (e.target.tagName === "SELECT" || e.target.tagName === "OPTION") return;
        var id = card.dataset.taskId;
        expandedCard = expandedCard === id ? null : id;
        MABOS.renderKanban(container, businessId);
      });
    });

    // Bind status update
    container.querySelectorAll("[data-update-task]").forEach(function (sel) {
      sel.addEventListener("change", async function () {
        var taskId = sel.dataset.updateTask;
        await MABOS.postJSON("/mabos/api/businesses/" + businessId + "/tasks/" + taskId, {
          status: sel.value,
        });
        expandedCard = null;
        MABOS.renderKanban(container, businessId);
      });
    });
  };
})();

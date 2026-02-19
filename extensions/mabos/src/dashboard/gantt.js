/**
 * MABOS Dashboard — Gantt Chart View
 */

(function () {
  var viewMode = "day"; // "day" or "week"

  MABOS.renderGantt = async function (container, businessId) {
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

    // Parse durations and compute dates
    var now = new Date();
    var minDate = new Date(now);
    var maxDate = new Date(now);
    var cumulativeDay = 0;

    // Group by plan
    var plans = {};
    tasks.forEach(function (t) {
      var planId = t.plan_id || "unplanned";
      if (!plans[planId]) plans[planId] = { name: t.plan_name || planId, tasks: [] };
      plans[planId].tasks.push(t);
    });

    // Assign start/end days to tasks
    var allBars = [];
    Object.keys(plans).forEach(function (planId) {
      var planTasks = plans[planId].tasks;
      var planStart = cumulativeDay;

      planTasks.forEach(function (t) {
        var durationDays = parseDuration(t.estimated_duration);
        t._startDay = cumulativeDay;
        t._endDay = cumulativeDay + durationDays;
        t._durationDays = durationDays;
        cumulativeDay += durationDays;
        allBars.push(t);
      });
    });

    var totalDays = Math.max(cumulativeDay, 14);
    maxDate.setDate(maxDate.getDate() + totalDays);

    // Determine columns
    var columns = [];
    if (viewMode === "week") {
      var numWeeks = Math.ceil(totalDays / 7);
      for (var w = 0; w < numWeeks; w++) {
        var d = new Date(now);
        d.setDate(d.getDate() + w * 7);
        columns.push("W" + (w + 1));
      }
    } else {
      for (var d = 0; d < totalDays; d++) {
        var dt = new Date(now);
        dt.setDate(dt.getDate() + d);
        columns.push(dt.getMonth() + 1 + "/" + dt.getDate());
      }
    }

    // Build HTML
    var html = '<div class="gantt-controls" style="margin-bottom:8px">';
    html +=
      '<button class="btn btn-sm ' +
      (viewMode === "day" ? "btn-primary" : "btn-secondary") +
      '" id="gantt-day">Day</button> ';
    html +=
      '<button class="btn btn-sm ' +
      (viewMode === "week" ? "btn-primary" : "btn-secondary") +
      '" id="gantt-week">Week</button>';
    html += "</div>";

    html += '<div class="gantt-container">';

    // Header
    html += '<div class="gantt-header">';
    html += '<div class="gantt-label-col">Task</div>';
    html += '<div class="gantt-timeline-header">';
    columns.forEach(function (col) {
      html += '<div class="gantt-col-header">' + col + "</div>";
    });
    html += "</div></div>";

    // Rows
    var colCount = columns.length;
    Object.keys(plans).forEach(function (planId) {
      // Plan header row
      html += '<div class="gantt-row gantt-plan-row">';
      html +=
        '<div class="gantt-label-col gantt-plan-label">' +
        MABOS.escapeHtml(plans[planId].name) +
        "</div>";
      html += '<div class="gantt-timeline"></div>';
      html += "</div>";

      plans[planId].tasks.forEach(function (t) {
        var statusClass =
          "gantt-bar-" +
          (t.status || "proposed").toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-");
        var leftPct, widthPct;

        if (viewMode === "week") {
          leftPct = (t._startDay / 7 / (colCount || 1)) * 100;
          widthPct = Math.max((t._durationDays / 7 / (colCount || 1)) * 100, 2);
        } else {
          leftPct = (t._startDay / (colCount || 1)) * 100;
          widthPct = Math.max((t._durationDays / (colCount || 1)) * 100, 2);
        }

        html += '<div class="gantt-row">';
        html +=
          '<div class="gantt-label-col" title="' +
          MABOS.escapeHtml(t.description || "") +
          '">' +
          MABOS.escapeHtml(truncate(t.description || t.id, 30)) +
          "</div>";
        html += '<div class="gantt-timeline">';
        html +=
          '<div class="gantt-bar ' +
          statusClass +
          '" style="left:' +
          leftPct +
          "%;width:" +
          widthPct +
          '%" title="' +
          MABOS.escapeHtml(t.description || "") +
          " (" +
          MABOS.escapeHtml(t.assigned_to || t.agent_id || "") +
          ", " +
          (t.estimated_duration || "?") +
          ')">';
        html +=
          '<span class="gantt-bar-text">' +
          MABOS.escapeHtml(truncate(t.description || "", 20)) +
          "</span>";
        html += "</div>";
        html += "</div></div>";
      });
    });

    html += "</div>";
    container.innerHTML = html;

    // Bind view toggle
    var dayBtn = document.getElementById("gantt-day");
    var weekBtn = document.getElementById("gantt-week");
    if (dayBtn)
      dayBtn.addEventListener("click", function () {
        viewMode = "day";
        MABOS.renderGantt(container, businessId);
      });
    if (weekBtn)
      weekBtn.addEventListener("click", function () {
        viewMode = "week";
        MABOS.renderGantt(container, businessId);
      });

    // Tooltip on hover
    container.querySelectorAll(".gantt-bar").forEach(function (bar) {
      bar.addEventListener("mouseenter", function (e) {
        var tooltip = document.createElement("div");
        tooltip.className = "gantt-tooltip";
        tooltip.textContent = bar.getAttribute("title");
        tooltip.style.left = e.pageX + 10 + "px";
        tooltip.style.top = e.pageY + 10 + "px";
        document.body.appendChild(tooltip);
        bar._tooltip = tooltip;
      });
      bar.addEventListener("mouseleave", function () {
        if (bar._tooltip) {
          bar._tooltip.remove();
          bar._tooltip = null;
        }
      });
    });
  };

  function parseDuration(str) {
    if (!str || str === "-") return 1;
    var match = str.match(/(\d+)\s*(d|day|days|w|week|weeks|h|hour|hours)/i);
    if (match) {
      var num = parseInt(match[1], 10);
      var unit = match[2].toLowerCase();
      if (unit.startsWith("w")) return num * 7;
      if (unit.startsWith("h")) return Math.max(Math.ceil(num / 8), 1);
      return num;
    }
    var num2 = parseInt(str, 10);
    return isNaN(num2) ? 1 : num2;
  }

  function truncate(str, max) {
    return str.length > max ? str.substring(0, max - 2) + ".." : str;
  }
})();

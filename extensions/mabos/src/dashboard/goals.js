/**
 * MABOS Dashboard — TROPOS i* Goal Model Visualization (SVG)
 */

(function () {
  var selectedGoal = null;
  var panOffset = { x: 0, y: 0 };
  var isPanning = false;
  var panStart = { x: 0, y: 0 };
  var zoom = 1;

  MABOS.renderGoalModel = async function (container, businessId) {
    if (!businessId) {
      container.innerHTML =
        '<div class="empty-state"><h3>Select a business first</h3><p>Use the business switcher in the sidebar.</p></div>';
      return;
    }

    container.innerHTML = '<div class="loading">Loading goal model...</div>';
    var data = await MABOS.fetchJSON("/mabos/api/businesses/" + businessId + "/goals");
    if (!data) {
      container.innerHTML =
        '<div class="empty-state"><h3>No goal model found</h3><p>Goals will appear after onboarding.</p></div>';
      return;
    }

    var html =
      '<div class="view-header"><h2>Goal Model</h2><span class="badge badge-info">TROPOS i*</span></div>';
    html += '<div class="goal-toolbar" id="goal-toolbar">';
    html += '<button class="btn btn-primary btn-sm" id="goal-add-btn">Add Goal</button>';
    html += '<button class="btn btn-secondary btn-sm" id="goal-zoom-in">Zoom In</button>';
    html += '<button class="btn btn-secondary btn-sm" id="goal-zoom-out">Zoom Out</button>';
    html += '<button class="btn btn-secondary btn-sm" id="goal-reset">Reset View</button>';
    html += "</div>";
    html +=
      '<div class="goal-canvas" id="goal-canvas"><svg id="goal-svg" width="100%" height="600"></svg></div>';
    html += '<div class="goal-panel" id="goal-panel" style="display:none"></div>';
    container.innerHTML = html;

    renderSVG(data, businessId);
    bindEvents(data, businessId);
  };

  function renderSVG(data, businessId) {
    var svg = document.getElementById("goal-svg");
    if (!svg) return;
    var svgNS = "http://www.w3.org/2000/svg";
    svg.innerHTML = "";

    // SVG defs for arrowheads
    var defs = document.createElementNS(svgNS, "defs");
    var marker = document.createElementNS(svgNS, "marker");
    marker.setAttribute("id", "arrowhead");
    marker.setAttribute("markerWidth", "10");
    marker.setAttribute("markerHeight", "7");
    marker.setAttribute("refX", "10");
    marker.setAttribute("refY", "3.5");
    marker.setAttribute("orient", "auto");
    var polygon = document.createElementNS(svgNS, "polygon");
    polygon.setAttribute("points", "0 0, 10 3.5, 0 7");
    polygon.setAttribute("fill", "var(--text-muted)");
    marker.appendChild(polygon);
    defs.appendChild(marker);

    var marker2 = marker.cloneNode(true);
    marker2.setAttribute("id", "arrowhead-accent");
    marker2.querySelector("polygon").setAttribute("fill", "var(--accent)");
    defs.appendChild(marker2);
    svg.appendChild(defs);

    // Main group for pan/zoom
    var g = document.createElementNS(svgNS, "g");
    g.setAttribute("id", "goal-main-group");
    g.setAttribute(
      "transform",
      "translate(" + panOffset.x + "," + panOffset.y + ") scale(" + zoom + ")",
    );
    svg.appendChild(g);

    var actors = data.actors || [];
    var goals = data.goals || [];
    var dependencies = data.dependencies || [];

    // Layout: compute positions
    var canvasW = 900;
    var stakeholder = actors.find(function (a) {
      return a.type === "principal";
    });
    var agentActors = actors.filter(function (a) {
      return a.type === "agent";
    });

    // Stakeholder at top
    var shX = stakeholder && stakeholder.x ? stakeholder.x : canvasW / 2;
    var shY = stakeholder && stakeholder.y ? stakeholder.y : 40;

    // Agent actors in a row below
    var agentSpacing = canvasW / (agentActors.length + 1);
    agentActors.forEach(function (a, i) {
      if (!a.x || a.x === 0) a.x = agentSpacing * (i + 1);
      if (!a.y || a.y === 0) a.y = 200;
    });

    // Draw stakeholder boundary
    if (stakeholder) {
      drawActorBoundary(g, svgNS, shX - 120, shY - 10, 240, 80, "Stakeholder", "principal");
      // Draw stakeholder goals
      var sGoals = stakeholder.goals || [];
      sGoals.forEach(function (sg, i) {
        var gx = shX - 80 + i * 60;
        var gy = shY + 25;
        drawGoalNode(g, svgNS, gx, gy, sg.goal || sg, "hard", 0.9, "SG-" + i);
      });
    }

    // Draw agent boundaries and their goals
    agentActors.forEach(function (actor) {
      var agentGoals = goals.filter(function (goal) {
        return goal.actor === actor.id;
      });
      var bw = Math.max(140, agentGoals.length * 70 + 40);
      var bh = agentGoals.length > 0 ? 120 : 60;
      drawActorBoundary(
        g,
        svgNS,
        actor.x - bw / 2,
        actor.y - 15,
        bw,
        bh,
        actor.id.toUpperCase(),
        "agent",
      );

      agentGoals.forEach(function (goal, i) {
        var gx = actor.x - bw / 2 + 40 + i * 65;
        var gy = actor.y + 30;
        var goalType = goal.type || "hard";
        drawGoalNode(g, svgNS, gx, gy, goal.text, goalType, goal.priority, goal.id);

        // Draw linked tasks
        if (goal.linked_tasks && goal.linked_tasks.length > 0) {
          goal.linked_tasks.forEach(function (taskId, ti) {
            var tx = gx + ti * 50;
            var ty = gy + 50;
            drawTaskNode(g, svgNS, tx, ty, taskId);
            drawMeansEndLink(g, svgNS, tx, ty - 8, gx, gy + 15);
          });
        }
      });
    });

    // Draw dependency arrows from stakeholder to agents
    dependencies.forEach(function (dep) {
      var fromActor = actors.find(function (a) {
        return a.id === dep.from;
      });
      var toActor = actors.find(function (a) {
        return a.id === dep.to;
      });
      if (fromActor && toActor) {
        var fx = fromActor.type === "principal" ? shX : fromActor.x || 0;
        var fy = fromActor.type === "principal" ? shY + 60 : fromActor.y || 0;
        var tx = toActor.x || 0;
        var ty = (toActor.y || 200) - 15;
        drawDependencyArrow(g, svgNS, fx, fy, tx, ty);
      }
    });

    // Draw contribution links between goals
    goals.forEach(function (goal) {
      if (goal.contributions) {
        goal.contributions.forEach(function (c) {
          var target = goals.find(function (tg) {
            return tg.id === c.target;
          });
          if (target) {
            drawContributionLink(g, svgNS, goal, target, c.type);
          }
        });
      }
    });
  }

  function drawActorBoundary(parent, ns, x, y, w, h, label, type) {
    var rect = document.createElementNS(ns, "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", w);
    rect.setAttribute("height", h);
    rect.setAttribute("class", "goal-actor-boundary");
    rect.setAttribute("rx", "12");
    parent.appendChild(rect);

    var text = document.createElementNS(ns, "text");
    text.setAttribute("x", x + 8);
    text.setAttribute("y", y + 14);
    text.setAttribute("class", "goal-label");
    text.setAttribute("text-anchor", "start");
    text.setAttribute("font-weight", "bold");
    text.setAttribute("fill", type === "principal" ? "var(--accent)" : "var(--text-secondary)");
    text.textContent = label;
    parent.appendChild(text);
  }

  function drawGoalNode(parent, ns, x, y, text, type, priority, id) {
    var el;
    if (type === "soft") {
      // Cloud shape approximation with ellipse + dashed
      el = document.createElementNS(ns, "ellipse");
      el.setAttribute("cx", x);
      el.setAttribute("cy", y);
      el.setAttribute("rx", "28");
      el.setAttribute("ry", "14");
      el.setAttribute("class", "goal-node-soft");
    } else {
      // Rounded oval for hard goals
      el = document.createElementNS(ns, "ellipse");
      el.setAttribute("cx", x);
      el.setAttribute("cy", y);
      el.setAttribute("rx", "28");
      el.setAttribute("ry", "14");
      el.setAttribute("class", "goal-node-hard");
    }
    el.setAttribute("data-goal-id", id || "");
    el.style.cursor = "pointer";
    parent.appendChild(el);

    // Truncated label
    var label = document.createElementNS(ns, "text");
    label.setAttribute("x", x);
    label.setAttribute("y", y + 4);
    label.setAttribute("class", "goal-label");
    label.setAttribute("font-size", "9");
    var displayText = (text || "").length > 18 ? text.substring(0, 16) + ".." : text;
    label.textContent = displayText;
    parent.appendChild(label);

    // Priority badge
    if (priority !== undefined) {
      var badge = document.createElementNS(ns, "text");
      badge.setAttribute("x", x + 30);
      badge.setAttribute("y", y - 8);
      badge.setAttribute("class", "goal-priority-badge");
      badge.textContent = (priority * 100).toFixed(0) + "%";
      parent.appendChild(badge);
    }
  }

  function drawTaskNode(parent, ns, x, y, label) {
    // Hexagon for tasks
    var size = 12;
    var points = [];
    for (var i = 0; i < 6; i++) {
      var angle = (Math.PI / 3) * i - Math.PI / 6;
      points.push(
        (x + size * Math.cos(angle)).toFixed(1) + "," + (y + size * Math.sin(angle)).toFixed(1),
      );
    }
    var hex = document.createElementNS(ns, "polygon");
    hex.setAttribute("points", points.join(" "));
    hex.setAttribute("class", "goal-node-task");
    hex.setAttribute("data-task-id", label);
    parent.appendChild(hex);

    var text = document.createElementNS(ns, "text");
    text.setAttribute("x", x);
    text.setAttribute("y", y + 3);
    text.setAttribute("class", "goal-label");
    text.setAttribute("font-size", "7");
    text.textContent = label;
    parent.appendChild(text);
  }

  function drawDependencyArrow(parent, ns, x1, y1, x2, y2) {
    var line = document.createElementNS(ns, "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("class", "goal-dependency");
    parent.appendChild(line);
  }

  function drawMeansEndLink(parent, ns, x1, y1, x2, y2) {
    var line = document.createElementNS(ns, "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("class", "goal-means-end");
    parent.appendChild(line);
  }

  function drawContributionLink(parent, ns, from, to, type) {
    // Approximate positions
    var fromActor =
      (MABOS._goalData || { actors: [] }).actors.find(function (a) {
        return a.id === from.actor;
      }) || {};
    var toActor =
      (MABOS._goalData || { actors: [] }).actors.find(function (a) {
        return a.id === to.actor;
      }) || {};
    var fx = fromActor.x || 400;
    var fy = (fromActor.y || 200) + 30;
    var tx = toActor.x || 400;
    var ty = (toActor.y || 200) + 30;
    if (fx === tx && fy === ty) return;

    var line = document.createElementNS(ns, "line");
    line.setAttribute("x1", fx);
    line.setAttribute("y1", fy);
    line.setAttribute("x2", tx);
    line.setAttribute("y2", ty);
    line.setAttribute(
      "class",
      type === "++" || type === "+" ? "goal-contribution-pos" : "goal-contribution-neg",
    );
    line.setAttribute("stroke-width", "1.5");
    line.setAttribute("stroke-dasharray", "3,3");
    parent.appendChild(line);
  }

  function bindEvents(data, businessId) {
    MABOS._goalData = data;

    // Click on goal nodes
    document.getElementById("goal-canvas").addEventListener("click", function (e) {
      var target = e.target;
      var goalId = target.getAttribute("data-goal-id");
      var taskId = target.getAttribute("data-task-id");

      if (goalId) {
        var goal = data.goals.find(function (g) {
          return g.id === goalId;
        });
        if (goal) showGoalPanel(goal, data, businessId);
      } else if (taskId) {
        // Navigate to Kanban filtered to this task
        MABOS.navigate("workflows", { filter: taskId });
      } else {
        hideGoalPanel();
      }
    });

    // Add goal button
    document.getElementById("goal-add-btn").addEventListener("click", function () {
      showAddGoalModal(data, businessId);
    });

    // Zoom controls
    document.getElementById("goal-zoom-in").addEventListener("click", function () {
      zoom = Math.min(zoom + 0.2, 3);
      updateTransform();
    });
    document.getElementById("goal-zoom-out").addEventListener("click", function () {
      zoom = Math.max(zoom - 0.2, 0.3);
      updateTransform();
    });
    document.getElementById("goal-reset").addEventListener("click", function () {
      zoom = 1;
      panOffset = { x: 0, y: 0 };
      updateTransform();
    });

    // Pan via mouse drag on canvas
    var canvas = document.getElementById("goal-canvas");
    canvas.addEventListener("mousedown", function (e) {
      if (e.target.tagName === "svg" || e.target.id === "goal-svg") {
        isPanning = true;
        panStart = { x: e.clientX - panOffset.x, y: e.clientY - panOffset.y };
      }
    });
    canvas.addEventListener("mousemove", function (e) {
      if (isPanning) {
        panOffset.x = e.clientX - panStart.x;
        panOffset.y = e.clientY - panStart.y;
        updateTransform();
      }
    });
    canvas.addEventListener("mouseup", function () {
      isPanning = false;
    });
    canvas.addEventListener("mouseleave", function () {
      isPanning = false;
    });

    // Mouse wheel zoom
    canvas.addEventListener("wheel", function (e) {
      e.preventDefault();
      zoom += e.deltaY > 0 ? -0.1 : 0.1;
      zoom = Math.max(0.3, Math.min(3, zoom));
      updateTransform();
    });
  }

  function updateTransform() {
    var g = document.getElementById("goal-main-group");
    if (g)
      g.setAttribute(
        "transform",
        "translate(" + panOffset.x + "," + panOffset.y + ") scale(" + zoom + ")",
      );
  }

  function showGoalPanel(goal, data, businessId) {
    var panel = document.getElementById("goal-panel");
    if (!panel) return;
    panel.style.display = "block";
    selectedGoal = goal;

    var actor = data.actors.find(function (a) {
      return a.id === goal.actor;
    });
    panel.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<h3 style="margin:0;font-size:1em">Goal Details</h3>' +
      '<button class="btn btn-secondary btn-sm" id="goal-panel-close">&times;</button></div>' +
      '<div class="form-group"><label class="form-label">Goal</label><div style="color:var(--text-primary)">' +
      MABOS.escapeHtml(goal.text) +
      "</div></div>" +
      '<div class="form-group"><label class="form-label">ID</label><div><code>' +
      goal.id +
      "</code></div></div>" +
      '<div class="form-group"><label class="form-label">Type</label><span class="badge ' +
      (goal.type === "hard" ? "badge-active" : "badge-pending") +
      '">' +
      goal.type +
      "</span></div>" +
      '<div class="form-group"><label class="form-label">Priority</label><div>' +
      ((goal.priority || 0) * 100).toFixed(0) +
      "%</div></div>" +
      '<div class="form-group"><label class="form-label">Assigned Agent</label><span class="badge badge-info">' +
      (goal.actor || "unassigned").toUpperCase() +
      "</span></div>" +
      '<div class="form-group"><label class="form-label">Decomposition</label><div>' +
      (goal.decomposition || "AND") +
      "</div></div>" +
      (goal.linked_tasks && goal.linked_tasks.length > 0
        ? '<div class="form-group"><label class="form-label">Linked Tasks</label><div>' +
          goal.linked_tasks
            .map(function (t) {
              return (
                '<span class="badge badge-info" style="cursor:pointer" onclick="MABOS.navigate(\'workflows\',{filter:\'' +
                t +
                "'})\">" +
                t +
                "</span>"
              );
            })
            .join(" ") +
          "</div></div>"
        : "") +
      '<div class="btn-group" style="margin-top:16px">' +
      '<button class="btn btn-secondary btn-sm" id="goal-edit-btn">Edit</button>' +
      '<button class="btn btn-danger btn-sm" id="goal-delete-btn">Delete</button>' +
      '<button class="btn btn-primary btn-sm" id="goal-connect-btn">Connect to Workflow</button>' +
      "</div>";

    document.getElementById("goal-panel-close").addEventListener("click", hideGoalPanel);
    document.getElementById("goal-delete-btn").addEventListener("click", function () {
      if (confirm("Delete goal '" + goal.text + "'?")) {
        data.goals = data.goals.filter(function (g) {
          return g.id !== goal.id;
        });
        saveGoalModel(data, businessId);
        hideGoalPanel();
        renderSVG(data, businessId);
      }
    });
    document.getElementById("goal-edit-btn").addEventListener("click", function () {
      showEditGoalInPanel(goal, data, businessId);
    });
    document.getElementById("goal-connect-btn").addEventListener("click", function () {
      showConnectWorkflow(goal, data, businessId);
    });
  }

  function hideGoalPanel() {
    var panel = document.getElementById("goal-panel");
    if (panel) panel.style.display = "none";
    selectedGoal = null;
  }

  function showEditGoalInPanel(goal, data, businessId) {
    var panel = document.getElementById("goal-panel");
    if (!panel) return;

    var agentOpts = MABOS.CORE_AGENT_ROLES.map(function (r) {
      return (
        '<option value="' +
        r +
        '"' +
        (goal.actor === r ? " selected" : "") +
        ">" +
        r.toUpperCase() +
        "</option>"
      );
    }).join("");

    panel.innerHTML =
      '<h3 style="margin:0 0 12px 0;font-size:1em">Edit Goal</h3>' +
      '<div class="form-group"><label class="form-label">Goal Text</label>' +
      '<input type="text" class="form-input" id="goal-edit-text" value="' +
      MABOS.escapeHtml(goal.text) +
      '"></div>' +
      '<div class="form-group"><label class="form-label">Priority</label>' +
      '<input type="range" id="goal-edit-priority" min="0" max="1" step="0.1" value="' +
      (goal.priority || 0.5) +
      '" style="width:100%">' +
      '<span id="goal-edit-priority-val">' +
      ((goal.priority || 0.5) * 100).toFixed(0) +
      "%</span></div>" +
      '<div class="form-group"><label class="form-label">Type</label>' +
      '<select class="form-select" id="goal-edit-type"><option value="hard"' +
      (goal.type === "hard" ? " selected" : "") +
      '>Hard</option><option value="soft"' +
      (goal.type === "soft" ? " selected" : "") +
      ">Soft</option></select></div>" +
      '<div class="form-group"><label class="form-label">Assigned Agent</label>' +
      '<select class="form-select" id="goal-edit-agent">' +
      agentOpts +
      "</select></div>" +
      '<div class="form-group"><label class="form-label">Decomposition</label>' +
      '<select class="form-select" id="goal-edit-decomp"><option value="AND"' +
      (goal.decomposition === "AND" ? " selected" : "") +
      '>AND</option><option value="OR"' +
      (goal.decomposition === "OR" ? " selected" : "") +
      ">OR</option></select></div>" +
      '<div class="btn-group"><button class="btn btn-primary btn-sm" id="goal-edit-save">Save</button><button class="btn btn-secondary btn-sm" id="goal-edit-cancel">Cancel</button></div>';

    document.getElementById("goal-edit-priority").addEventListener("input", function () {
      document.getElementById("goal-edit-priority-val").textContent =
        (parseFloat(this.value) * 100).toFixed(0) + "%";
    });
    document.getElementById("goal-edit-cancel").addEventListener("click", function () {
      showGoalPanel(goal, data, businessId);
    });
    document.getElementById("goal-edit-save").addEventListener("click", function () {
      goal.text = document.getElementById("goal-edit-text").value;
      goal.priority = parseFloat(document.getElementById("goal-edit-priority").value);
      goal.type = document.getElementById("goal-edit-type").value;
      goal.actor = document.getElementById("goal-edit-agent").value;
      goal.decomposition = document.getElementById("goal-edit-decomp").value;
      saveGoalModel(data, businessId);
      renderSVG(data, businessId);
      showGoalPanel(goal, data, businessId);
    });
  }

  function showAddGoalModal(data, businessId) {
    var panel = document.getElementById("goal-panel");
    if (!panel) return;
    panel.style.display = "block";

    var agentOpts = MABOS.CORE_AGENT_ROLES.map(function (r) {
      return '<option value="' + r + '">' + r.toUpperCase() + "</option>";
    }).join("");

    panel.innerHTML =
      '<h3 style="margin:0 0 12px 0;font-size:1em">Add Goal</h3>' +
      '<div class="form-group"><label class="form-label">Goal Text *</label>' +
      '<input type="text" class="form-input" id="goal-add-text" placeholder="e.g., Achieve $1M ARR"></div>' +
      '<div class="form-group"><label class="form-label">Priority</label>' +
      '<input type="range" id="goal-add-priority" min="0" max="1" step="0.1" value="0.7" style="width:100%">' +
      '<span id="goal-add-priority-val">70%</span></div>' +
      '<div class="form-group"><label class="form-label">Type</label>' +
      '<select class="form-select" id="goal-add-type"><option value="hard">Hard</option><option value="soft">Soft</option></select></div>' +
      '<div class="form-group"><label class="form-label">Assign to Agent</label>' +
      '<select class="form-select" id="goal-add-agent">' +
      agentOpts +
      "</select></div>" +
      '<div class="btn-group"><button class="btn btn-primary btn-sm" id="goal-add-save">Add</button><button class="btn btn-secondary btn-sm" id="goal-add-cancel">Cancel</button></div>';

    document.getElementById("goal-add-priority").addEventListener("input", function () {
      document.getElementById("goal-add-priority-val").textContent =
        (parseFloat(this.value) * 100).toFixed(0) + "%";
    });
    document.getElementById("goal-add-cancel").addEventListener("click", hideGoalPanel);
    document.getElementById("goal-add-save").addEventListener("click", function () {
      var text = document.getElementById("goal-add-text").value.trim();
      if (!text) {
        alert("Goal text is required.");
        return;
      }
      var newGoal = {
        id: "G-" + String(data.goals.length + 1).padStart(3, "0"),
        text: text,
        type: document.getElementById("goal-add-type").value,
        priority: parseFloat(document.getElementById("goal-add-priority").value),
        actor: document.getElementById("goal-add-agent").value,
        parent_goal: null,
        decomposition: "AND",
        linked_tasks: [],
        contributions: [],
      };
      data.goals.push(newGoal);
      saveGoalModel(data, businessId);
      hideGoalPanel();
      renderSVG(data, businessId);
    });
  }

  async function showConnectWorkflow(goal, data, businessId) {
    var panel = document.getElementById("goal-panel");
    if (!panel) return;

    panel.innerHTML = '<div class="loading">Loading tasks...</div>';
    var tasksData = await MABOS.fetchJSON("/mabos/api/businesses/" + businessId + "/tasks");
    var tasks = (tasksData && tasksData.tasks) || [];

    if (tasks.length === 0) {
      panel.innerHTML =
        '<h3 style="margin:0 0 12px">Connect to Workflow</h3><p style="color:var(--text-secondary)">No tasks found. Tasks appear from agent Plans.md files.</p>' +
        '<button class="btn btn-secondary btn-sm" id="goal-connect-back">Back</button>';
      document.getElementById("goal-connect-back").addEventListener("click", function () {
        showGoalPanel(goal, data, businessId);
      });
      return;
    }

    var linked = goal.linked_tasks || [];
    var html = '<h3 style="margin:0 0 12px">Connect to Workflow</h3>';
    html += '<div style="max-height:300px;overflow-y:auto">';
    tasks.forEach(function (t) {
      var checked = linked.indexOf(t.id) >= 0 ? " checked" : "";
      html +=
        '<label style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);cursor:pointer;font-size:0.85em">' +
        '<input type="checkbox" data-task-id="' +
        t.id +
        '"' +
        checked +
        ">" +
        "<span>" +
        MABOS.escapeHtml(t.description || t.id) +
        "</span>" +
        '<span class="badge badge-info" style="margin-left:auto">' +
        (t.assigned_to || t.agent_id) +
        "</span></label>";
    });
    html += "</div>";
    html +=
      '<div class="btn-group" style="margin-top:12px"><button class="btn btn-primary btn-sm" id="goal-connect-save">Save</button><button class="btn btn-secondary btn-sm" id="goal-connect-back">Back</button></div>';
    panel.innerHTML = html;

    document.getElementById("goal-connect-back").addEventListener("click", function () {
      showGoalPanel(goal, data, businessId);
    });
    document.getElementById("goal-connect-save").addEventListener("click", function () {
      var checkboxes = panel.querySelectorAll("input[type=checkbox]");
      goal.linked_tasks = [];
      checkboxes.forEach(function (cb) {
        if (cb.checked) goal.linked_tasks.push(cb.dataset.taskId);
      });
      saveGoalModel(data, businessId);
      renderSVG(data, businessId);
      showGoalPanel(goal, data, businessId);
    });
  }

  async function saveGoalModel(data, businessId) {
    await MABOS.putJSON("/mabos/api/businesses/" + businessId + "/goals", data);
  }
})();

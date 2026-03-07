"""Minimal admin UI: quick-action button panel.

GET /admin/ui/quick-actions — serves a static HTML page that calls
the admin action endpoints with the X-Admin-Token header.
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

_HTML = """\
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Full Digital — Quick Actions</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; margin: 24px; max-width: 820px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
    input, textarea { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 10px; box-sizing: border-box; }
    button { padding: 10px 14px; border: 0; border-radius: 12px; cursor: pointer; font-size: 14px; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .btn { background: #111; color: #fff; }
    .btn:hover:not(:disabled) { background: #333; }
    .btn2 { background: #f2f2f2; }
    .btn2:hover:not(:disabled) { background: #e0e0e0; }
    .card { border: 1px solid #eee; border-radius: 14px; padding: 14px; margin-top: 14px; }
    pre { background: #fafafa; border: 1px solid #eee; border-radius: 12px; padding: 10px; overflow: auto; max-height: 400px; font-size: 13px; }
    label { font-size: 12px; color: #666; display: block; margin-bottom: 4px; }
    h2 { margin-top: 0; }
    .status { font-size: 13px; color: #666; margin-top: 8px; }
    .tl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; margin-top: 10px; }
    .tl-card { border-radius: 12px; padding: 12px 14px; color: #fff; }
    .tl-card h4 { margin: 0 0 6px; font-size: 15px; }
    .tl-card .tl-meta { font-size: 12px; opacity: .85; }
    .tl-card .tl-actions { margin-top: 8px; display: flex; gap: 6px; }
    .tl-card .tl-actions button { background: rgba(255,255,255,.25); color: #fff; border: 1px solid rgba(255,255,255,.4); border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
    .tl-card .tl-actions button:hover:not(:disabled) { background: rgba(255,255,255,.4); }
    .tl-card .tl-plan { font-size: 11px; opacity: .8; margin-top: 4px; }
    .tl-card .tl-panel { margin-top: 6px; font-size: 11px; opacity: .9; line-height: 1.4; }
    .tl-green { background: #16a34a; }
    .tl-yellow { background: #ca8a04; }
    .tl-red { background: #dc2626; }
    .tl-grey { background: #9ca3af; }
    .tl-overall { display: inline-block; padding: 4px 12px; border-radius: 8px; color: #fff; font-weight: 600; font-size: 14px; }
    .tl-incidents { margin-top: 10px; font-size: 13px; }
    .tl-incidents li { margin-bottom: 4px; }
    /* Toast system */
    .toast-container { position: fixed; top: 16px; right: 16px; display: flex; flex-direction: column; gap: 10px; z-index: 9999; }
    .toast { min-width: 260px; max-width: 360px; padding: 12px 14px; border-radius: 12px; border: 1px solid #e5e7eb; background: #fff; box-shadow: 0 10px 18px rgba(0,0,0,.08); font-size: 14px; line-height: 1.3; }
    .toast .t-title { font-weight: 700; margin-bottom: 3px; }
    .toast .t-msg { color: #111827; }
    .toast .t-meta { margin-top: 4px; font-size: 12px; color: #374151; opacity: .85; }
    .toast.ok { border-color: #86efac; background: #ecfdf3; }
    .toast.warn { border-color: #fdba74; background: #fff7ed; }
    .toast.bad { border-color: #fda4af; background: #fff1f2; }
    .toast.fade-out { animation: toastOut .3s ease-out forwards; }
    @keyframes toastOut { to { opacity: 0; transform: translateY(-4px); } }
    /* Simple Mode */
    .simple-mode .advanced-section { display: none !important; }
    .mode-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; font-size: 13px; }
    .mode-toggle input { margin: 0; }
    .header-bar { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
    .chip { display: inline-block; padding: 4px 12px; border-radius: 8px; font-size: 13px; font-weight: 600; color: #fff; }
    .chip-green { background: #16a34a; }
    .chip-yellow { background: #ca8a04; }
    .chip-red { background: #dc2626; }
    .chip-grey { background: #9ca3af; }
  </style>
</head>
<body>
  <div id="toastContainer" class="toast-container"></div>
  <div class="header-bar">
    <h2 style="margin:0;">Quick Actions</h2>
    <div id="healthChip" class="chip chip-grey">Loading</div>
    <label class="mode-toggle">
      <input id="simpleModeToggle" type="checkbox" />
      <span><strong>Simple Mode</strong></span>
    </label>
  </div>
  <p style="font-size:14px;color:#555;">
    Enter Internal Card ID (preferred) or Client Card ID. Actions operate on the mapped client card.
  </p>

  <div class="card">
    <div class="row">
      <div style="flex:1 1 200px;">
        <label>Admin Token</label>
        <input id="token" type="password" placeholder="X-Admin-Token" />
      </div>
    </div>
    <div class="row">
      <div style="flex:1 1 360px;">
        <label>Internal Card ID</label>
        <input id="internal_card_id" placeholder="e.g. 65f9c..." />
      </div>
      <div style="flex:1 1 360px;">
        <label>Client Card ID (optional fallback)</label>
        <input id="client_card_id" placeholder="optional" />
      </div>
    </div>

    <div class="row">
      <div style="flex:1 1 360px;">
        <label>URL (for Draft / Final)</label>
        <input id="url" placeholder="https://..." />
      </div>
      <div style="flex:1 1 360px;">
        <label>Note (optional)</label>
        <input id="note" placeholder="Short note" />
      </div>
    </div>

    <div class="row">
      <button class="btn" onclick="postDraft()">Post Draft Link</button>
      <button class="btn" onclick="postFinal()">Post Final Link</button>
    </div>

    <div class="row">
      <div style="flex:1 1 100%;">
        <label>Client Review Message (optional)</label>
        <textarea id="message" rows="3" placeholder="Leave empty for default professional message."></textarea>
      </div>
    </div>

    <div class="row">
      <button class="btn2" onclick="requestReview()">Request Client Review</button>
      <button class="btn2" onclick="clearFields()">Clear</button>
    </div>
  </div>

  <div class="card advanced-section">
    <h3 style="margin-top:0;">Result</h3>
    <div class="status" id="status"></div>
    <pre id="out">{}</pre>
  </div>

  <div class="card advanced-section">
    <h3 style="margin-top:0;">Notion — Fix Views Registry</h3>
    <p style="font-size:13px;color:#666;margin-top:0;">
      Runs: seed_minimum &rarr; heal &rarr; rerender CC widgets.<br>
      Simulate is safe (read-only). Apply requires write_lock OFF and no cooldown.
    </p>
    <div class="row">
      <button class="btn2" onclick="fixViewsRegistry(true)">Fix Views Registry (Simulate)</button>
      <button class="btn" onclick="fixViewsRegistry(false)">Fix Views Registry (Apply)</button>
    </div>
    <div class="status" id="fix-status"></div>
    <pre id="fix-out">{}</pre>
  </div>

  <div class="card">
    <h3 style="margin-top:0;">WebOps Status</h3>
    <p style="font-size:13px;color:#666;margin-top:0;">
      Auto-refreshes every 15 s. Run checks first to populate.
    </p>
    <div id="webopsOverall" style="margin-bottom:8px;"></div>
    <div id="webopsGrid" class="tl-grid"></div>
    <div id="webopsIncidents" class="tl-incidents"></div>
  </div>

  <div class="card advanced-section">
    <h3 style="margin-top:0;">WebOps — Infrastructure Health</h3>
    <p style="font-size:13px;color:#666;margin-top:0;">
      Checks: Cloudflare DNS/SSL &rarr; Vercel deployments &rarr; Webflow publish &rarr; GA/PostHog tracking &rarr; Stripe webhooks.<br>
      Read-only: compares actual provider state vs config/sites.yaml.
    </p>
    <div class="row">
      <button class="btn2" onclick="runWebOps('run_checks')">Run All WebOps Checks</button>
      <button class="btn2" onclick="runWebOps('drift')">View Drift + Proposals</button>
      <button class="btn2" onclick="runWebOps('train_stack')">Train Stack Map</button>
    </div>
    <div class="status" id="webops-status"></div>
    <pre id="webops-out">{}</pre>
  </div>

<script>
/* ── Simple Mode toggle ── */
function setSimpleMode(on) {
  if (on) document.body.classList.add("simple-mode");
  else document.body.classList.remove("simple-mode");
  localStorage.setItem("openclaw_simple_mode", on ? "1" : "0");
}
(function initSimpleMode() {
  var on = localStorage.getItem("openclaw_simple_mode") === "1";
  var toggle = document.getElementById("simpleModeToggle");
  toggle.checked = on;
  setSimpleMode(on);
  toggle.addEventListener("change", function() { setSimpleMode(toggle.checked); });
})();

function updateHealthChip(overall) {
  var chip = document.getElementById("healthChip");
  var map = { green: ["All Good", "chip-green"], yellow: ["Warnings", "chip-yellow"], red: ["Issues", "chip-red"] };
  var info = map[overall] || ["Unknown", "chip-grey"];
  chip.textContent = info[0];
  chip.className = "chip " + info[1];
}

function getToken() {
  return document.getElementById("token").value || "";
}

async function callApi(path, payload) {
  document.getElementById("status").textContent = "Calling " + path + "...";
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": getToken()
      },
      body: JSON.stringify(payload)
    });
    const txt = await res.text();
    document.getElementById("status").textContent = "Done (" + res.status + ")";
    try { return JSON.parse(txt); } catch { return {raw: txt, status: res.status}; }
  } catch (e) {
    document.getElementById("status").textContent = "Error: " + e.message;
    return {error: e.message};
  }
}

function basePayload() {
  return {
    internal_card_id: document.getElementById("internal_card_id").value || null,
    client_card_id: document.getElementById("client_card_id").value || null,
  };
}

async function postDraft() {
  const p = basePayload();
  p.url = document.getElementById("url").value;
  p.note = document.getElementById("note").value || null;
  const out = await callApi("/admin/actions/post_draft_link", p);
  document.getElementById("out").textContent = JSON.stringify(out, null, 2);
}

async function postFinal() {
  const p = basePayload();
  p.url = document.getElementById("url").value;
  p.note = document.getElementById("note").value || null;
  const out = await callApi("/admin/actions/post_final_link", p);
  document.getElementById("out").textContent = JSON.stringify(out, null, 2);
}

async function requestReview() {
  const p = basePayload();
  p.message = document.getElementById("message").value || null;
  const out = await callApi("/admin/actions/request_client_review", p);
  document.getElementById("out").textContent = JSON.stringify(out, null, 2);
}

function clearFields() {
  ["url","note","message"].forEach(function(id) { document.getElementById(id).value = ""; });
}

async function runWebOps(action) {
  var out = document.getElementById("webops-out");
  var st = document.getElementById("webops-status");
  st.textContent = "Running " + action + "...";
  out.textContent = "";
  var method = (action === "drift") ? "GET" : "POST";
  try {
    var res = await fetch("/admin/webops/" + action, {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": getToken()
      }
    });
    var json = await res.json();
    out.textContent = JSON.stringify(json, null, 2);
    st.textContent = json.ok ? "Done." : "Completed with issues.";
  } catch (e) {
    st.textContent = "Error: " + e.message;
  }
}

function toast(kind, title, msg, meta) {
  var c = document.getElementById("toastContainer");
  var el = document.createElement("div");
  el.className = "toast " + (kind || "");
  el.innerHTML = '<div class="t-title">' + title + '</div>' +
    '<div class="t-msg">' + msg + '</div>' +
    (meta ? '<div class="t-meta">' + meta + '</div>' : '');
  c.appendChild(el);
  setTimeout(function() { el.classList.add("fade-out"); }, 3500);
  setTimeout(function() { el.remove(); }, 3900);
}

function sitePanel(siteKey) {
  var sk = siteKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  return document.getElementById("panel_" + sk);
}

function setSiteButtons(siteKey, disabled) {
  var sk = siteKey.replace(/[^a-zA-Z0-9_-]/g, "_");
  var b1 = document.getElementById("btnFix_" + sk);
  var b2 = document.getElementById("btnRecheck_" + sk);
  if (b1) b1.disabled = disabled;
  if (b2) b2.disabled = disabled;
}

async function fixNowUI(siteKey, recheck) {
  var panel = sitePanel(siteKey);
  var label = recheck ? "Fix + Recheck" : "Fix Now";
  if (panel) {
    panel.style.display = "block";
    panel.textContent = recheck ? "Running safe fixes, then rechecking..." : "Running safe fixes...";
  }
  setSiteButtons(siteKey, true);
  toast("warn", "WebOps", label + " started for " + siteKey, recheck ? "Will recheck after fixes" : "");

  var url = "/admin/webops/fix_now?site_key=" + encodeURIComponent(siteKey) +
    "&recheck=" + (recheck ? "true" : "false") + "&delay_seconds=12";
  var resp;
  try {
    var res = await fetch(url, { method: "POST", headers: {"X-Admin-Token": getToken()} });
    resp = await res.json();
  } catch (e) {
    if (panel) panel.textContent = "Network error.";
    toast("bad", "WebOps", "Fix failed for " + siteKey, e.message);
    setSiteButtons(siteKey, false);
    return;
  }

  // Show safe fix results in panel
  var before = resp.before ? resp.before.status.toUpperCase() : "?";
  var line = "Before: " + before + ". Safe fixes done.";
  if (resp.repair_plan_created) line += " Plan #" + resp.repair_plan_id + " created.";

  // Handle recheck results
  if (recheck && resp.recheck) {
    var rc = resp.recheck;
    if (rc.attempted && rc.ok && rc.transition) {
      line += " " + rc.transition + ".";
      var after = rc.after ? rc.after.status : "unknown";
      var kind = after === "green" ? "ok" : after === "yellow" ? "warn" : "bad";
      toast(kind, "WebOps", siteKey + ": " + rc.transition,
        rc.after && rc.after.failures ? rc.after.failures.length + " failure(s) remaining" : "");
    } else if (rc.attempted && !rc.ok) {
      line += " Recheck failed: " + (rc.error || "unknown");
      toast("bad", "WebOps", "Recheck failed for " + siteKey, rc.error || "");
    }
  } else if (!recheck) {
    var fixKind = resp.ok ? "ok" : "bad";
    toast(fixKind, "WebOps", label + " complete for " + siteKey,
      resp.repair_plan_created ? "Plan #" + resp.repair_plan_id + " needs approval" : "");
  }

  if (panel) panel.textContent = line;
  setSiteButtons(siteKey, false);
  await refreshWebOpsStatus();
}

async function refreshWebOpsStatus() {
  try {
    var res = await fetch("/admin/webops/status", {
      headers: {"X-Admin-Token": getToken()}
    });
    if (!res.ok) return;
    var d = await res.json();
    updateHealthChip(d.overall || "unknown");
    // overall badge
    var ov = document.getElementById("webopsOverall");
    var isGreen = d.overall === "green";
    var cls = isGreen ? "tl-green" : "tl-red";
    var lastRun = d.latest ? d.latest.finished_at_utc : null;
    ov.innerHTML = '<span class="tl-overall ' + cls + '">' +
      (isGreen ? "ALL GREEN" : "ISSUES DETECTED") + '</span>' +
      (lastRun ? ' <span style="font-size:12px;color:#999;">Last run: ' + lastRun + '</span>' : '');
    // site cards
    var grid = document.getElementById("webopsGrid");
    var sites = d.sites || [];
    if (!sites.length) { grid.innerHTML = '<p style="color:#999;font-size:13px;">No site data yet.</p>'; }
    else {
      grid.innerHTML = sites.map(function(s) {
        var c = s.status === "green" ? "tl-green" : s.status === "yellow" ? "tl-yellow" : s.status === "red" ? "tl-red" : "tl-grey";
        var sk = s.site_key.replace(/[^a-zA-Z0-9_-]/g, "_");
        var meta = [];
        if (s.failures && s.failures.length) meta.push(s.failures.length + " failure(s)");
        if (s.warnings && s.warnings.length) meta.push(s.warnings.length + " warning(s)");
        if (!meta.length) meta.push("All checks passed");
        var actions = "";
        if (s.can_fix_now) {
          actions = '<div class="tl-actions">' +
            '<button id="btnFix_' + sk + '" onclick="fixNowUI(\'' + s.site_key + '\', false)">Fix Now</button>' +
            '<button id="btnRecheck_' + sk + '" onclick="fixNowUI(\'' + s.site_key + '\', true)">Fix + Recheck</button>' +
            '</div>';
          if (s.pending_repair_plan_id) {
            actions += '<div class="tl-plan">Pending plan #' + s.pending_repair_plan_id + '</div>';
          }
        }
        var panel = '<div id="panel_' + sk + '" class="tl-panel" style="display:none;"></div>';
        return '<div class="tl-card ' + c + '"><h4>' + s.site_key + '</h4><div class="tl-meta">' + meta.join(" · ") + '</div>' + actions + panel + '</div>';
      }).join("");
    }
    // open incidents
    var inc = d.open_incidents || [];
    var incDiv = document.getElementById("webopsIncidents");
    if (inc.length) {
      incDiv.innerHTML = '<strong>Open Incidents (' + inc.length + ')</strong><ul>' +
        inc.map(function(i) {
          var sev = i.severity === "red" ? "🔴" : "🟡";
          return '<li>' + sev + ' <b>' + i.site_key + '</b>: ' + i.title + ' (x' + i.occurrences + ')</li>';
        }).join("") + '</ul>';
    } else {
      incDiv.innerHTML = '';
    }
  } catch (e) { /* silent retry next cycle */ }
}
refreshWebOpsStatus();
setInterval(refreshWebOpsStatus, 15000);

async function fixViewsRegistry(safeMode) {
  var out = document.getElementById("fix-out");
  var st = document.getElementById("fix-status");
  st.textContent = safeMode ? "Running simulation..." : "Running apply-mode...";
  out.textContent = "";
  try {
    var res = await fetch("/admin/notion/views_registry/fix_all", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Token": getToken()
      },
      body: JSON.stringify({safe_mode: safeMode})
    });
    var json = await res.json();
    out.textContent = JSON.stringify(json, null, 2);
    if (!res.ok) {
      st.textContent = "Blocked: " + (json.error || res.status);
    } else {
      st.textContent = json.ok ? "Done." : "Completed with issues.";
    }
  } catch (e) {
    st.textContent = "Error: " + e.message;
  }
}
</script>
</body>
</html>
"""


@router.get("/quick-actions", response_class=HTMLResponse)
def quick_actions_ui() -> HTMLResponse:
    return HTMLResponse(_HTML)

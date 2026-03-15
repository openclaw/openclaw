#!/usr/bin/env python3
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from html import escape
from urllib.parse import urlparse, parse_qs, urlencode
from subprocess import run, PIPE
import os
import re
import hashlib
import shutil
from datetime import datetime, timezone

BASE = Path("/home/sergio/.openclaw/workspace")
FILES = {
    "overview": BASE / "dashboard" / "OVERVIEW.md",
    "pending": BASE / "dashboard" / "PENDING_ACTIONS.md",
    "audits": BASE / "dashboard" / "LAST_AUDITS.md",
    "context": BASE / "context" / "CONTEXT_UPDATES_QUEUE.md",
    "skills": BASE / "context" / "SKILL_UPDATES_QUEUE.md",
    "policy": BASE / "context" / "CONTEXT_POLICY.md",
}

APPROVER = "/home/sergio/.openclaw/workspace/context/bin/approve_item.sh"
PORT = 8788
HOST = "127.0.0.1"

ROLLBACK_CANONICAL = "/home/sergio/.openclaw/workspace/dashboard-web/stable/server.py.current-ok"
ROLLBACK_DIR = "/home/sergio/.openclaw/workspace/dashboard-web/stable"
ROLLBACK_SERVICE = "context-dashboard-web.service"


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except FileNotFoundError:
        return f"Archivo no encontrado:\n{path}\n"


def file_sha256(path: str) -> str:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except FileNotFoundError:
        return "missing"
    except Exception as e:
        return f"error:{e}"


def is_local_request(handler) -> bool:
    ip = (handler.client_address[0] or "").strip()
    return ip in {"127.0.0.1", "::1"}


def perform_server_py_rollback():
    rollback_dir = Path(ROLLBACK_DIR)
    canonical = Path(ROLLBACK_CANONICAL)
    live_file = Path(__file__).resolve()

    if not canonical.exists():
        return False, f"canonical no existe: {canonical}"

    rollback_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    live_backup = rollback_dir / f"server.py.live-before-rollback-{ts}"
    runner = rollback_dir / "rollback-server-py-async.sh"

    script = f"""#!/usr/bin/env bash
set -euo pipefail

LIVE_FILE={str(live_file)!r}
CANONICAL_FILE={str(canonical)!r}
LIVE_BACKUP={str(live_backup)!r}
SERVICE_NAME={ROLLBACK_SERVICE!r}

export HOME=/home/sergio
export XDG_RUNTIME_DIR=/run/user/{os.getuid()}

sleep 2
cp -a "$LIVE_FILE" "$LIVE_BACKUP"
cp -a "$CANONICAL_FILE" "$LIVE_FILE"
chmod 0755 "$LIVE_FILE"
systemctl --user restart "$SERVICE_NAME" >/dev/null 2>&1 || true
"""

    runner.write_text(script, encoding="utf-8")
    os.chmod(runner, 0o755)

    env = os.environ.copy()
    env["HOME"] = "/home/sergio"
    env["XDG_RUNTIME_DIR"] = f"/run/user/{os.getuid()}"

    result = run(
        ["bash", "-lc", f"nohup {runner} >/dev/null 2>&1 &"],
        stdout=PIPE,
        stderr=PIPE,
        text=True,
        env=env,
        start_new_session=True,
    )

    out = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    if result.returncode != 0:
        return False, f"no se pudo lanzar rollback async | backup={live_backup} | {out.strip()}"

    return True, f"rollback programado | backup={live_backup}"


def parse_counts(md: str):
    counts = {"pending": 0, "approved": 0, "rejected": 0, "applied": 0}
    for line in md.splitlines():
        m = re.match(r"^\s*-\s*estado:\s*(pending|approved|rejected|applied)\s*$", line.strip(), re.I)
        if m:
            counts[m.group(1).lower()] += 1
    return counts


def parse_items(md: str, filename: str):
    lines = md.splitlines()
    items = []
    current = None

    allowed_keys = {"fecha", "tipo", "estado", "resumen", "nota", "origen"}

    def normalize_title(value: str) -> str:
        return re.sub(r"\s+", " ", value.strip())

    def is_valid_item(obj: dict) -> bool:
        if not obj:
            return False

        origen = (obj.get("origen") or "").strip()
        estado = (obj.get("estado") or "").strip().lower()
        tipo = (obj.get("tipo") or "").strip()
        resumen = (obj.get("resumen") or "").strip()
        nota = (obj.get("nota") or "").strip()

        if not origen:
            return False

        if estado not in {"pending", "approved", "rejected", "applied"}:
            return False

        if not (tipo or resumen or nota):
            return False

        return True

    def flush():
        nonlocal current
        if is_valid_item(current):
            items.append(current)
        current = None

    for raw in lines:
        line = raw.rstrip("\n")

        m_head = re.match(r"^\s*##\s+(.+?)\s*$", line)
        if m_head:
            flush()
            title = normalize_title(m_head.group(1))
            current = {
                "origen": title,
                "fecha": "",
                "tipo": "",
                "estado": "",
                "resumen": "",
                "nota": "",
                "archivo": filename,
            }
            continue

        if current is None:
            continue

        m_field = re.match(r"^\s*-\s*([A-Za-z_áéíóúÁÉÍÓÚ]+):\s*(.*)\s*$", line)
        if not m_field:
            continue

        key = m_field.group(1).strip().lower()
        value = m_field.group(2).strip()

        if key not in allowed_keys:
            continue

        if key == "estado":
            value = value.lower()

        current[key] = value

    flush()
    return items


def build_qs(mode: str) -> str:
    return urlencode({"mode": mode})


def resolve_paths(raw_path: str):
    raw_path = raw_path.rstrip("/") or "/"
    base_path = ""
    internal_path = raw_path

    if raw_path == "/dashboard":
        base_path = "/dashboard"
        internal_path = "/"
    elif raw_path.startswith("/dashboard/"):
        base_path = "/dashboard"
        internal_path = raw_path[len("/dashboard"):] or "/"

    return base_path, internal_path


def nav_html(base_path: str, mode: str) -> str:
    return f"""
  <div class="topbar">
    <div class="brand">OpenClaw Dashboard</div>
    <div class="top-actions top-actions-main">
      <a class="navbtn{' active' if mode == 'inbox' else ''}" href="{base_path}/?mode=inbox">nuevos</a>
      <a class="navbtn{' active' if mode == 'all' else ''}" href="{base_path}/?mode=all">todo</a>
      <a class="navbtn{' active' if mode == 'history' else ''}" href="{base_path}/?mode=history">historial</a>
      <a class="navbtn" href="{base_path}/?mode={escape(mode)}">refresh</a>
    </div>
    <div class="top-actions top-actions-secondary">
      <a class="navbtn" href="{base_path}/view?file=overview">overview</a>
      <a class="navbtn" href="{base_path}/view?file=pending">pending</a>
      <a class="navbtn" href="{base_path}/view?file=audits">audits</a>
      <a class="navbtn" href="{base_path}/view?file=context">context</a>
      <a class="navbtn" href="{base_path}/view?file=skills">skills</a>
      <a class="navbtn" href="{base_path}/view?file=policy">policy</a>
    </div>
  </div>
"""


def status_badge(status: str) -> str:
    safe = status if status in {"pending", "approved", "rejected", "applied"} else "unknown"
    return f'<span class="badge {safe}">{escape(status)}</span>'


def queue_badge(queue_kind: str) -> str:
    labels = {
        "context": "context",
        "skill": "skill",
        "pending": "pending",
    }
    safe = labels.get(queue_kind, queue_kind)
    return f'<span class="qbadge">{escape(safe)}</span>'


def apply_action(kind: str, origen: str, status: str, note: str):
    if not Path(APPROVER).exists():
        return False, f"approver no existe: {APPROVER}"
    env = os.environ.copy()
    env["HOME"] = "/home/sergio"
    result = run(
        [APPROVER, kind, origen, status, note],
        stdout=PIPE,
        stderr=PIPE,
        text=True,
        env=env,
    )
    out = (result.stdout or "") + ("\n" + result.stderr if result.stderr else "")
    return result.returncode == 0, out.strip()


def render_item_card(item: dict, base_path: str, mode: str, queue_kind: str) -> str:
    origen = item.get("origen", "").strip()
    estado = item.get("estado", "unknown").strip()
    fecha = item.get("fecha", "").strip()
    tipo = item.get("tipo", "").strip()
    archivo = item.get("archivo", "").strip()
    resumen = item.get("resumen", "").strip()
    nota = item.get("nota", "").strip()
    redirect = f"{base_path}/?{build_qs(mode)}"

    return f"""
    <div class="item-card">
      <div class="item-head">
        <div class="item-title">{escape(origen)}</div>
        <div class="item-badges">{queue_badge(queue_kind)} {status_badge(estado)}</div>
      </div>

      <div class="meta"><span>fecha</span><span>{escape(fecha)}</span></div>
      <div class="meta"><span>tipo</span><span>{escape(tipo)}</span></div>
      <div class="meta"><span>archivo</span><span>{escape(archivo)}</span></div>

      <div class="section-label">resumen</div>
      <div class="box">{escape(resumen)}</div>

      <div class="section-label">nota</div>
      <div class="box">{escape(nota)}</div>

      <div class="actions">
        <form method="post" action="{base_path}/action" class="action-form">
          <input type="hidden" name="kind" value="{escape(queue_kind)}">
          <input type="hidden" name="origen" value="{escape(origen)}">
          <input type="hidden" name="status" value="approved">
          <input type="hidden" name="redirect" value="{escape(redirect)}">
          <button type="submit" class="btn approved">approve</button>
        </form>

        <form method="post" action="{base_path}/action" class="action-form">
          <input type="hidden" name="kind" value="{escape(queue_kind)}">
          <input type="hidden" name="origen" value="{escape(origen)}">
          <input type="hidden" name="status" value="rejected">
          <input type="hidden" name="redirect" value="{escape(redirect)}">
          <button type="submit" class="btn rejected">reject</button>
        </form>

        <form method="post" action="{base_path}/action" class="action-form">
          <input type="hidden" name="kind" value="{escape(queue_kind)}">
          <input type="hidden" name="origen" value="{escape(origen)}">
          <input type="hidden" name="status" value="applied">
          <input type="hidden" name="redirect" value="{escape(redirect)}">
          <button type="submit" class="btn applied">apply</button>
        </form>
      </div>
    </div>
"""


def filter_items(items, mode: str):
    if mode == "inbox":
        return [x for x in items if x.get("estado") == "pending"]
    if mode == "history":
        return [x for x in items if x.get("estado") != "pending"]
    return items


def queue_section(title: str, items: list, base_path: str, mode: str, queue_kind: str) -> str:
    filtered = filter_items(items, mode)
    if not filtered:
        return f"""
    <section class="queue-section">
      <h2>{escape(title)}</h2>
      <div class="empty">No hay items para mostrar.</div>
    </section>
"""
    cards = "\n".join(render_item_card(item, base_path, mode, queue_kind) for item in filtered)
    return f"""
    <section class="queue-section">
      <h2>{escape(title)}</h2>
      <div class="items-grid">
        {cards}
      </div>
    </section>
"""


def summary_cards_html(p_counts, c_counts, s_counts):
    cards = [
        ("Pending actions", p_counts),
        ("Context queue", c_counts),
        ("Skill queue", s_counts),
    ]
    parts = []
    for title, counts in cards:
        parts.append(f"""
        <div class="card">
          <h3>{escape(title)}</h3>
          <div class="row"><span>pending</span><span>{counts['pending']}</span></div>
          <div class="row"><span>approved</span><span>{counts['approved']}</span></div>
          <div class="row"><span>rejected</span><span>{counts['rejected']}</span></div>
          <div class="row"><span>applied</span><span>{counts['applied']}</span></div>
        </div>
""")
    return f'<div class="grid">{"".join(parts)}</div>'


def summary_table_html(p_counts, c_counts, s_counts):
    return f"""
  <div class="tablewrap">
    <table class="summary-table">
      <thead>
        <tr>
          <th>cola</th>
          <th>pending</th>
          <th>approved</th>
          <th>rejected</th>
          <th>applied</th>
        </tr>
      </thead>
      <tbody>
        <tr><td>pending_actions</td><td>{p_counts['pending']}</td><td>{p_counts['approved']}</td><td>{p_counts['rejected']}</td><td>{p_counts['applied']}</td></tr>
        <tr><td>context_queue</td><td>{c_counts['pending']}</td><td>{c_counts['approved']}</td><td>{c_counts['rejected']}</td><td>{c_counts['applied']}</td></tr>
        <tr><td>skill_queue</td><td>{s_counts['pending']}</td><td>{s_counts['approved']}</td><td>{s_counts['rejected']}</td><td>{s_counts['applied']}</td></tr>
      </tbody>
    </table>
  </div>
"""


def empty_state_html(base_path: str):
    return f"""
  <div class="empty-state">
    <div class="empty-title">No hay pendientes nuevos</div>
    <div class="empty-sub">
      Todo lo detectado ya está revisado o aplicado. Podés cambiar de vista para seguir trabajando.
    </div>
    <div class="empty-links">
      <a class="navbtn" href="{base_path}/?mode=all">ver todo</a>
      <a class="navbtn" href="{base_path}/?mode=history">ver historial</a>
      <a class="navbtn" href="{base_path}/view?file=overview">abrir overview</a>
      <a class="navbtn" href="{base_path}/view?file=audits">abrir audits</a>
    </div>
  </div>
"""


def recovery_panel_html(base_path: str) -> str:
    live_file = str(Path(__file__).resolve())
    live_sha = file_sha256(live_file)
    canonical_sha = file_sha256(ROLLBACK_CANONICAL)

    return f"""
  <section class="queue-section">
    <h2>Recovery / Rollback</h2>
    <div class="recovery-card">
      <div class="meta"><span>live file</span><span>{escape(live_file)}</span></div>
      <div class="meta"><span>current-ok</span><span>{escape(ROLLBACK_CANONICAL)}</span></div>
      <div class="meta"><span>service</span><span>{escape(ROLLBACK_SERVICE)}</span></div>
      <div class="meta"><span>sha live</span><span>{escape(live_sha)}</span></div>
      <div class="meta"><span>sha current-ok</span><span>{escape(canonical_sha)}</span></div>

      <div class="section-label">acción</div>
      <div class="box">Restaura server.py desde la copia canónica actual conocida como buena y reinicia el servicio. Solo permitido desde localhost.</div>

      <div class="actions">
        <form method="post" action="{base_path}/rollback" class="action-form" onsubmit="return confirm('¿Seguro que querés restaurar server.py desde current-ok y reiniciar el servicio?');">
          <input type="hidden" name="redirect" value="{escape(base_path)}/?mode=all">
          <button type="submit" class="btn rejected">Rollback server.py</button>
        </form>
      </div>
    </div>
  </section>
"""


def consolidated_rows(context_items, skill_items, pending_items, mode: str):
    rows = {}

    def add(queue_kind: str, item: dict):
        origen = (item.get("origen") or "").strip()
        if not origen:
            return

        estado = (item.get("estado") or "").strip().lower()
        if mode == "inbox" and estado != "pending":
            return
        if mode == "history" and estado == "pending":
            return

        if origen not in rows:
            rows[origen] = {
                "origen": origen,
                "fecha": "",
                "queues": [],
                "states": [],
                "resumen": "",
                "details": [],
            }

        row = rows[origen]
        fecha = (item.get("fecha") or "").strip()
        resumen = (item.get("resumen") or "").strip()
        tipo = (item.get("tipo") or "").strip()
        nota = (item.get("nota") or "").strip()
        archivo = (item.get("archivo") or "").strip()

        if fecha and (not row["fecha"] or fecha > row["fecha"]):
            row["fecha"] = fecha
        if resumen and not row["resumen"]:
            row["resumen"] = resumen
        if queue_kind not in row["queues"]:
            row["queues"].append(queue_kind)

        token = f"{queue_kind}:{estado}"
        if token not in row["states"]:
            row["states"].append(token)

        row["details"].append({
            "queue_kind": queue_kind,
            "estado": estado,
            "fecha": fecha,
            "tipo": tipo,
            "archivo": archivo,
            "resumen": resumen,
            "nota": nota,
        })

    for item in context_items:
        add("context", item)
    for item in skill_items:
        add("skill", item)
    for item in pending_items:
        add("pending", item)

    ordered = sorted(
        rows.values(),
        key=lambda x: ((x["fecha"] or ""), x["origen"].lower()),
        reverse=True,
    )
    return ordered


def consolidated_table_html(context_items, skill_items, pending_items, mode: str):
    rows = consolidated_rows(context_items, skill_items, pending_items, mode)
    if not rows:
        return ""

    body_parts = []
    for row in rows:
        queues_html = " ".join(queue_badge(q) for q in row["queues"])
        states_html = " ".join(status_badge(s.split(":", 1)[1]) for s in row["states"])

        detail_blocks = []
        for detail in row.get("details", []):
            detail_blocks.append(f"""
            <div class="detail-block">
              <div class="detail-top">
                <div>{queue_badge(detail['queue_kind'])} {status_badge(detail['estado'])}</div>
              </div>
              <div class="meta"><span>fecha</span><span>{escape(detail['fecha'])}</span></div>
              <div class="meta"><span>tipo</span><span>{escape(detail['tipo'])}</span></div>
              <div class="meta"><span>archivo</span><span>{escape(detail['archivo'])}</span></div>
              <div class="section-label">resumen</div>
              <div class="box">{escape(detail['resumen'])}</div>
              <div class="section-label">nota</div>
              <div class="box">{escape(detail['nota'])}</div>
            </div>
""")

        detail_html = "".join(detail_blocks)

        body_parts.append(f"""
        <tr>
          <td>{escape(row['origen'])}</td>
          <td>{escape(row['fecha'])}</td>
          <td>{queues_html}</td>
          <td>{states_html}</td>
          <td>{escape(row['resumen'])}</td>
          <td>
            <details class="inline-details">
              <summary>ver detalle</summary>
              <div class="inline-details-body">
                {detail_html}
              </div>
            </details>
          </td>
        </tr>
""")

    title = "Consolidado" if mode == "all" else "Historial consolidado"
    return f"""
  <section class="queue-section">
    <h2>{escape(title)}</h2>
    <div class="tablewrap">
      <table class="summary-table consolidated-table">
        <thead>
          <tr>
            <th>origen</th>
            <th>fecha</th>
            <th>colas</th>
            <th>estados</th>
            <th>resumen</th>
            <th>detalle</th>
          </tr>
        </thead>
        <tbody>
          {''.join(body_parts)}
        </tbody>
      </table>
    </div>
  </section>
"""


def render_home(base_path: str, flash: str = "", mode: str = "inbox") -> str:
    overview = read_text(FILES["overview"])
    pending_md = read_text(FILES["pending"])
    context_md = read_text(FILES["context"])
    skills_md = read_text(FILES["skills"])

    p_counts = parse_counts(pending_md)
    c_counts = parse_counts(context_md)
    s_counts = parse_counts(skills_md)

    pending_items = parse_items(pending_md, "PENDING_ACTIONS.md")
    context_items = parse_items(context_md, "CONTEXT_UPDATES_QUEUE.md")
    skill_items = parse_items(skills_md, "SKILL_UPDATES_QUEUE.md")

    flash_html = f'<div class="flash">{escape(flash)}</div>' if flash else ""

    consolidated_html = ""
    cards_html = ""
    summary_table = ""
    empty_state = ""
    recovery_html = recovery_panel_html(base_path)

    if mode == "inbox":
        view_text = "vista: solo pendientes"
        has_any = any(filter_items(x, mode) for x in [pending_items, context_items, skill_items])
        empty_state = "" if has_any else empty_state_html(base_path)
    elif mode == "history":
        view_text = "vista: solo historial"
        cards_html = summary_cards_html(p_counts, c_counts, s_counts)
        summary_table = summary_table_html(p_counts, c_counts, s_counts)
        consolidated_html = consolidated_table_html(context_items, skill_items, pending_items, mode)
    else:
        view_text = "vista: todos los items"
        cards_html = summary_cards_html(p_counts, c_counts, s_counts)
        summary_table = summary_table_html(p_counts, c_counts, s_counts)
        consolidated_html = consolidated_table_html(context_items, skill_items, pending_items, mode)

    if mode == "inbox":
        sections_html = "".join([
            queue_section("Context queue", context_items, base_path, mode, "context"),
            queue_section("Skill queue", skill_items, base_path, mode, "skill"),
            queue_section("Pending actions", pending_items, base_path, mode, "pending"),
        ])
    else:
        sections_html = ""

    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>OpenClaw Dashboard</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <style>
    body {{ font-family: Arial, sans-serif; margin:0; padding:16px; background:#0f1115; color:#e8e8e8; }}
    a {{ color:#8ec5ff; text-decoration:none; }}
    a:hover {{ text-decoration:underline; }}
    .topbar {{ position:sticky; top:0; z-index:20; background:rgba(15,17,21,.96); backdrop-filter:blur(6px); padding-bottom:10px; }}
    .brand {{ font-size:24px; margin-bottom:8px; }}
    .top-actions {{ display:flex; gap:8px; flex-wrap:wrap; }}
    .top-actions-main {{ margin-bottom:8px; }}
    .top-actions-secondary {{ opacity:.92; }}
    .navbtn {{ background:#1a1f29; padding:10px 12px; border-radius:10px; border:1px solid #2b3240; font-size:14px; color:#8ec5ff; display:inline-block; }}
    .navbtn.active {{ background:#21456f; border-color:#356da8; }}
    .grid {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px; margin:18px 0; }}
    .card {{ background:#151922; padding:14px; border-radius:12px; border:1px solid #2b3240; }}
    .row {{ display:flex; justify-content:space-between; padding:4px 0; }}
    pre {{ white-space:pre-wrap; word-wrap:break-word; background:#151922; padding:16px; border-radius:12px; border:1px solid #2b3240; overflow-x:auto; }}
    h1, h2, h3 {{ margin-top:0; }}
    .muted {{ color:#a7b0c0; margin:6px 0 14px 0; }}
    .flash {{ background:#16324f; border:1px solid #2c5d8a; color:#d8ecff; padding:12px 14px; border-radius:10px; margin:14px 0 18px 0; }}
    .queue-section {{ margin-top:26px; }}
    .items-grid {{ display:grid; grid-template-columns:repeat(auto-fit, minmax(300px, 1fr)); gap:14px; }}
    .item-card {{ background:#151922; padding:14px; border-radius:12px; border:1px solid #2b3240; }}
    .item-head {{ display:flex; justify-content:space-between; gap:12px; align-items:flex-start; margin-bottom:12px; }}
    .item-title {{ font-size:15px; line-height:1.35; word-break:break-word; }}
    .item-badges {{ display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }}
    .meta {{ display:flex; justify-content:space-between; gap:10px; padding:4px 0; color:#c9d1dc; }}
    .meta span:first-child {{ color:#8fa0b6; min-width:72px; }}
    .meta span:last-child {{ text-align:right; word-break:break-word; }}
    .section-label {{ margin-top:12px; margin-bottom:6px; color:#8fa0b6; }}
    .box {{ background:#0f131a; border:1px solid #252c38; border-radius:10px; padding:10px 12px; white-space:pre-wrap; word-wrap:break-word; }}
    .actions {{ display:flex; gap:8px; flex-wrap:wrap; margin-top:14px; }}
    .action-form {{ margin:0; }}
    .btn {{ border:0; border-radius:10px; padding:10px 12px; cursor:pointer; color:#fff; font-size:14px; }}
    .btn.approved {{ background:#1f7a4d; }}
    .btn.rejected {{ background:#a33a3a; }}
    .btn.applied {{ background:#2563eb; }}
    .badge {{ display:inline-block; padding:6px 10px; border-radius:999px; font-size:12px; white-space:nowrap; }}
    .badge.pending {{ background:#5b4a13; color:#ffe08a; }}
    .badge.approved {{ background:#173f2d; color:#9ef0c6; }}
    .badge.rejected {{ background:#4a1d1d; color:#ffb3b3; }}
    .badge.applied {{ background:#17335f; color:#b7d2ff; }}
    .badge.unknown {{ background:#2f3540; color:#d8dde7; }}
    .qbadge {{ display:inline-block; padding:6px 10px; border-radius:999px; font-size:12px; white-space:nowrap; background:#1f2937; color:#d1d5db; border:1px solid #374151; }}
    .empty {{ background:#151922; padding:16px; border-radius:12px; border:1px solid #2b3240; color:#a7b0c0; }}
    details.overview-box {{ margin-top:32px; }}
    details.overview-box summary {{ cursor:pointer; background:#151922; border:1px solid #2b3240; border-radius:12px; padding:14px; }}
    .summary-note {{ margin-top:8px; color:#a7b0c0; font-size:13px; }}
    .tablewrap {{ overflow-x:auto; margin:14px 0 6px 0; }}
    .summary-table {{ width:100%; border-collapse:collapse; background:#151922; border:1px solid #2b3240; border-radius:12px; overflow:hidden; }}
    .summary-table th, .summary-table td {{ padding:10px 12px; border-bottom:1px solid #2b3240; text-align:left; vertical-align:top; }}
    .summary-table th {{ color:#8fa0b6; font-weight:600; }}
    .summary-table tr:last-child td {{ border-bottom:0; }}
    .consolidated-table td:nth-child(5) {{ min-width:260px; }}
    .consolidated-table td:nth-child(6) {{ min-width:160px; }}
    details.inline-details {{ min-width:140px; }}
    details.inline-details summary {{ cursor:pointer; color:#8ec5ff; }}
    .inline-details-body {{ margin-top:10px; min-width:320px; }}
    .detail-block {{ background:#11161f; border:1px solid #2b3240; border-radius:10px; padding:10px; margin-bottom:10px; }}
    .detail-block:last-child {{ margin-bottom:0; }}
    .detail-top {{ display:flex; justify-content:space-between; gap:8px; margin-bottom:8px; }}
    .empty-state {{ background:#151922; border:1px solid #2b3240; border-radius:12px; padding:18px; margin-top:18px; }}
    .recovery-card {{ background:#151922; border:1px solid #2b3240; border-radius:12px; padding:18px; }}
    .empty-title {{ font-size:18px; margin-bottom:8px; }}
    .empty-sub {{ color:#a7b0c0; margin-bottom:14px; }}
    .empty-links {{ display:flex; gap:8px; flex-wrap:wrap; }}

    @media (max-width: 700px) {{
      body {{ padding:12px; }}
      .brand {{ font-size:20px; }}
      .top-actions {{ gap:6px; }}
      .top-actions-secondary {{ display:none; }}
      .navbtn {{ font-size:13px; padding:9px 10px; }}
      .items-grid {{ grid-template-columns:1fr; }}
      .grid {{ grid-template-columns:1fr; }}
      .meta {{ flex-direction:column; gap:2px; }}
      .meta span:last-child {{ text-align:left; }}
      .btn {{ width:100%; }}
      .action-form {{ flex:1 1 100%; width:100%; }}
      .actions {{ flex-direction:column; }}
      .summary-table th, .summary-table td {{ padding:9px 10px; font-size:13px; }}
      .item-head {{ flex-direction:column; }}
      .item-badges {{ justify-content:flex-start; }}
      .inline-details-body {{ min-width:0; }}
    }}
  </style>
</head>
<body>
  {nav_html(base_path, mode)}
  <div class="muted">refresh automático cada 30s · {escape(view_text)}</div>
  {flash_html}
  {cards_html}
  {summary_table}
  {recovery_html}
  {consolidated_html}
  {empty_state}
  {sections_html}
  <details class="overview-box">
    <summary>overview.md</summary>
    <div class="summary-note">Se deja plegado para que la pantalla principal sea más cómoda.</div>
    <pre>{escape(overview)}</pre>
  </details>
</body>
</html>"""


def render_file(key: str, base_path: str) -> str:
    path = FILES.get(key)
    if not path:
        return """<!doctype html><html><head><meta charset="utf-8"><title>Archivo inválido</title></head><body><h1>Archivo inválido</h1></body></html>"""
    content = read_text(path)
    return f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{escape(key)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <style>
    body {{ font-family: Arial, sans-serif; margin:0; padding:16px; background:#0f1115; color:#e8e8e8; }}
    a {{ color:#8ec5ff; text-decoration:none; }}
    .topbar {{ position:sticky; top:0; z-index:20; background:rgba(15,17,21,.96); padding-bottom:12px; }}
    .brand {{ font-size:24px; margin-bottom:10px; }}
    .top-actions {{ display:flex; gap:8px; flex-wrap:wrap; }}
    .navbtn {{ background:#1a1f29; padding:10px 12px; border-radius:10px; border:1px solid #2b3240; font-size:14px; color:#8ec5ff; display:inline-block; }}
    pre {{ white-space:pre-wrap; word-wrap:break-word; background:#151922; padding:16px; border-radius:12px; border:1px solid #2b3240; overflow-x:auto; }}
    .muted {{ color:#a7b0c0; margin:10px 0 16px 0; }}
    @media (max-width: 700px) {{
      body {{ padding:12px; }}
      .brand {{ font-size:20px; }}
      .navbtn {{ font-size:13px; padding:9px 10px; }}
    }}
  </style>
</head>
<body>
  {nav_html(base_path, "all")}
  <h1>{escape(key)}</h1>
  <div class="muted">{escape(str(path))}</div>
  <pre>{escape(content)}</pre>
</body>
</html>"""


class Handler(BaseHTTPRequestHandler):
    def do_HEAD(self):
        parsed = urlparse(self.path)
        _, internal_path = resolve_paths(parsed.path)
        if internal_path in ("/", "/view"):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            return
        self.send_response(404)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        base_path, internal_path = resolve_paths(parsed.path)
        qs = parse_qs(parsed.query)

        if internal_path == "/":
            flash = qs.get("flash", [""])[0]
            mode = qs.get("mode", ["inbox"])[0]
            if mode not in {"inbox", "all", "history"}:
                mode = "inbox"
            body = render_home(base_path, flash=flash, mode=mode).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if internal_path == "/view":
            key = qs.get("file", [""])[0]
            body = render_file(key, base_path).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        self.send_response(404)
        self.end_headers()
        self.wfile.write(b"Not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        base_path, internal_path = resolve_paths(parsed.path)

        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length).decode("utf-8", errors="ignore")
        form = parse_qs(raw)
        redirect = form.get("redirect", [f"{base_path}/?{build_qs('inbox')}"])[0].strip() or f"{base_path}/?{build_qs('inbox')}"

        if internal_path == "/action":
            kind = form.get("kind", [""])[0].strip()
            origen = form.get("origen", [""])[0].strip()
            status = form.get("status", [""])[0].strip()

            if kind not in {"context", "skill", "pending"} or not origen or status not in {"approved", "rejected", "applied"}:
                msg = "acción inválida"
            else:
                ok, out = apply_action(kind, origen, status, "actualizado desde dashboard")
                msg = f"{kind}:{origen} -> {status}" if ok else f"error al actualizar {kind}:{origen} | {out}"

        elif internal_path == "/rollback":
            if not is_local_request(self):
                msg = "rollback denegado: solo localhost"
            else:
                ok, out = perform_server_py_rollback()
                msg = out if ok else f"rollback error | {out}"

        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return

        sep = "&" if "?" in redirect else "?"
        location = f"{redirect}{sep}{urlencode({'flash': msg})}"
        self.send_response(303)
        self.send_header("Location", location)
        self.end_headers()

    def log_message(self, fmt, *args):
        return


if __name__ == "__main__":
    httpd = HTTPServer((HOST, PORT), Handler)
    print(f"dashboard web listening on http://{HOST}:{PORT}")
    httpd.serve_forever()

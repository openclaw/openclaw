/// Single-page Control UI HTML (WebChat + Sessions + Telegram Pairing Approval). Served at `/`.
pub const DASHBOARD_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Control UI</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#09090d;color:#e4e4e7;min-height:100vh;display:flex;flex-direction:column}
.header{background:#111119;border-bottom:1px solid #27273a;padding:.9rem 1.5rem;display:flex;align-items:center;gap:1rem}
.header h1{font-size:1.25rem;font-weight:700;background:linear-gradient(90deg,#ff4d6d,#ff8fa3);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.badge{font-size:.72rem;background:#ff4d6d22;color:#ff758f;padding:.2rem .6rem;border-radius:999px;border:1px solid #ff4d6d44}
.tabs{display:flex;gap:.5rem;margin-left:1.5rem}
.tab{background:transparent;border:1px solid transparent;color:#a1a1aa;padding:.4rem .85rem;border-radius:8px;cursor:pointer;font-size:.85rem;font-weight:500}
.tab.active,.tab:hover{background:#1c1c28;color:#fff;border-color:#2e2e42}
.status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;margin-right:.4rem}
.container{max-width:1240px;width:100%;margin:0 auto;padding:1.5rem;flex:1;display:flex;flex-direction:column;gap:1.5rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem}
.card{background:#12121c;border:1px solid #262638;border-radius:10px;padding:1.2rem}
.card h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#71717a;margin-bottom:.5rem}
.card .value{font-size:1.75rem;font-weight:700;color:#fafafa}
.card .sub{font-size:.78rem;color:#636370;margin-top:.2rem}
table{width:100%;border-collapse:collapse;background:#12121c;border-radius:10px;overflow:hidden;border:1px solid #262638}
th{text-align:left;padding:.75rem 1rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:#71717a;background:#0d0d14;border-bottom:1px solid #262638}
td{padding:.75rem 1rem;font-size:.85rem;border-bottom:1px solid #1b1b29;color:#d4d4d8}
tr:last-child td{border-bottom:none}
.btn{background:#e94560;color:#fff;border:none;padding:.45rem .9rem;border-radius:6px;cursor:pointer;font-size:.8rem;font-weight:600}
.btn:hover{background:#ff5c77}
.btn-secondary{background:#232334;color:#d4d4d8}
.btn-secondary:hover{background:#2f2f46}
.chat-box{display:flex;flex-direction:column;height:520px;background:#12121c;border:1px solid #262638;border-radius:10px;overflow:hidden}
.chat-header{padding:.75rem 1rem;background:#0d0d14;border-bottom:1px solid #262638;display:flex;justify-content:space-between;align-items:center}
.chat-messages{flex:1;overflow-y:auto;padding:1rem;display:flex;flex-direction:column;gap:.75rem}
.msg{max-width:78%;padding:.7rem 1rem;border-radius:10px;font-size:.88rem;line-height:1.45;white-space:pre-wrap}
.msg.user{align-self:flex-end;background:#e94560;color:#fff;border-bottom-right-radius:2px}
.msg.assistant{align-self:flex-start;background:#1e1e2e;color:#e4e4e7;border:1px solid #2c2c40;border-bottom-left-radius:2px}
.chat-input{display:flex;gap:.5rem;padding:.75rem;background:#0d0d14;border-top:1px solid #262638}
.chat-input input{flex:1;background:#161622;border:1px solid #2c2c40;color:#fff;padding:.65rem .9rem;border-radius:8px;font-size:.88rem;outline:none}
.chat-input input:focus{border-color:#e94560}
.hidden{display:none!important}
.empty{color:#52525b;font-style:italic;padding:1.5rem;text-align:center}
code{background:#1e1e2e;padding:.15rem .4rem;border-radius:4px;font-family:monospace;color:#ff8fa3}
</style>
</head>
<body>
<div class="header">
  <h1>🦞 OpenClaw</h1>
  <span class="badge" id="version">v0.1.0</span>
  <div class="tabs">
    <button class="tab active" onclick="switchTab('overview',this)">Overview & Sessions</button>
    <button class="tab" onclick="switchTab('webchat',this)">WebChat</button>
    <button class="tab" onclick="switchTab('skills',this)">Skills (<span id="skill-count">0</span>)</button>
    <button class="tab" onclick="switchTab('channels',this)">Channels (<span id="chan-count">0</span>)</button>
    <button class="tab" onclick="switchTab('api',this)">API (<span id="api-count">0</span>)</button>
    <button class="tab" onclick="switchTab('pairings',this)">DM Pairing (<span id="pair-count">0</span>)</button>
  </div>
  <span style="margin-left:auto;font-size:.8rem;color:#a1a1aa"><span class="status-dot"></span><span id="conn-label">Gateway Ready</span></span>
</div>

<div class="container">
  <div id="tab-overview">
    <div class="grid">
      <div class="card"><h2>Gateway</h2><div class="value" id="status">ok</div><div class="sub">Control Plane</div></div>
      <div class="card"><h2>WS Clients</h2><div class="value" id="connections">0</div><div class="sub">Connected nodes/UIs</div></div>
      <div class="card"><h2>Sessions</h2><div class="value" id="sessions">0</div><div class="sub">Active conversations</div></div>
      <div class="card"><h2>Channels & Models</h2><div class="value" id="channels">-</div><div class="sub" id="providers">Providers: -</div></div>
    </div>
    <h3 style="margin:1.25rem 0 .75rem;font-size:.95rem;color:#a1a1aa">Active Sessions (Telegram, Discord, WebChat)</h3>
    <table>
      <thead><tr><th>Session ID</th><th>Kind</th><th>State</th><th>Channel</th><th>Turns</th><th>Updated</th><th>Action</th></tr></thead>
      <tbody id="session-rows"><tr><td colspan="7" class="empty">No active sessions</td></tr></tbody>
    </table>
  </div>

  <div id="tab-webchat" class="hidden">
    <div class="chat-box">
      <div class="chat-header">
        <div><strong>Session:</strong> <code id="chat-session-label">web_main</code></div>
        <div style="display:flex;gap:.5rem">
          <button class="btn btn-secondary" onclick="resetCurrentSession()">Reset Session</button>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages"></div>
      <form class="chat-input" onsubmit="sendChat(event)">
        <input type="text" id="chat-input" placeholder="Message OpenClaw agent..." autocomplete="off">
        <button type="submit" class="btn" id="send-btn">Send</button>
      </form>
    </div>
  </div>

  <div id="tab-skills" class="hidden">
    <h3 style="margin-bottom:.75rem;font-size:.95rem;color:#a1a1aa">Loaded Skills & Custodian Playbooks (<code>skills/</code> & <code>custodian-skills/</code>)</h3>
    <table>
      <thead><tr><th>Skill</th><th>Source</th><th>Description</th></tr></thead>
      <tbody id="skill-rows"><tr><td colspan="3" class="empty">Loading skills...</td></tr></tbody>
    </table>
  </div>

  <div id="tab-channels" class="hidden">
    <h3 style="margin-bottom:.75rem;font-size:.95rem;color:#a1a1aa">Channel Catalog (27 integrations)</h3>
    <table>
      <thead><tr><th>Channel</th><th>ID</th><th>Support</th></tr></thead>
      <tbody id="chan-rows"><tr><td colspan="3" class="empty">Loading channels...</td></tr></tbody>
    </table>
  </div>

  <div id="tab-api" class="hidden">
    <h3 style="margin-bottom:.75rem;font-size:.95rem;color:#a1a1aa">Gateway RPC Methods (<span id="api-count-inline">0</span>)</h3>
    <table>
      <thead><tr><th>Method</th><th>Scope</th></tr></thead>
      <tbody id="api-rows"><tr><td colspan="2" class="empty">Loading methods...</td></tr></tbody>
    </table>
  </div>

  <div id="tab-pairings" class="hidden">
    <h3 style="margin-bottom:.75rem;font-size:.95rem;color:#a1a1aa">DM Pairing Requests (<code>openclaw pairing approve &lt;channel&gt; &lt;code&gt;</code>)</h3>
    <table>
      <thead><tr><th>Code</th><th>Channel</th><th>Sender</th><th>Sender ID</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
      <tbody id="pairing-rows"><tr><td colspan="7" class="empty">No pairing requests yet</td></tr></tbody>
    </table>
  </div>
</div>

<script>
let currentSession = 'web_main';

// Credential for the Gateway boundary. Kept in sessionStorage so a reload
// reuses it without writing the secret to disk.
let gatewayToken = sessionStorage.getItem('openclaw.token') || '';

function authHeaders(extra) {
  const headers = Object.assign({}, extra || {});
  if (gatewayToken) headers['Authorization'] = 'Bearer ' + gatewayToken;
  return headers;
}

// Every Control UI request goes through here so no call forgets the credential.
async function api(path, options) {
  const opts = Object.assign({}, options || {});
  opts.headers = authHeaders(opts.headers);
  const res = await fetch(path, opts);
  if (res.status === 401) {
    const entered = prompt('Gateway token required:');
    if (entered) {
      gatewayToken = entered;
      sessionStorage.setItem('openclaw.token', entered);
      opts.headers = authHeaders(opts.headers);
      return fetch(path, opts);
    }
  }
  return res;
}

function cell(row, text) {
  const td = document.createElement('td');
  if (text !== undefined) td.textContent = String(text);
  row.appendChild(td);
  return td;
}

function switchTab(name, btn) {
  ['overview','webchat','skills','channels','api','pairings'].forEach(t => {
    document.getElementById('tab-'+t).classList.toggle('hidden', t !== name);
  });
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (name === 'webchat') loadChatHistory();
  if (name === 'skills') loadSkills();
  if (name === 'channels') loadChannels();
  if (name === 'api') loadMethods();
}

async function loadChannels() {
  try {
    const list = await (await api('/api/channels/catalog')).json();
    document.getElementById('chan-count').textContent = list.length;
    const tbody = document.getElementById('chan-rows');
    tbody.replaceChildren();
    list.forEach(c => {
      const row = document.createElement('tr');
      cell(row, c.label);
      const idCell = cell(row);
      const code = document.createElement('code');
      code.textContent = c.id;
      idCell.appendChild(code);
      cell(row, c.support === 'native' ? '✅ native' : c.support === 'webhook' ? '🔗 webhook' : '🧩 plugin');
      tbody.appendChild(row);
    });
  } catch (e) {}
}

async function loadMethods() {
  try {
    const res = await (await api('/api/methods')).json();
    document.getElementById('api-count').textContent = res.count;
    document.getElementById('api-count-inline').textContent = res.count;
    const tbody = document.getElementById('api-rows');
    tbody.replaceChildren();
    res.methods.forEach(m => {
      const row = document.createElement('tr');
      const nameCell = cell(row);
      const code = document.createElement('code');
      code.textContent = m.name;
      nameCell.appendChild(code);
      cell(row, m.scope);
      tbody.appendChild(row);
    });
  } catch (e) {}
}

async function loadSkills() {
  try {
    const list = await (await api('/api/skills')).json();
    document.getElementById('skill-count').textContent = list.length;
    const tbody = document.getElementById('skill-rows');
    tbody.replaceChildren();
    list.forEach(s => {
      const row = document.createElement('tr');
      const nameCell = cell(row);
      nameCell.textContent = (s.emoji || '🔧') + ' ';
      const code = document.createElement('code');
      code.textContent = s.name;
      nameCell.appendChild(code);
      cell(row, s.source);
      cell(row, s.description);
      tbody.appendChild(row);
    });
  } catch (e) {}
}

function openSessionChat(sid) {
  currentSession = sid;
  document.getElementById('chat-session-label').textContent = sid;
  const tabs = document.querySelectorAll('.tab');
  switchTab('webchat', tabs[1]);
}

async function loadChatHistory() {
  const box = document.getElementById('chat-messages');
  try {
    const turns = await (await api('/api/sessions/history?id=' + encodeURIComponent(currentSession))).json();
    box.replaceChildren();
    if (!turns.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Send a message to start chatting with OpenClaw.';
      box.appendChild(empty);
      return;
    }
    turns.forEach(t => {
      const el = document.createElement('div');
      el.className = 'msg ' + (t.role === 'assistant' ? 'assistant' : 'user');
      el.textContent = t.text;
      box.appendChild(el);
    });
    box.scrollTop = box.scrollHeight;
  } catch (e) {}
}

async function sendChat(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const btn = document.getElementById('send-btn');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  btn.disabled = true;
  const box = document.getElementById('chat-messages');
  const empty = box.querySelector('.empty');
  if (empty) empty.remove();
  const uDiv = document.createElement('div');
  uDiv.className = 'msg user';
  uDiv.textContent = text;
  box.appendChild(uDiv);
  box.scrollTop = box.scrollHeight;

  try {
    const res = await (await api('/api/chat', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({session_id: currentSession, message: text})
    })).json();
    const aDiv = document.createElement('div');
    aDiv.className = 'msg assistant';
    aDiv.textContent = res.reply || res.error || '(no response)';
    box.appendChild(aDiv);
    box.scrollTop = box.scrollHeight;
    refresh();
  } catch (err) {
    const aDiv = document.createElement('div');
    aDiv.className = 'msg assistant';
    aDiv.textContent = 'Connection error: ' + err;
    box.appendChild(aDiv);
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

async function resetCurrentSession() {
  await api('/api/sessions/reset', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({session_id: currentSession})
  });
  loadChatHistory();
  refresh();
}

async function approvePairing(channel, code, accountId) {
  await api('/api/pairings/approve', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({channel, code, accountId})
  });
  refresh();
}

async function dismissPairing(channel, code, accountId) {
  await api('/api/pairings/dismiss', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({channel, code, accountId})
  });
  refresh();
}

async function refresh() {
  try {
    const s = await (await api('/api/status')).json();
    document.getElementById('version').textContent = 'v' + s.version;
    document.getElementById('status').textContent = s.status;
    document.getElementById('connections').textContent = s.connections;
    document.getElementById('sessions').textContent = s.sessions;
    if (s.skills !== undefined) document.getElementById('skill-count').textContent = s.skills;
    document.getElementById('channels').textContent = (s.channels || []).join(', ') || 'none';
    document.getElementById('providers').textContent = 'Providers: ' + ((s.providers || []).join(', ') || 'none');

    const sessions = await (await api('/api/sessions')).json();
    const sbody = document.getElementById('session-rows');
    sbody.replaceChildren();
    if (!sessions.length) {
      const row = document.createElement('tr');
      const td = cell(row, 'No active sessions');
      td.colSpan = 7;
      td.className = 'empty';
      sbody.appendChild(row);
    } else {
      sessions.forEach(x => {
        const row = document.createElement('tr');
        const idCell = cell(row);
        const code = document.createElement('code');
        code.textContent = x.id;
        idCell.appendChild(code);
        cell(row, x.kind);
        cell(row, x.state);
        cell(row, x.channel);
        cell(row, x.turn_count ?? x.turnCount ?? 0);
        cell(row, new Date(x.updated_at || x.updatedAt).toLocaleTimeString());
        const actionCell = cell(row);
        const button = document.createElement('button');
        button.className = 'btn btn-secondary';
        button.textContent = 'Open Chat';
        button.addEventListener('click', () => openSessionChat(x.id));
        actionCell.appendChild(button);
        sbody.appendChild(row);
      });
    }

    const pairings = await (await api('/api/pairings')).json();
    const pendingCount = pairings.filter(p => p.status === 'pending').length;
    document.getElementById('pair-count').textContent = pendingCount;
    const pbody = document.getElementById('pairing-rows');
    pbody.replaceChildren();
    if (!pairings.length) {
      const row = document.createElement('tr');
      const td = cell(row, 'No pairing requests yet');
      td.colSpan = 7;
      td.className = 'empty';
      pbody.appendChild(row);
    } else {
      pairings.forEach(p => {
        const row = document.createElement('tr');
        // The code is the approval secret and is never sent to the browser, so
        // the operator types it from the pairing message.
        const codeCell = cell(row);
        const codeInput = document.createElement('input');
        codeInput.type = 'text';
        codeInput.placeholder = 'code from chat';
        codeInput.size = 10;
        codeCell.appendChild(codeInput);
        cell(row, p.channel);
        cell(row, p.accountId);
        const senderCell = cell(row);
        const senderEl = document.createElement('code');
        senderEl.textContent = p.senderId;
        senderCell.appendChild(senderEl);
        cell(row, p.senderName);
        cell(row, new Date(p.createdAt).toLocaleString());
        const actionCell = cell(row);
        if (p.status === 'pending') {
          const approve = document.createElement('button');
          approve.className = 'btn';
          approve.textContent = 'Approve';
          approve.addEventListener('click', () => {
            const code = codeInput.value.trim().toUpperCase();
            if (code) approvePairing(p.channel, code, p.accountId);
          });
          const dismiss = document.createElement('button');
          dismiss.className = 'btn btn-secondary';
          dismiss.textContent = 'Dismiss';
          dismiss.style.marginLeft = '.4rem';
          dismiss.addEventListener('click', () => {
            const code = codeInput.value.trim().toUpperCase();
            if (code) dismissPairing(p.channel, code, p.accountId);
          });
          actionCell.appendChild(approve);
          actionCell.appendChild(dismiss);
        } else {
          actionCell.textContent = '✓ Approved';
        }
        pbody.appendChild(row);
      });
    }
  } catch (e) {
    document.getElementById('status').textContent = 'offline';
  }
}
refresh();
setInterval(refresh, 3000);
</script>
</body>
</html>"#;

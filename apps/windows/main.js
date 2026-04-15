import { invoke } from '@tauri-apps/api/tauri';

document.querySelector('#app').innerHTML = `
  <div class="cyber-container">
    <div class="header">
      <h1>OpenClaw<span class="neon-text">_Gateway</span></h1>
    </div>
    <div class="dashboard">
      <div class="card status-card">
        <h2>Status</h2>
        <div id="status-indicator" class="indicator checking">Checking...</div>
        <button id="start-btn" class="cyber-btn hidden">Start Gateway</button>
        <button id="stop-btn" class="cyber-btn hidden">Stop Gateway</button>
      </div>
      <div class="card logs-card">
        <h2>System Logs</h2>
        <div id="logs-container" class="terminal-logs">
           <div class="log-line">> System initializing. Waiting for backend sync...</div>
        </div>
      </div>
    </div>
  </div>
`;

const statusIndicator = document.getElementById('status-indicator');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');

async function checkHealth() {
  try {
    const res = await fetch('http://localhost:18789/health');
    if (res.ok) {
      statusIndicator.textContent = 'ONLINE';
      statusIndicator.className = 'indicator online';
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      throw new Error("unhealthy");
    }
  } catch (_e) {
    statusIndicator.textContent = 'OFFLINE';
    statusIndicator.className = 'indicator offline';
    startBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
  }
}

setInterval(() => { void checkHealth(); }, 2000);
void checkHealth();

startBtn.addEventListener('click', async () => {
   try {
     await invoke('start_gateway');
     appendLog("Initiating gateway startup...");
     statusIndicator.textContent = 'STARTING...';
     statusIndicator.className = 'indicator checking';
   } catch(e) {
     appendLog("Start Error: " + e, "error");
   }
});

stopBtn.addEventListener('click', async () => {
   try {
     await invoke('stop_gateway');
     appendLog("Gateway stopped.");
     statusIndicator.textContent = 'OFFLINE';
     statusIndicator.className = 'indicator offline';
   } catch(e) {
     appendLog("Stop Error: " + e, "error");
   }
});

function appendLog(msg, type="info") {
  const c = document.getElementById('logs-container');
  const d = document.createElement('div');
  d.className = `log-line ${type}`;
  d.innerText = `> ${msg}`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}

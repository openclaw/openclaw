import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import { checkUpdate, installUpdate } from '@tauri-apps/api/updater';

// Listen for gateway logs
listen('gateway-log', (event) => {
  appendLog(event.payload, "info");
});

(async () => {
  const version = await getVersion();
  document.getElementById('app-version').textContent = `v${version}`;
})();

async function handleUpdate() {
  try {
    const { shouldUpdate, manifest } = await checkUpdate();
    if (shouldUpdate) {
      appendLog(`Update found: ${manifest.version}. Installing...`);
      await installUpdate();
    } else {
      appendLog("Already on the latest version.");
    }
  } catch (error) {
    if (error.toString().includes('Updater not active')) {
      appendLog("Update checks are currenty disabled for this build (signing key required).", "info");
    } else {
      appendLog("Update Error: " + error, "error");
    }
  }
}

document.querySelector('#app').innerHTML = `
  <div class="cyber-container">
    <div class="header">
      <div>
        <h1>OpenClaw<span class="neon-text">_Gateway</span></h1>
        <span id="app-version" style="font-size: 0.7rem; color: #555; margin-left: 2px;">v1.0.0</span>
      </div>
      <button id="settings-btn" class="settings-btn">Settings</button>
    </div>
    <div class="dashboard">
      <div class="left-col">
          <div class="card status-card">
            <h2>Status</h2>
            <div id="status-indicator" class="indicator checking">Checking...</div>
            <button id="start-btn" class="cyber-btn hidden">Start Gateway</button>
            <button id="stop-btn" class="cyber-btn hidden">Stop Gateway</button>
          </div>
          
          <div class="card metrics-card">
            <h2>Performance</h2>
            <div class="metric-item">
              <span>CPU Usage</span>
              <div class="progress-bg"><div id="cpu-bar" class="progress-fill" style="width: 0%"></div></div>
              <span id="cpu-val" class="metric-val">0%</span>
            </div>
            <div class="metric-item">
              <span>Memory</span>
              <div class="progress-bg"><div id="ram-bar" class="progress-fill" style="width: 0%"></div></div>
              <span id="ram-val" class="metric-val">0 MB</span>
            </div>
            <div class="metric-footer">
              <div class="sub-metric">
                <label>Uptime</label>
                <span id="uptime-val">0:00:00</span>
              </div>
              <div class="sub-metric">
                <label>Restarts</label>
                <span id="restart-val">0</span>
              </div>
            </div>
          </div>
      </div>

      <div class="card logs-card">
        <h2>System Logs</h2>
        <div id="logs-container" class="terminal-logs">
           <div class="log-line">> System initializing. Waiting for metrics sync...</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Settings Modal -->
  <div id="settings-modal" class="modal-overlay hidden">
    <div class="modal-content">
      <h2>System Settings</h2>
      <div class="settings-row">
        <label>Gateway Port</label>
        <input type="number" id="setting-gateway-port" value="18789">
      </div>
      <div class="settings-row">
        <label>Auto-start on Boot</label>
        <label class="switch">
          <input type="checkbox" id="setting-autostart">
          <span class="slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <label>System Maintenance</label>
        <button id="update-check-btn" class="settings-btn" style="width: auto;">Check for Updates</button>
      </div>
      <div class="modal-actions">
        <button id="settings-cancel" class="cancel-btn">Cancel</button>
        <button id="settings-save" class="save-btn">Save Changes</button>
      </div>
    </div>
  </div>
`;

const statusIndicator = document.getElementById('status-indicator');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsSave = document.getElementById('settings-save');
const settingsCancel = document.getElementById('settings-cancel');
const updateCheckBtn = document.getElementById('update-check-btn');



// Modal listeners
settingsBtn.addEventListener('click', async () => {
  try {
    const port = await invoke('get_config', { key: 'gateway.port' });
    const autostart = await invoke('is_autostart_enabled');
    
    document.getElementById('setting-gateway-port').value = port;
    document.getElementById('setting-autostart').checked = autostart;
    
    settingsModal.classList.remove('hidden');
  } catch (e) {
    appendLog("Settings Load Error: " + e, "error");
  }
});

settingsCancel.addEventListener('click', () => {
  settingsModal.classList.add('hidden');
});

settingsSave.addEventListener('click', async () => {
  const port = document.getElementById('setting-gateway-port').value;
  const autostart = document.getElementById('setting-autostart').checked;
  
  try {
    await invoke('set_config', { key: 'gateway.port', value: port });
    await invoke('toggle_autostart', { enabled: autostart });
    
    appendLog("Settings saved successfully.");
    settingsModal.classList.add('hidden');
  } catch (e) {
    appendLog("Settings Save Error: " + e, "error");
  }
});

updateCheckBtn.addEventListener('click', handleUpdate);

async function updateDashboard() {
  try {
    const metrics = await invoke('get_metrics');
    
    // Update status
    if (metrics.online) {
      statusIndicator.textContent = 'ONLINE';
      statusIndicator.className = 'indicator online';
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
    } else {
      statusIndicator.textContent = 'OFFLINE';
      statusIndicator.className = 'indicator offline';
      startBtn.classList.remove('hidden');
      stopBtn.classList.add('hidden');
    }

    // Update metrics
    const cpu = metrics.cpu_usage.toFixed(1);
    document.getElementById('cpu-val').textContent = `${cpu}%`;
    document.getElementById('cpu-bar').style.width = `${Math.min(cpu, 100)}%`;

    const ram = metrics.memory_mb;
    const totalRam = metrics.total_memory_mb;
    document.getElementById('ram-val').textContent = `${ram} MB / ${totalRam} MB`;
    const ramPercent = totalRam > 0 ? (ram / totalRam) * 100 : 0;
    document.getElementById('ram-bar').style.width = `${Math.min(ramPercent, 100)}%`;

    document.getElementById('restart-val').textContent = metrics.restarts;
    
    // Format Uptime
    const s = metrics.uptime_secs;
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    document.getElementById('uptime-val').textContent = `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;

  } catch (e) {
    console.error("Metrics error:", e);
  }
}

setInterval(updateDashboard, 2000);
void updateDashboard();

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
     appendLog("Gateway stopped manually.");
     statusIndicator.textContent = 'OFFLINE';
     statusIndicator.className = 'indicator offline';
     
     // Reset bars
     document.getElementById('cpu-bar').style.width = '0%';
     document.getElementById('ram-bar').style.width = '0%';
     document.getElementById('cpu-val').textContent = '0%';
     document.getElementById('ram-val').textContent = '0 MB';
   } catch(e) {
     appendLog("Stop Error: " + e, "error");
   }
});

function appendLog(msg, type="info") {
  const c = document.getElementById('logs-container');
  const d = document.createElement('div');
  d.className = `log-line ${type}`;
  d.innerText = `[${new Date().toLocaleTimeString()}] > ${msg}`;
  c.appendChild(d);
  c.scrollTop = c.scrollHeight;
}

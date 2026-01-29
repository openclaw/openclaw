// ============================================
// EMBEDDED BROWSER (Phase 3)
// ============================================

const browserState = {
  panels: new Map(), // id -> { id, url, iframe, history, historyIndex, devtools }
  activePanel: null,
  nextId: 1,
  previewMode: false,
  liveReloadEnabled: true,
  liveReloadWatcher: null,
  proxyMode: localStorage.getItem('clawd-browser-proxy') === 'true',
  // CSS/JS Injection state
  injection: {
    css: localStorage.getItem('clawd-inject-css') || '',
    js: localStorage.getItem('clawd-inject-js') || '',
    autoInject: localStorage.getItem('clawd-inject-auto') === 'true',
    snippets: JSON.parse(localStorage.getItem('clawd-inject-snippets') || '[]')
  }
};

// Listen for proxy navigation messages from iframe
window.addEventListener('message', (event) => {
  if (event.data?.type === 'proxy-navigate' && event.data.url) {
    const panelId = browserState.activePanel;
    if (panelId) {
      browserNavigate(panelId, event.data.url);
    }
  }
});

// Create a new browser panel
function createBrowserPanel(url = 'about:blank', options = {}) {
  const id = browserState.nextId++;
  
  const panel = {
    id,
    url: url || 'about:blank',
    history: [url || 'about:blank'],
    historyIndex: 0,
    devtools: {
      visible: false,
      activeTab: 'console',
      console: [],
      network: [],
      elements: null
    },
    viewport: {
      width: null,
      height: null,
      device: null
    },
    ...options
  };
  
  browserState.panels.set(id, panel);
  browserState.activePanel = id;
  
  // Create UI
  renderBrowserPanel(panel);
  
  return panel;
}

function renderBrowserPanel(panel) {
  // Create or get browser container
  let container = document.getElementById('browserPanelContainer');
  
  if (!container) {
    // Create browser panel in right split
    container = document.createElement('div');
    container.id = 'browserPanelContainer';
    container.className = 'browser-panel-container';
    
    const editorArea = document.querySelector('.editor-area');
    editorArea.appendChild(container);
  }
  
  container.innerHTML = `
    <div class="browser-panel" data-browser-id="${panel.id}">
      <!-- Browser Toolbar -->
      <div class="browser-toolbar">
        <div class="browser-nav">
          <button class="browser-btn" onclick="browserBack(${panel.id})" title="Back" ${panel.historyIndex <= 0 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          </button>
          <button class="browser-btn" onclick="browserForward(${panel.id})" title="Forward" ${panel.historyIndex >= panel.history.length - 1 ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>
          </button>
          <button class="browser-btn" onclick="browserReload(${panel.id})" title="Reload">
            <svg viewBox="0 0 24 24"><path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/></svg>
          </button>
        </div>
        
        <div class="browser-url-bar">
          <input type="text" class="browser-url-input" id="browserUrl${panel.id}" 
                 value="${escapeHtml(panel.url)}" 
                 onkeydown="if(event.key==='Enter')browserNavigate(${panel.id}, this.value)"
                 placeholder="Enter URL or localhost:port">
        </div>
        
        <div class="browser-actions">
          <button class="browser-btn ${browserState.proxyMode ? 'active' : ''}" onclick="toggleProxyMode(${panel.id})" title="Proxy Mode (bypass iframe restrictions)">
            <svg viewBox="0 0 24 24"><path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"/></svg>
          </button>
          <button class="browser-btn" onclick="toggleBrowserDevTools(${panel.id})" title="DevTools">
            <svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>
          </button>
          <button class="browser-btn" onclick="toggleBrowserResponsive(${panel.id})" title="Responsive Mode">
            <svg viewBox="0 0 24 24"><path d="M17 1H7c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 18H7V5h10v14z"/></svg>
          </button>
          <button class="browser-btn" onclick="toggleInjectionPanel(${panel.id})" title="Inject CSS/JS">
            <svg viewBox="0 0 24 24"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>
          </button>
          <button class="browser-btn" onclick="browserScreenshot(${panel.id})" title="Screenshot">
            <svg viewBox="0 0 24 24"><path d="M12 17.5c2.33 0 4.3-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5M8.5 11A1.5 1.5 0 0 0 10 9.5 1.5 1.5 0 0 0 8.5 8 1.5 1.5 0 0 0 7 9.5 1.5 1.5 0 0 0 8.5 11m7 0A1.5 1.5 0 0 0 17 9.5 1.5 1.5 0 0 0 15.5 8 1.5 1.5 0 0 0 14 9.5a1.5 1.5 0 0 0 1.5 1.5M12 1C5.93 1 1 5.93 1 12s4.93 11 11 11 11-4.93 11-11S18.07 1 12 1"/></svg>
          </button>
          <button class="browser-btn" onclick="toggleRecording(${panel.id})" title="Record" id="recordBtn${panel.id}">
            <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>
          </button>
          <button class="browser-btn close" onclick="closeBrowserPanel(${panel.id})" title="Close">
            <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
      </div>
      
      <!-- Responsive Controls (hidden by default) -->
      <div class="browser-responsive hidden" id="browserResponsive${panel.id}">
        <select onchange="setBrowserDevice(${panel.id}, this.value)" id="browserDeviceSelect${panel.id}">
          <option value="">Responsive</option>
          <option value="375x667">iPhone SE</option>
          <option value="390x844">iPhone 14</option>
          <option value="430x932">iPhone 14 Pro Max</option>
          <option value="768x1024">iPad</option>
          <option value="1024x1366">iPad Pro 12.9"</option>
          <option value="360x640">Android Small</option>
          <option value="412x915">Android Medium</option>
          <option value="1280x800">Laptop</option>
          <option value="1920x1080">Desktop</option>
        </select>
        <input type="number" id="browserWidth${panel.id}" placeholder="Width" style="width: 60px" 
               onchange="setBrowserViewport(${panel.id})">
        <span>×</span>
        <input type="number" id="browserHeight${panel.id}" placeholder="Height" style="width: 60px"
               onchange="setBrowserViewport(${panel.id})">
        <select onchange="setBrowserScale(${panel.id}, this.value)" id="browserScale${panel.id}">
          <option value="1">100%</option>
          <option value="0.75">75%</option>
          <option value="0.5">50%</option>
        </select>
      </div>
      
      <!-- Browser Viewport -->
      <div class="browser-viewport" id="browserViewport${panel.id}">
        <iframe id="browserFrame${panel.id}" 
                src="${getFrameUrl(panel.url)}" 
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
                onload="onBrowserFrameLoad(${panel.id})"></iframe>
      </div>
      
      <!-- DevTools Panel (hidden by default) -->
      <div class="browser-devtools hidden" id="browserDevTools${panel.id}">
        <div class="devtools-tabs">
          <button class="devtools-tab active" data-tab="console" onclick="switchDevToolsTab(${panel.id}, 'console')">Console</button>
          <button class="devtools-tab" data-tab="network" onclick="switchDevToolsTab(${panel.id}, 'network')">Network</button>
          <button class="devtools-tab" data-tab="elements" onclick="switchDevToolsTab(${panel.id}, 'elements')">Elements</button>
        </div>
        
        <!-- Console Tab -->
        <div class="devtools-panel" data-panel="console" id="devtoolsConsole${panel.id}">
          <div class="console-toolbar">
            <button onclick="clearBrowserConsole(${panel.id})">🗑 Clear</button>
            <select id="consoleFilter${panel.id}" onchange="filterConsole(${panel.id}, this.value)">
              <option value="all">All</option>
              <option value="log">Log</option>
              <option value="warn">Warnings</option>
              <option value="error">Errors</option>
            </select>
          </div>
          <div class="console-output" id="consoleOutput${panel.id}">
            <div class="console-placeholder">Console output will appear here</div>
          </div>
          <div class="console-input-wrapper">
            <span class="console-prompt">›</span>
            <input type="text" class="console-input" id="consoleInput${panel.id}" 
                   placeholder="Execute JavaScript..."
                   onkeydown="if(event.key==='Enter')executeConsole(${panel.id}, this.value)">
          </div>
        </div>
        
        <!-- Network Tab -->
        <div class="devtools-panel hidden" data-panel="network" id="devtoolsNetwork${panel.id}">
          <div class="network-toolbar">
            <button onclick="clearBrowserNetwork(${panel.id})">🗑 Clear</button>
            <label><input type="checkbox" id="networkPreserve${panel.id}"> Preserve log</label>
          </div>
          <div class="network-list" id="networkList${panel.id}">
            <div class="network-header">
              <span class="network-col name">Name</span>
              <span class="network-col status">Status</span>
              <span class="network-col type">Type</span>
              <span class="network-col size">Size</span>
              <span class="network-col time">Time</span>
            </div>
            <div class="network-items" id="networkItems${panel.id}">
              <div class="network-placeholder">Network requests will appear here</div>
            </div>
          </div>
        </div>
        
        <!-- Elements Tab -->
        <div class="devtools-panel hidden" data-panel="elements" id="devtoolsElements${panel.id}">
          <div class="elements-container">
            <div class="elements-tree-wrapper">
              <div class="elements-toolbar">
                <button class="elements-btn" onclick="refreshElementsPanel(${panel.id})" title="Refresh">↻</button>
                <button class="elements-btn" onclick="toggleElementsPicker(${panel.id})" title="Select element" id="elementsPicker${panel.id}">⊙</button>
              </div>
              <div class="elements-tree" id="elementsTree${panel.id}">
                <div class="elements-placeholder">Click ↻ to load DOM tree</div>
              </div>
            </div>
            <div class="elements-styles-wrapper">
              <div class="elements-styles-tabs">
                <button class="styles-tab active" data-tab="styles" onclick="switchStylesTab(${panel.id}, 'styles')">Styles</button>
                <button class="styles-tab" data-tab="computed" onclick="switchStylesTab(${panel.id}, 'computed')">Computed</button>
                <button class="styles-tab" data-tab="layout" onclick="switchStylesTab(${panel.id}, 'layout')">Layout</button>
              </div>
              <div class="styles-panel" id="stylesPanel${panel.id}" data-panel="styles">
                <div class="styles-placeholder">Select an element to see styles</div>
              </div>
              <div class="styles-panel hidden" id="computedPanel${panel.id}" data-panel="computed">
                <div class="styles-placeholder">Select an element to see computed styles</div>
              </div>
              <div class="styles-panel hidden" id="layoutPanel${panel.id}" data-panel="layout">
                <div class="styles-placeholder">Select an element to see box model</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  
  container.classList.remove('hidden');
  
  // Setup message listener for devtools communication
  setupBrowserMessageListener(panel.id);
}

function sanitizeUrl(url) {
  if (!url || url === 'about:blank') return 'about:blank';
  
  // If it's a relative path, assume localhost preview
  if (url.startsWith('/')) {
    return `http://localhost:3000${url}`;
  }
  
  // If no protocol, add http://
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return `http://${url}`;
  }
  
  return url;
}

// Get the actual iframe URL (applying proxy if needed)
function getFrameUrl(url) {
  const sanitized = sanitizeUrl(url);
  if (sanitized === 'about:blank') return sanitized;
  
  const isLocalhost = sanitized.includes('localhost') || sanitized.includes('127.0.0.1');
  
  if (browserState.proxyMode && !isLocalhost) {
    return `/api/proxy?url=${encodeURIComponent(sanitized)}`;
  }
  
  return sanitized;
}

function browserNavigate(panelId, url) {
  const panel = browserState.panels.get(panelId);
  if (!panel) return;
  
  const sanitizedUrl = sanitizeUrl(url);
  panel.url = sanitizedUrl;
  panel.actualUrl = sanitizedUrl; // Store original URL
  
  // Add to history
  panel.history = panel.history.slice(0, panel.historyIndex + 1);
  panel.history.push(sanitizedUrl);
  panel.historyIndex = panel.history.length - 1;
  
  // Determine frame URL (proxy or direct)
  let frameUrl = sanitizedUrl;
  const isLocalhost = sanitizedUrl.includes('localhost') || sanitizedUrl.includes('127.0.0.1');
  
  if (browserState.proxyMode && !isLocalhost && sanitizedUrl !== 'about:blank') {
    frameUrl = `/api/proxy?url=${encodeURIComponent(sanitizedUrl)}`;
  }
  
  // Update iframe
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (iframe) {
    iframe.src = frameUrl;
  }
  
  // Update URL bar (show original URL, not proxy URL)
  const urlInput = document.getElementById(`browserUrl${panelId}`);
  if (urlInput) {
    urlInput.value = sanitizedUrl;
  }
  
  // Update nav button states
  renderBrowserPanel(panel);
}

function toggleProxyMode(panelId) {
  browserState.proxyMode = !browserState.proxyMode;
  localStorage.setItem('clawd-browser-proxy', browserState.proxyMode ? 'true' : 'false');
  
  const panel = browserState.panels.get(panelId);
  if (panel) {
    // Re-render to update button state
    renderBrowserPanel(panel);
    
    // Re-navigate to apply proxy mode
    if (panel.url && panel.url !== 'about:blank') {
      browserNavigate(panelId, panel.url);
    }
  }
  
  if (typeof showNotification === 'function') {
    showNotification(`Proxy mode ${browserState.proxyMode ? 'enabled' : 'disabled'}`, 'info');
  }
}

function browserBack(panelId) {
  const panel = browserState.panels.get(panelId);
  if (!panel || panel.historyIndex <= 0) return;
  
  panel.historyIndex--;
  panel.url = panel.history[panel.historyIndex];
  
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (iframe) {
    iframe.src = getFrameUrl(panel.url);
  }
  
  const urlInput = document.getElementById(`browserUrl${panelId}`);
  if (urlInput) {
    urlInput.value = panel.url;
  }
}

function browserForward(panelId) {
  const panel = browserState.panels.get(panelId);
  if (!panel || panel.historyIndex >= panel.history.length - 1) return;
  
  panel.historyIndex++;
  panel.url = panel.history[panel.historyIndex];
  
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (iframe) {
    iframe.src = getFrameUrl(panel.url);
  }
  
  const urlInput = document.getElementById(`browserUrl${panelId}`);
  if (urlInput) {
    urlInput.value = panel.url;
  }
}

function browserReload(panelId) {
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (iframe) {
    iframe.src = iframe.src;
  }
}

function onBrowserFrameLoad(panelId) {
  const panel = browserState.panels.get(panelId);
  if (!panel) return;
  
  // Inject devtools helper script
  injectDevtoolsScript(panelId);
}

function injectDevtoolsScript(panelId) {
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (!iframe) return;
  
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    
    const script = doc.createElement('script');
    script.textContent = `
      (function() {
        const PARENT = window.parent;
        const PANEL_ID = ${panelId};
        
        // Console interception
        const originalConsole = { ...console };
        ['log', 'warn', 'error', 'info', 'debug'].forEach(method => {
          console[method] = function(...args) {
            originalConsole[method](...args);
            try {
              PARENT.postMessage({
                type: 'devtools:console',
                panelId: PANEL_ID,
                method: method,
                args: args.map(arg => {
                  try {
                    if (typeof arg === 'object') {
                      return JSON.stringify(arg, null, 2);
                    }
                    return String(arg);
                  } catch {
                    return String(arg);
                  }
                }),
                timestamp: Date.now()
              }, '*');
            } catch (e) {}
          };
        });
        
        // Network interception (fetch)
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const startTime = performance.now();
          const url = typeof args[0] === 'string' ? args[0] : args[0].url;
          const method = args[1]?.method || 'GET';
          
          try {
            const response = await originalFetch(...args);
            const duration = performance.now() - startTime;
            
            PARENT.postMessage({
              type: 'devtools:network',
              panelId: PANEL_ID,
              request: { url, method },
              response: {
                status: response.status,
                type: response.headers.get('content-type')?.split(';')[0] || 'unknown',
                size: response.headers.get('content-length') || '?'
              },
              duration: Math.round(duration)
            }, '*');
            
            return response;
          } catch (error) {
            PARENT.postMessage({
              type: 'devtools:network',
              panelId: PANEL_ID,
              request: { url, method },
              response: { status: 0, type: 'error', size: '0' },
              duration: Math.round(performance.now() - startTime),
              error: error.message
            }, '*');
            throw error;
          }
        };
        
        // XHR interception
        const originalXHR = window.XMLHttpRequest;
        window.XMLHttpRequest = function() {
          const xhr = new originalXHR();
          const originalOpen = xhr.open;
          const originalSend = xhr.send;
          let method, url, startTime;
          
          xhr.open = function(m, u, ...rest) {
            method = m;
            url = u;
            return originalOpen.call(this, m, u, ...rest);
          };
          
          xhr.send = function(...args) {
            startTime = performance.now();
            
            xhr.addEventListener('load', function() {
              PARENT.postMessage({
                type: 'devtools:network',
                panelId: PANEL_ID,
                request: { url, method },
                response: {
                  status: xhr.status,
                  type: xhr.getResponseHeader('content-type')?.split(';')[0] || 'unknown',
                  size: xhr.getResponseHeader('content-length') || '?'
                },
                duration: Math.round(performance.now() - startTime)
              }, '*');
            });
            
            return originalSend.apply(this, args);
          };
          
          return xhr;
        };
        
        // Error handler
        window.addEventListener('error', function(e) {
          PARENT.postMessage({
            type: 'devtools:console',
            panelId: PANEL_ID,
            method: 'error',
            args: [e.message + ' at ' + e.filename + ':' + e.lineno],
            timestamp: Date.now()
          }, '*');
        });
        
        console.log('🐾 Clawd DevTools connected');
      })();
    `;
    
    doc.body.appendChild(script);
  } catch (e) {
    // Cross-origin restriction - can't inject
    console.log('DevTools injection blocked (cross-origin)');
  }
}

function setupBrowserMessageListener(panelId) {
  window.addEventListener('message', (event) => {
    if (!event.data || !event.data.type) return;
    if (event.data.panelId !== panelId) return;
    
    const panel = browserState.panels.get(panelId);
    if (!panel) return;
    
    if (event.data.type === 'devtools:console') {
      const { method, args, timestamp } = event.data;
      addConsoleEntry(panelId, method, args, timestamp);
    } else if (event.data.type === 'devtools:network') {
      addNetworkEntry(panelId, event.data);
    }
  });
}

function addConsoleEntry(panelId, method, args, timestamp) {
  const panel = browserState.panels.get(panelId);
  if (!panel) return;
  
  panel.devtools.console.push({ method, args, timestamp });
  
  const output = document.getElementById(`consoleOutput${panelId}`);
  if (!output) return;
  
  // Remove placeholder
  const placeholder = output.querySelector('.console-placeholder');
  if (placeholder) placeholder.remove();
  
  const entry = document.createElement('div');
  entry.className = `console-entry ${method}`;
  
  const time = new Date(timestamp).toLocaleTimeString();
  entry.innerHTML = `
    <span class="console-icon">${method === 'error' ? '✕' : method === 'warn' ? '⚠' : method === 'info' ? 'ℹ' : '›'}</span>
    <span class="console-message">${args.map(a => escapeHtml(a)).join(' ')}</span>
    <span class="console-time">${time}</span>
  `;
  
  output.appendChild(entry);
  output.scrollTop = output.scrollHeight;
}

function addNetworkEntry(panelId, data) {
  const panel = browserState.panels.get(panelId);
  if (!panel) return;
  
  panel.devtools.network.push(data);
  
  const items = document.getElementById(`networkItems${panelId}`);
  if (!items) return;
  
  // Remove placeholder
  const placeholder = items.querySelector('.network-placeholder');
  if (placeholder) placeholder.remove();
  
  const entry = document.createElement('div');
  entry.className = `network-item ${data.error ? 'error' : data.response.status >= 400 ? 'error' : ''}`;
  
  const urlParts = data.request.url.split('/');
  const name = urlParts[urlParts.length - 1] || data.request.url;
  
  entry.innerHTML = `
    <span class="network-col name" title="${escapeHtml(data.request.url)}">${escapeHtml(name)}</span>
    <span class="network-col status ${data.response.status >= 400 ? 'error' : ''}">${data.response.status || 'ERR'}</span>
    <span class="network-col type">${data.response.type}</span>
    <span class="network-col size">${formatSize(data.response.size)}</span>
    <span class="network-col time">${data.duration}ms</span>
  `;
  
  items.appendChild(entry);
}

function formatSize(size) {
  if (size === '?' || !size) return '—';
  const bytes = parseInt(size);
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function toggleBrowserDevTools(panelId) {
  const devtools = document.getElementById(`browserDevTools${panelId}`);
  if (!devtools) return;
  
  devtools.classList.toggle('hidden');
}

function switchDevToolsTab(panelId, tab) {
  // Update tabs
  const tabs = document.querySelectorAll(`#browserDevTools${panelId} .devtools-tab`);
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  
  // Update panels
  const panels = document.querySelectorAll(`#browserDevTools${panelId} .devtools-panel`);
  panels.forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tab));
  
  // Refresh elements panel when switching to it
  if (tab === 'elements') {
    refreshElementsPanel(panelId);
  }
}

function clearBrowserConsole(panelId) {
  const panel = browserState.panels.get(panelId);
  if (panel) panel.devtools.console = [];
  
  const output = document.getElementById(`consoleOutput${panelId}`);
  if (output) {
    output.innerHTML = '<div class="console-placeholder">Console output will appear here</div>';
  }
}

function clearBrowserNetwork(panelId) {
  const panel = browserState.panels.get(panelId);
  if (panel) panel.devtools.network = [];
  
  const items = document.getElementById(`networkItems${panelId}`);
  if (items) {
    items.innerHTML = '<div class="network-placeholder">Network requests will appear here</div>';
  }
}

function executeConsole(panelId, code) {
  const iframe = document.getElementById(`browserFrame${panelId}`);
  const input = document.getElementById(`consoleInput${panelId}`);
  
  if (!iframe || !code.trim()) return;
  
  try {
    const result = iframe.contentWindow.eval(code);
    addConsoleEntry(panelId, 'log', [String(result)], Date.now());
  } catch (e) {
    addConsoleEntry(panelId, 'error', [e.message], Date.now());
  }
  
  input.value = '';
}

function toggleBrowserResponsive(panelId) {
  const responsive = document.getElementById(`browserResponsive${panelId}`);
  if (responsive) {
    responsive.classList.toggle('hidden');
  }
}

function setBrowserDevice(panelId, deviceValue) {
  if (!deviceValue) {
    // Reset to responsive
    const viewport = document.getElementById(`browserViewport${panelId}`);
    viewport.style.width = '';
    viewport.style.height = '';
    return;
  }
  
  const [width, height] = deviceValue.split('x').map(Number);
  
  document.getElementById(`browserWidth${panelId}`).value = width;
  document.getElementById(`browserHeight${panelId}`).value = height;
  
  setBrowserViewport(panelId);
}

function setBrowserViewport(panelId) {
  const width = document.getElementById(`browserWidth${panelId}`).value;
  const height = document.getElementById(`browserHeight${panelId}`).value;
  
  const viewport = document.getElementById(`browserViewport${panelId}`);
  if (!viewport) return;
  
  if (width && height) {
    viewport.style.width = width + 'px';
    viewport.style.height = height + 'px';
    viewport.classList.add('responsive-mode');
  } else {
    viewport.style.width = '';
    viewport.style.height = '';
    viewport.classList.remove('responsive-mode');
  }
}

function setBrowserScale(panelId, scale) {
  const viewport = document.getElementById(`browserViewport${panelId}`);
  if (viewport) {
    viewport.style.transform = `scale(${scale})`;
    viewport.style.transformOrigin = 'top left';
  }
}

async function browserScreenshot(panelId) {
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (!iframe) {
    showNotification('No browser panel found', 'error');
    return;
  }
  
  // Show options modal
  showScreenshotModal(panelId);
}

function showScreenshotModal(panelId) {
  // Remove existing modal
  const existing = document.getElementById('screenshotModal');
  if (existing) existing.remove();
  
  const modal = document.createElement('div');
  modal.id = 'screenshotModal';
  modal.className = 'screenshot-modal';
  modal.innerHTML = `
    <div class="screenshot-modal-content">
      <div class="screenshot-header">
        <h3>📸 Screenshot</h3>
        <button class="screenshot-close" onclick="closeScreenshotModal()">×</button>
      </div>
      <div class="screenshot-options">
        <div class="screenshot-option-group">
          <label>Capture</label>
          <div class="screenshot-radio-group">
            <label><input type="radio" name="captureType" value="viewport" checked> Viewport only</label>
            <label><input type="radio" name="captureType" value="full"> Full page</label>
          </div>
        </div>
        <div class="screenshot-option-group">
          <label>Format</label>
          <div class="screenshot-radio-group">
            <label><input type="radio" name="format" value="png" checked> PNG</label>
            <label><input type="radio" name="format" value="jpeg"> JPEG</label>
            <label><input type="radio" name="format" value="webp"> WebP</label>
          </div>
        </div>
        <div class="screenshot-option-group">
          <label class="screenshot-checkbox">
            <input type="checkbox" id="screenshotTimestamp"> Add timestamp
          </label>
        </div>
      </div>
      <div class="screenshot-actions">
        <button class="screenshot-btn" onclick="closeScreenshotModal()">Cancel</button>
        <button class="screenshot-btn primary" onclick="captureScreenshot(${panelId})">📸 Capture</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function closeScreenshotModal() {
  const modal = document.getElementById('screenshotModal');
  if (modal) modal.remove();
}

async function captureScreenshot(panelId) {
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (!iframe) return;
  
  const captureType = document.querySelector('input[name="captureType"]:checked')?.value || 'viewport';
  const format = document.querySelector('input[name="format"]:checked')?.value || 'png';
  const addTimestamp = document.getElementById('screenshotTimestamp')?.checked || false;
  
  closeScreenshotModal();
  showNotification('📸 Capturing...', 'info', 1500);
  
  try {
    // Load html2canvas if not already loaded
    if (typeof html2canvas === 'undefined') {
      await loadScript('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
    }
    
    // Get the iframe content
    let targetElement;
    try {
      targetElement = iframe.contentDocument.body;
    } catch (e) {
      // Cross-origin fallback: capture the iframe element itself
      targetElement = iframe;
    }
    
    const options = {
      useCORS: true,
      allowTaint: true,
      backgroundColor: '#ffffff',
      scale: 2, // Higher quality
      logging: false
    };
    
    if (captureType === 'viewport') {
      options.windowWidth = iframe.clientWidth;
      options.windowHeight = iframe.clientHeight;
      options.width = iframe.clientWidth;
      options.height = iframe.clientHeight;
    }
    
    const canvas = await html2canvas(targetElement, options);
    
    // Add timestamp if requested
    if (addTimestamp) {
      const ctx = canvas.getContext('2d');
      const timestamp = new Date().toLocaleString();
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(10, canvas.height - 30, ctx.measureText(timestamp).width + 20, 24);
      ctx.fillStyle = '#ffffff';
      ctx.font = '12px system-ui';
      ctx.fillText(timestamp, 20, canvas.height - 12);
    }
    
    // Convert to blob and download
    const mimeType = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
    const quality = format === 'png' ? undefined : 0.92;
    
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `screenshot-${Date.now()}.${format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      showNotification('📸 Screenshot saved!', 'success', 2000);
    }, mimeType, quality);
    
  } catch (e) {
    console.error('Screenshot error:', e);
    showNotification(`Screenshot failed: ${e.message}`, 'error');
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

// ============================================
// ELEMENTS PANEL - DOM TREE VIEWER
// ============================================

function refreshElementsPanel(panelId) {
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (!iframe || !iframe.contentDocument) {
    showElementsError(panelId, 'Cannot access page content (cross-origin restriction)');
    return;
  }
  
  try {
    // Clear element map for fresh build
    elementsState.elementMap.clear();
    elementsState.selectedElement = null;
    
    const doc = iframe.contentDocument;
    const tree = buildDomTree(doc.documentElement, 0, panelId);
    
    const container = document.getElementById(`elementsTree${panelId}`);
    if (container) {
      container.innerHTML = tree;
    }
    
    showNotification('DOM tree refreshed', 'success', 1500);
  } catch (e) {
    showElementsError(panelId, 'Cannot access page content: ' + e.message);
  }
}

function showElementsError(panelId, message) {
  const container = document.getElementById(`elementsTree${panelId}`);
  if (container) {
    container.innerHTML = `<div class="elements-error">${escapeHtml(message)}</div>`;
  }
}

function buildDomTree(element, depth, panelId, maxDepth = 10) {
  if (!element || depth > maxDepth) return '';
  
  const tagName = element.tagName?.toLowerCase() || '';
  if (!tagName) return '';
  
  // Skip script and style contents
  const skipContent = ['script', 'style', 'svg', 'noscript'].includes(tagName);
  
  // Get attributes
  const attrs = [];
  if (element.id) attrs.push(`<span class="elem-attr-name">id</span>=<span class="elem-attr-value">"${escapeHtml(element.id)}"</span>`);
  if (element.className && typeof element.className === 'string') {
    attrs.push(`<span class="elem-attr-name">class</span>=<span class="elem-attr-value">"${escapeHtml(element.className)}"</span>`);
  }
  
  // Add a few other common attributes
  ['src', 'href', 'type', 'name', 'value'].forEach(attr => {
    if (element.hasAttribute && element.hasAttribute(attr)) {
      const val = element.getAttribute(attr);
      if (val && val.length < 50) {
        attrs.push(`<span class="elem-attr-name">${attr}</span>=<span class="elem-attr-value">"${escapeHtml(val.substring(0, 30))}${val.length > 30 ? '...' : ''}"</span>`);
      }
    }
  });
  
  const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
  const indent = '  '.repeat(depth);
  
  // Check if has children
  const children = Array.from(element.children || []);
  const hasChildren = children.length > 0 && !skipContent;
  
  // Get text content if no children
  let textContent = '';
  if (!hasChildren && element.childNodes) {
    for (const node of element.childNodes) {
      if (node.nodeType === 3) { // Text node
        const text = node.textContent.trim();
        if (text && text.length < 100) {
          textContent = escapeHtml(text.substring(0, 50)) + (text.length > 50 ? '...' : '');
          break;
        }
      }
    }
  }
  
  const nodeId = `elem-${panelId}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Store element reference for selection
  elementsState.elementMap.set(nodeId, element);
  
  let html = '';
  
  if (hasChildren) {
    html += `
      <div class="elem-node" id="${nodeId}">
        <div class="elem-line" onclick="selectElement(${panelId}, '${nodeId}', event)">
          <span class="elem-toggle" onclick="event.stopPropagation(); toggleElementNode('${nodeId}')">▼</span>
          <span class="elem-tag">&lt;${tagName}</span>${attrStr}<span class="elem-tag">&gt;</span>
        </div>
        <div class="elem-children">
    `;
    
    // Recursively build children (limit to prevent huge trees)
    const maxChildren = 50;
    children.slice(0, maxChildren).forEach(child => {
      html += buildDomTree(child, depth + 1, panelId, maxDepth);
    });
    
    if (children.length > maxChildren) {
      html += `<div class="elem-truncated">... ${children.length - maxChildren} more elements</div>`;
    }
    
    html += `
        </div>
        <div class="elem-line elem-close">
          <span class="elem-tag">&lt;/${tagName}&gt;</span>
        </div>
      </div>
    `;
  } else {
    // Self-closing or text content
    if (textContent) {
      html += `
        <div class="elem-node elem-leaf" id="${nodeId}">
          <div class="elem-line" onclick="selectElement(${panelId}, '${nodeId}', event)">
            <span class="elem-tag">&lt;${tagName}</span>${attrStr}<span class="elem-tag">&gt;</span><span class="elem-text">${textContent}</span><span class="elem-tag">&lt;/${tagName}&gt;</span>
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="elem-node elem-leaf" id="${nodeId}">
          <div class="elem-line" onclick="selectElement(${panelId}, '${nodeId}', event)">
            <span class="elem-tag">&lt;${tagName}</span>${attrStr}<span class="elem-tag"> /&gt;</span>
          </div>
        </div>
      `;
    }
  }
  
  return html;
}

function toggleElementNode(nodeId) {
  const node = document.getElementById(nodeId);
  if (!node) return;
  
  node.classList.toggle('collapsed');
  
  const toggle = node.querySelector('.elem-toggle');
  if (toggle) {
    toggle.textContent = node.classList.contains('collapsed') ? '▶' : '▼';
  }
}

// Element selection state
const elementsState = {
  selectedElement: null,
  elementMap: new Map(), // nodeId -> DOM element reference
  pickerActive: false
};

function selectElement(panelId, nodeId, event) {
  if (event) event.stopPropagation();
  
  // Remove previous selection
  document.querySelectorAll('.elem-line.selected').forEach(el => el.classList.remove('selected'));
  
  // Add selection to clicked element
  const elemNode = document.getElementById(nodeId);
  if (elemNode) {
    const line = elemNode.querySelector('.elem-line');
    if (line) line.classList.add('selected');
  }
  
  // Get the actual DOM element
  const element = elementsState.elementMap.get(nodeId);
  if (!element) return;
  
  elementsState.selectedElement = element;
  
  // Show styles for this element
  showElementStyles(panelId, element);
  showComputedStyles(panelId, element);
  showBoxModel(panelId, element);
  
  // Highlight in iframe
  highlightElementInFrame(panelId, element);
}

function highlightElementInFrame(panelId, element) {
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (!iframe) return;
  
  try {
    const doc = iframe.contentDocument;
    
    // Remove previous highlight
    const oldHighlight = doc.getElementById('clawd-element-highlight');
    if (oldHighlight) oldHighlight.remove();
    
    // Create highlight overlay
    const rect = element.getBoundingClientRect();
    const highlight = doc.createElement('div');
    highlight.id = 'clawd-element-highlight';
    highlight.style.cssText = `
      position: fixed;
      top: ${rect.top}px;
      left: ${rect.left}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      background: rgba(74, 222, 128, 0.2);
      border: 2px solid rgba(74, 222, 128, 0.8);
      pointer-events: none;
      z-index: 999999;
      transition: all 0.15s ease;
    `;
    doc.body.appendChild(highlight);
    
    // Remove after 2 seconds
    setTimeout(() => highlight.remove(), 2000);
  } catch (e) {
    console.warn('Cannot highlight element:', e);
  }
}

function showElementStyles(panelId, element) {
  const panel = document.getElementById(`stylesPanel${panelId}`);
  if (!panel) return;
  
  try {
    // Get inline styles
    const inlineStyles = element.style.cssText;
    
    // Build styles display
    let html = '';
    
    if (inlineStyles) {
      html += `
        <div class="styles-section">
          <div class="styles-section-header">element.style</div>
          <div class="styles-rules">
            ${parseInlineStyles(inlineStyles)}
          </div>
        </div>
      `;
    }
    
    // Try to get matched CSS rules
    const iframe = document.getElementById(`browserFrame${panelId}`);
    if (iframe && iframe.contentWindow) {
      try {
        const matchedRules = iframe.contentWindow.getMatchedCSSRules?.(element) || [];
        // Note: getMatchedCSSRules is deprecated, so this may not work in all browsers
        
        // Alternative: get stylesheets and find matching selectors
        const sheets = iframe.contentDocument.styleSheets;
        for (const sheet of sheets) {
          try {
            const rules = sheet.cssRules || sheet.rules;
            for (const rule of rules) {
              if (rule.selectorText && element.matches(rule.selectorText)) {
                html += `
                  <div class="styles-section">
                    <div class="styles-section-header">${escapeHtml(rule.selectorText)}</div>
                    <div class="styles-rules">
                      ${parseCSSText(rule.style.cssText)}
                    </div>
                  </div>
                `;
              }
            }
          } catch (e) {
            // Cross-origin stylesheet
          }
        }
      } catch (e) {
        // Fallback if matching fails
      }
    }
    
    if (!html) {
      html = '<div class="styles-placeholder">No styles applied</div>';
    }
    
    panel.innerHTML = html;
  } catch (e) {
    panel.innerHTML = `<div class="styles-error">Error reading styles: ${e.message}</div>`;
  }
}

function showComputedStyles(panelId, element) {
  const panel = document.getElementById(`computedPanel${panelId}`);
  if (!panel) return;
  
  try {
    const iframe = document.getElementById(`browserFrame${panelId}`);
    const computed = iframe.contentWindow.getComputedStyle(element);
    
    // Group important properties
    const groups = {
      'Layout': ['display', 'position', 'top', 'right', 'bottom', 'left', 'float', 'clear', 'z-index'],
      'Box': ['width', 'height', 'margin', 'padding', 'border', 'box-sizing'],
      'Typography': ['font-family', 'font-size', 'font-weight', 'line-height', 'color', 'text-align'],
      'Background': ['background-color', 'background-image', 'background-size'],
      'Flex': ['flex', 'flex-direction', 'justify-content', 'align-items', 'gap']
    };
    
    let html = '';
    
    for (const [groupName, props] of Object.entries(groups)) {
      html += `<div class="computed-group">
        <div class="computed-group-header">${groupName}</div>`;
      
      for (const prop of props) {
        const value = computed.getPropertyValue(prop);
        if (value && value !== 'none' && value !== 'normal' && value !== 'auto' && value !== '0px') {
          html += `
            <div class="computed-row">
              <span class="computed-prop">${prop}</span>
              <span class="computed-value">${escapeHtml(value)}</span>
            </div>
          `;
        }
      }
      
      html += '</div>';
    }
    
    panel.innerHTML = html || '<div class="styles-placeholder">No computed styles</div>';
  } catch (e) {
    panel.innerHTML = `<div class="styles-error">Error: ${e.message}</div>`;
  }
}

function showBoxModel(panelId, element) {
  const panel = document.getElementById(`layoutPanel${panelId}`);
  if (!panel) return;
  
  try {
    const iframe = document.getElementById(`browserFrame${panelId}`);
    const computed = iframe.contentWindow.getComputedStyle(element);
    
    const margin = {
      top: parseInt(computed.marginTop) || 0,
      right: parseInt(computed.marginRight) || 0,
      bottom: parseInt(computed.marginBottom) || 0,
      left: parseInt(computed.marginLeft) || 0
    };
    
    const border = {
      top: parseInt(computed.borderTopWidth) || 0,
      right: parseInt(computed.borderRightWidth) || 0,
      bottom: parseInt(computed.borderBottomWidth) || 0,
      left: parseInt(computed.borderLeftWidth) || 0
    };
    
    const padding = {
      top: parseInt(computed.paddingTop) || 0,
      right: parseInt(computed.paddingRight) || 0,
      bottom: parseInt(computed.paddingBottom) || 0,
      left: parseInt(computed.paddingLeft) || 0
    };
    
    const width = parseInt(computed.width) || 0;
    const height = parseInt(computed.height) || 0;
    
    panel.innerHTML = `
      <div class="box-model">
        <div class="box-margin">
          <span class="box-label">margin</span>
          <span class="box-value box-top">${margin.top}</span>
          <span class="box-value box-right">${margin.right}</span>
          <span class="box-value box-bottom">${margin.bottom}</span>
          <span class="box-value box-left">${margin.left}</span>
          <div class="box-border">
            <span class="box-label">border</span>
            <span class="box-value box-top">${border.top}</span>
            <span class="box-value box-right">${border.right}</span>
            <span class="box-value box-bottom">${border.bottom}</span>
            <span class="box-value box-left">${border.left}</span>
            <div class="box-padding">
              <span class="box-label">padding</span>
              <span class="box-value box-top">${padding.top}</span>
              <span class="box-value box-right">${padding.right}</span>
              <span class="box-value box-bottom">${padding.bottom}</span>
              <span class="box-value box-left">${padding.left}</span>
              <div class="box-content">
                ${width} × ${height}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    panel.innerHTML = `<div class="styles-error">Error: ${e.message}</div>`;
  }
}

function switchStylesTab(panelId, tabName) {
  // Update tab buttons
  const tabs = document.querySelectorAll(`#devtoolsElements${panelId} .styles-tab`);
  tabs.forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === tabName);
  });
  
  // Show/hide panels
  const panels = ['styles', 'computed', 'layout'];
  panels.forEach(name => {
    const panel = document.getElementById(`${name}Panel${panelId}`);
    if (panel) {
      panel.classList.toggle('hidden', name !== tabName);
    }
  });
}

function toggleElementsPicker(panelId) {
  elementsState.pickerActive = !elementsState.pickerActive;
  
  const btn = document.getElementById(`elementsPicker${panelId}`);
  if (btn) {
    btn.classList.toggle('active', elementsState.pickerActive);
  }
  
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (!iframe) return;
  
  try {
    const doc = iframe.contentDocument;
    
    if (elementsState.pickerActive) {
      // Add hover highlight
      doc.body.style.cursor = 'crosshair';
      doc.addEventListener('mouseover', (e) => handlePickerHover(panelId, e));
      doc.addEventListener('click', (e) => handlePickerClick(panelId, e));
    } else {
      doc.body.style.cursor = '';
      // Remove highlight
      const highlight = doc.getElementById('clawd-picker-highlight');
      if (highlight) highlight.remove();
    }
  } catch (e) {
    showNotification('Cannot activate picker (cross-origin)', 'warning');
    elementsState.pickerActive = false;
  }
}

function handlePickerHover(panelId, event) {
  if (!elementsState.pickerActive) return;
  
  const iframe = document.getElementById(`browserFrame${panelId}`);
  const doc = iframe.contentDocument;
  
  // Remove old highlight
  let highlight = doc.getElementById('clawd-picker-highlight');
  if (!highlight) {
    highlight = doc.createElement('div');
    highlight.id = 'clawd-picker-highlight';
    highlight.style.cssText = `
      position: fixed;
      pointer-events: none;
      z-index: 999999;
      background: rgba(74, 222, 128, 0.1);
      border: 2px solid rgba(74, 222, 128, 0.8);
      transition: all 0.1s ease;
    `;
    doc.body.appendChild(highlight);
  }
  
  const rect = event.target.getBoundingClientRect();
  highlight.style.top = rect.top + 'px';
  highlight.style.left = rect.left + 'px';
  highlight.style.width = rect.width + 'px';
  highlight.style.height = rect.height + 'px';
}

function handlePickerClick(panelId, event) {
  if (!elementsState.pickerActive) return;
  
  event.preventDefault();
  event.stopPropagation();
  
  // Deactivate picker
  toggleElementsPicker(panelId);
  
  // Select the clicked element
  const element = event.target;
  
  // Refresh the tree and find the element
  refreshElementsPanel(panelId);
  
  // Find nodeId for this element and select it
  for (const [nodeId, el] of elementsState.elementMap.entries()) {
    if (el === element) {
      selectElement(panelId, nodeId);
      break;
    }
  }
}

function parseInlineStyles(cssText) {
  return cssText.split(';')
    .filter(s => s.trim())
    .map(s => {
      const [prop, ...valueParts] = s.split(':');
      const value = valueParts.join(':').trim();
      return `<div class="style-rule"><span class="style-prop">${escapeHtml(prop.trim())}</span>: <span class="style-value">${escapeHtml(value)}</span>;</div>`;
    })
    .join('');
}

function parseCSSText(cssText) {
  return parseInlineStyles(cssText);
}

// ============================================
// VIDEO RECORDING
// ============================================

const recordingState = {
  active: false,
  paused: false,
  mediaRecorder: null,
  chunks: [],
  startTime: null,
  panelId: null,
  timerInterval: null,
  canvas: null,
  ctx: null,
  animationFrame: null
};

function toggleRecording(panelId) {
  if (recordingState.active && recordingState.panelId === panelId) {
    stopRecording(panelId);
  } else if (!recordingState.active) {
    showRecordingModal(panelId);
  }
}

function showRecordingModal(panelId) {
  const existing = document.getElementById('recordingModal');
  if (existing) existing.remove();
  
  const modal = document.createElement('div');
  modal.id = 'recordingModal';
  modal.className = 'recording-modal';
  modal.innerHTML = `
    <div class="recording-modal-content">
      <div class="recording-header">
        <h3>🎬 Screen Recording</h3>
        <button class="recording-close" onclick="closeRecordingModal()">×</button>
      </div>
      <div class="recording-options">
        <div class="recording-option-group">
          <label>Format</label>
          <div class="recording-radio-group">
            <label><input type="radio" name="recordFormat" value="webm" checked> WebM</label>
            <label><input type="radio" name="recordFormat" value="gif"> GIF (smaller, no audio)</label>
          </div>
        </div>
        <div class="recording-option-group">
          <label>Quality</label>
          <div class="recording-radio-group">
            <label><input type="radio" name="recordQuality" value="high" checked> High (1080p)</label>
            <label><input type="radio" name="recordQuality" value="medium"> Medium (720p)</label>
            <label><input type="radio" name="recordQuality" value="low"> Low (480p)</label>
          </div>
        </div>
        <div class="recording-option-group">
          <label class="recording-checkbox">
            <input type="checkbox" id="recordClicks" checked> Show click indicators
          </label>
        </div>
      </div>
      <div class="recording-actions">
        <button class="recording-btn" onclick="closeRecordingModal()">Cancel</button>
        <button class="recording-btn primary" onclick="startRecording(${panelId})">🔴 Start Recording</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
}

function closeRecordingModal() {
  const modal = document.getElementById('recordingModal');
  if (modal) modal.remove();
}

async function startRecording(panelId) {
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (!iframe) {
    showNotification('No browser panel found', 'error');
    return;
  }
  
  const format = document.querySelector('input[name="recordFormat"]:checked')?.value || 'webm';
  const quality = document.querySelector('input[name="recordQuality"]:checked')?.value || 'high';
  const showClicks = document.getElementById('recordClicks')?.checked || false;
  
  closeRecordingModal();
  
  // Set up canvas for capturing
  const qualitySettings = {
    high: { width: 1920, height: 1080, fps: 30 },
    medium: { width: 1280, height: 720, fps: 24 },
    low: { width: 854, height: 480, fps: 15 }
  };
  
  const settings = qualitySettings[quality];
  
  // Create offscreen canvas
  const canvas = document.createElement('canvas');
  canvas.width = settings.width;
  canvas.height = settings.height;
  const ctx = canvas.getContext('2d');
  
  recordingState.canvas = canvas;
  recordingState.ctx = ctx;
  recordingState.panelId = panelId;
  recordingState.chunks = [];
  recordingState.format = format;
  recordingState.showClicks = showClicks;
  recordingState.clicks = [];
  
  // Set up click tracking if enabled
  if (showClicks) {
    try {
      iframe.contentDocument.addEventListener('click', (e) => {
        recordingState.clicks.push({
          x: e.clientX,
          y: e.clientY,
          time: Date.now()
        });
      });
    } catch (e) {
      // Cross-origin, skip click tracking
    }
  }
  
  // Create MediaRecorder from canvas stream
  const stream = canvas.captureStream(settings.fps);
  
  const mimeType = format === 'webm' ? 'video/webm;codecs=vp9' : 'video/webm';
  
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    showNotification('Recording format not supported', 'error');
    return;
  }
  
  const mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: quality === 'high' ? 5000000 : quality === 'medium' ? 2500000 : 1000000
  });
  
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) {
      recordingState.chunks.push(e.data);
    }
  };
  
  mediaRecorder.onstop = () => {
    finishRecording(panelId);
  };
  
  recordingState.mediaRecorder = mediaRecorder;
  recordingState.active = true;
  recordingState.startTime = Date.now();
  
  // Start recording
  mediaRecorder.start(100); // Collect data every 100ms
  
  // Start frame capture loop
  captureFrame(panelId, iframe, settings);
  
  // Update UI
  updateRecordingUI(panelId, true);
  showRecordingIndicator(panelId);
  
  showNotification('🔴 Recording started', 'info', 2000);
}

function captureFrame(panelId, iframe, settings) {
  if (!recordingState.active) return;
  
  const { canvas, ctx, showClicks, clicks } = recordingState;
  
  try {
    // Draw iframe content to canvas
    // Note: This only works for same-origin iframes
    const iframeDoc = iframe.contentDocument;
    const iframeBody = iframeDoc.body;
    
    // Use html2canvas for each frame (heavy but works)
    // For better performance, we'll draw a scaled version of the iframe
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Scale iframe to canvas
    const scaleX = canvas.width / iframe.clientWidth;
    const scaleY = canvas.height / iframe.clientHeight;
    
    // Draw using drawWindow if available (Firefox) or fall back to html2canvas
    if (ctx.drawWindow) {
      ctx.drawWindow(iframe.contentWindow, 0, 0, iframe.clientWidth, iframe.clientHeight, '#fff');
    } else {
      // Fallback: capture iframe as image
      // This is a simplified approach - for production, use html2canvas per frame
      // For now, we'll draw a placeholder with the URL
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ffffff';
      ctx.font = '24px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText('Recording: ' + (iframe.src || 'about:blank'), canvas.width / 2, canvas.height / 2);
      
      // Draw timer
      const elapsed = Math.floor((Date.now() - recordingState.startTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      ctx.fillText(`${mins}:${secs}`, canvas.width / 2, canvas.height / 2 + 40);
    }
    
    // Draw click indicators
    if (showClicks) {
      const now = Date.now();
      recordingState.clicks = clicks.filter(click => now - click.time < 500);
      
      clicks.forEach(click => {
        const age = now - click.time;
        const opacity = 1 - (age / 500);
        const radius = 20 + (age / 500) * 30;
        
        ctx.beginPath();
        ctx.arc(click.x * scaleX, click.y * scaleY, radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(74, 222, 128, ${opacity})`;
        ctx.lineWidth = 3;
        ctx.stroke();
      });
    }
  } catch (e) {
    // Cross-origin - draw placeholder
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '20px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('Recording (cross-origin preview)', canvas.width / 2, canvas.height / 2);
  }
  
  // Continue capturing
  recordingState.animationFrame = requestAnimationFrame(() => captureFrame(panelId, iframe, settings));
}

function showRecordingIndicator(panelId) {
  const browserPanel = document.querySelector(`.browser-panel[data-browser-id="${panelId}"]`);
  if (!browserPanel) return;
  
  let indicator = document.getElementById('recordingIndicator');
  if (indicator) indicator.remove();
  
  indicator = document.createElement('div');
  indicator.id = 'recordingIndicator';
  indicator.className = 'recording-indicator';
  indicator.innerHTML = `
    <span class="recording-dot"></span>
    <span class="recording-time" id="recordingTime">00:00</span>
    <button class="recording-control" onclick="pauseRecording(${panelId})" id="pauseBtn" title="Pause">⏸</button>
    <button class="recording-control" onclick="stopRecording(${panelId})" title="Stop">⏹</button>
  `;
  browserPanel.appendChild(indicator);
  
  // Start timer
  recordingState.timerInterval = setInterval(() => {
    if (!recordingState.paused) {
      const elapsed = Math.floor((Date.now() - recordingState.startTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const secs = (elapsed % 60).toString().padStart(2, '0');
      document.getElementById('recordingTime').textContent = `${mins}:${secs}`;
    }
  }, 1000);
}

function pauseRecording(panelId) {
  if (!recordingState.active) return;
  
  recordingState.paused = !recordingState.paused;
  
  const pauseBtn = document.getElementById('pauseBtn');
  if (pauseBtn) {
    pauseBtn.textContent = recordingState.paused ? '▶' : '⏸';
    pauseBtn.title = recordingState.paused ? 'Resume' : 'Pause';
  }
  
  if (recordingState.paused) {
    recordingState.mediaRecorder?.pause();
    cancelAnimationFrame(recordingState.animationFrame);
    showNotification('⏸ Recording paused', 'info', 1500);
  } else {
    recordingState.mediaRecorder?.resume();
    const iframe = document.getElementById(`browserFrame${panelId}`);
    captureFrame(panelId, iframe, { width: recordingState.canvas.width, height: recordingState.canvas.height });
    showNotification('▶ Recording resumed', 'info', 1500);
  }
}

function stopRecording(panelId) {
  if (!recordingState.active) return;
  
  // Stop frame capture
  cancelAnimationFrame(recordingState.animationFrame);
  
  // Stop media recorder
  if (recordingState.mediaRecorder && recordingState.mediaRecorder.state !== 'inactive') {
    recordingState.mediaRecorder.stop();
  }
  
  // Clear timer
  clearInterval(recordingState.timerInterval);
  
  // Update UI
  updateRecordingUI(panelId, false);
  
  // Remove indicator
  const indicator = document.getElementById('recordingIndicator');
  if (indicator) indicator.remove();
}

function finishRecording(panelId) {
  const { chunks, format } = recordingState;
  
  if (chunks.length === 0) {
    showNotification('No recording data', 'warning');
    resetRecordingState();
    return;
  }
  
  // Create blob
  const blob = new Blob(chunks, { type: 'video/webm' });
  
  if (format === 'gif') {
    // For GIF conversion, we'd need a library like gif.js
    // For now, just download as WebM with a note
    showNotification('GIF conversion not available, downloading as WebM', 'info', 3000);
  }
  
  // Download
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recording-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  const duration = Math.floor((Date.now() - recordingState.startTime) / 1000);
  showNotification(`🎬 Recording saved (${duration}s)`, 'success', 3000);
  
  resetRecordingState();
}

function resetRecordingState() {
  recordingState.active = false;
  recordingState.paused = false;
  recordingState.mediaRecorder = null;
  recordingState.chunks = [];
  recordingState.startTime = null;
  recordingState.panelId = null;
  recordingState.canvas = null;
  recordingState.ctx = null;
  recordingState.clicks = [];
}

function updateRecordingUI(panelId, isRecording) {
  const btn = document.getElementById(`recordBtn${panelId}`);
  if (btn) {
    btn.classList.toggle('recording', isRecording);
    btn.title = isRecording ? 'Stop Recording' : 'Record';
  }
}

// Export recording functions
window.toggleRecording = toggleRecording;
window.startRecording = startRecording;
window.pauseRecording = pauseRecording;
window.stopRecording = stopRecording;
window.closeRecordingModal = closeRecordingModal;

// Export new functions
window.selectElement = selectElement;
window.switchStylesTab = switchStylesTab;
window.toggleElementsPicker = toggleElementsPicker;

function closeBrowserPanel(panelId) {
  browserState.panels.delete(panelId);
  
  const container = document.getElementById('browserPanelContainer');
  if (container && browserState.panels.size === 0) {
    container.remove();
  }
}

// Open browser in a split pane
function openBrowserInPane(url) {
  // For now, create a side panel
  createBrowserPanel(url || 'http://localhost:3000');
}

// Live Preview functionality
function startLivePreview(htmlFile) {
  const url = htmlFile.startsWith('http') ? htmlFile : `http://localhost:3000/${htmlFile}`;
  const panel = createBrowserPanel(url, { liveReload: true });
  
  // Setup file watcher for auto-reload
  if (browserState.liveReloadEnabled && !browserState.liveReloadConnected) {
    setupLiveReloadConnection();
  }
  
  showNotification('Live preview started - auto-reload enabled', 'success');
  return panel;
}

// Connect to live reload SSE endpoint
function setupLiveReloadConnection() {
  if (browserState.liveReloadConnected) return;
  
  try {
    const eventSource = new EventSource('/api/live-reload');
    
    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleLiveReloadEvent(data);
      } catch (e) {
        console.error('Live reload parse error:', e);
      }
    };
    
    eventSource.onerror = (error) => {
      console.warn('Live reload connection error, will retry...');
      browserState.liveReloadConnected = false;
    };
    
    eventSource.onopen = () => {
      browserState.liveReloadConnected = true;
      console.log('📡 Live reload connected');
    };
    
    browserState.liveReloadSource = eventSource;
  } catch (e) {
    console.error('Failed to setup live reload:', e);
  }
}

function handleLiveReloadEvent(data) {
  const { type, path } = data;
  
  // Find panels that might need refresh
  browserState.panels.forEach((panel, panelId) => {
    if (!panel.liveReload) return;
    
    const iframe = document.getElementById(`browserFrame${panelId}`);
    if (!iframe) return;
    
    if (type === 'css') {
      // Hot reload CSS without full refresh
      hotReloadCSS(iframe, path);
    } else {
      // Full page reload
      iframe.src = iframe.src;
      showNotification(`Reloaded: ${path}`, 'info', 2000);
    }
  });
}

function hotReloadCSS(iframe, changedPath) {
  try {
    const doc = iframe.contentDocument;
    if (!doc) return;
    
    // Find and refresh the changed stylesheet
    const links = doc.querySelectorAll('link[rel="stylesheet"]');
    links.forEach(link => {
      if (link.href.includes(changedPath) || changedPath.endsWith('.css')) {
        // Add cache-bust query param
        const url = new URL(link.href);
        url.searchParams.set('_reload', Date.now());
        link.href = url.toString();
      }
    });
    
    // Also check inline style updates in case of CSS-in-JS
    showNotification(`CSS updated: ${changedPath}`, 'info', 1500);
  } catch (e) {
    // Cross-origin, do full reload
    iframe.src = iframe.src;
  }
}

// Initialize live reload on load if any panels exist with liveReload enabled
function initLiveReload() {
  let hasLiveReloadPanels = false;
  browserState.panels.forEach(panel => {
    if (panel.liveReload) hasLiveReloadPanels = true;
  });
  
  if (hasLiveReloadPanels) {
    setupLiveReloadConnection();
  }
}

// ============================================
// CSS/JS INJECTION
// ============================================

function toggleInjectionPanel(panelId) {
  let panel = document.getElementById(`injectionPanel${panelId}`);
  
  if (panel) {
    panel.classList.toggle('hidden');
    return;
  }
  
  // Create injection panel
  const browserPanel = document.querySelector(`.browser-panel[data-browser-id="${panelId}"]`);
  if (!browserPanel) return;
  
  panel = document.createElement('div');
  panel.id = `injectionPanel${panelId}`;
  panel.className = 'injection-panel';
  panel.innerHTML = `
    <div class="injection-header">
      <h3>💉 Inject CSS/JS</h3>
      <button class="injection-close" onclick="toggleInjectionPanel(${panelId})">×</button>
    </div>
    
    <div class="injection-content">
      <div class="injection-section">
        <label>CSS</label>
        <textarea id="injectCss${panelId}" placeholder="/* Your CSS here */
body { outline: 1px solid red; }
* { outline: 1px solid rgba(255,0,0,0.1) !important; }">${escapeHtml(browserState.injection.css)}</textarea>
      </div>
      
      <div class="injection-section">
        <label>JavaScript</label>
        <textarea id="injectJs${panelId}" placeholder="// Your JavaScript here
console.log('Injected!');">${escapeHtml(browserState.injection.js)}</textarea>
      </div>
      
      <div class="injection-options">
        <label class="injection-checkbox">
          <input type="checkbox" id="injectAuto${panelId}" ${browserState.injection.autoInject ? 'checked' : ''} 
                 onchange="toggleAutoInject(${panelId}, this.checked)">
          <span>Inject on every page load</span>
        </label>
      </div>
      
      <div class="injection-actions">
        <button class="injection-btn primary" onclick="applyInjection(${panelId})">
          ▶ Apply Now
        </button>
        <button class="injection-btn" onclick="saveInjectionSnippet(${panelId})">
          💾 Save Snippet
        </button>
        <button class="injection-btn" onclick="clearInjection(${panelId})">
          🗑 Clear
        </button>
      </div>
      
      ${browserState.injection.snippets.length > 0 ? `
        <div class="injection-snippets">
          <label>Saved Snippets</label>
          <div class="snippet-list">
            ${browserState.injection.snippets.map((s, i) => `
              <div class="snippet-item">
                <span onclick="loadSnippet(${panelId}, ${i})">${escapeHtml(s.name)}</span>
                <button onclick="deleteSnippet(${i})">×</button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
    </div>
  `;
  
  browserPanel.appendChild(panel);
}

function applyInjection(panelId) {
  const cssEl = document.getElementById(`injectCss${panelId}`);
  const jsEl = document.getElementById(`injectJs${panelId}`);
  
  const css = cssEl?.value || '';
  const js = jsEl?.value || '';
  
  // Save to state and localStorage
  browserState.injection.css = css;
  browserState.injection.js = js;
  localStorage.setItem('clawd-inject-css', css);
  localStorage.setItem('clawd-inject-js', js);
  
  // Inject into iframe
  injectCustomCode(panelId, css, js);
  
  showNotification('💉 Injected CSS/JS', 'success', 2000);
}

function injectCustomCode(panelId, css, js) {
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (!iframe) return;
  
  try {
    const doc = iframe.contentDocument || iframe.contentWindow.document;
    
    // Remove previous injections
    const oldStyle = doc.getElementById('clawd-injected-css');
    const oldScript = doc.getElementById('clawd-injected-js');
    if (oldStyle) oldStyle.remove();
    if (oldScript) oldScript.remove();
    
    // Inject CSS
    if (css.trim()) {
      const style = doc.createElement('style');
      style.id = 'clawd-injected-css';
      style.textContent = css;
      doc.head.appendChild(style);
    }
    
    // Inject JS
    if (js.trim()) {
      const script = doc.createElement('script');
      script.id = 'clawd-injected-js';
      script.textContent = `
        try {
          ${js}
        } catch (e) {
          console.error('Injected JS error:', e);
        }
      `;
      doc.body.appendChild(script);
    }
  } catch (e) {
    console.warn('Injection blocked (cross-origin):', e);
    showNotification('⚠️ Injection blocked (cross-origin)', 'warning', 3000);
  }
}

function toggleAutoInject(panelId, enabled) {
  browserState.injection.autoInject = enabled;
  localStorage.setItem('clawd-inject-auto', enabled.toString());
  showNotification(enabled ? '✓ Auto-inject enabled' : '✗ Auto-inject disabled', 'info', 2000);
}

function clearInjection(panelId) {
  const cssEl = document.getElementById(`injectCss${panelId}`);
  const jsEl = document.getElementById(`injectJs${panelId}`);
  
  if (cssEl) cssEl.value = '';
  if (jsEl) jsEl.value = '';
  
  browserState.injection.css = '';
  browserState.injection.js = '';
  localStorage.removeItem('clawd-inject-css');
  localStorage.removeItem('clawd-inject-js');
  
  // Remove from iframe
  const iframe = document.getElementById(`browserFrame${panelId}`);
  if (iframe) {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      const oldStyle = doc.getElementById('clawd-injected-css');
      const oldScript = doc.getElementById('clawd-injected-js');
      if (oldStyle) oldStyle.remove();
      if (oldScript) oldScript.remove();
    } catch (e) {}
  }
  
  showNotification('🗑 Injection cleared', 'info', 2000);
}

function saveInjectionSnippet(panelId) {
  const cssEl = document.getElementById(`injectCss${panelId}`);
  const jsEl = document.getElementById(`injectJs${panelId}`);
  
  const css = cssEl?.value || '';
  const js = jsEl?.value || '';
  
  if (!css.trim() && !js.trim()) {
    showNotification('Nothing to save', 'warning', 2000);
    return;
  }
  
  const name = prompt('Snippet name:', `Snippet ${browserState.injection.snippets.length + 1}`);
  if (!name) return;
  
  browserState.injection.snippets.push({ name, css, js, created: Date.now() });
  localStorage.setItem('clawd-inject-snippets', JSON.stringify(browserState.injection.snippets));
  
  // Refresh panel to show new snippet
  const panel = document.getElementById(`injectionPanel${panelId}`);
  if (panel) {
    panel.remove();
    toggleInjectionPanel(panelId);
  }
  
  showNotification(`💾 Saved: ${name}`, 'success', 2000);
}

function loadSnippet(panelId, index) {
  const snippet = browserState.injection.snippets[index];
  if (!snippet) return;
  
  const cssEl = document.getElementById(`injectCss${panelId}`);
  const jsEl = document.getElementById(`injectJs${panelId}`);
  
  if (cssEl) cssEl.value = snippet.css;
  if (jsEl) jsEl.value = snippet.js;
  
  showNotification(`📋 Loaded: ${snippet.name}`, 'info', 2000);
}

function deleteSnippet(index) {
  if (!confirm('Delete this snippet?')) return;
  
  browserState.injection.snippets.splice(index, 1);
  localStorage.setItem('clawd-inject-snippets', JSON.stringify(browserState.injection.snippets));
  
  // Refresh all injection panels
  document.querySelectorAll('[id^="injectionPanel"]').forEach(panel => {
    const panelId = parseInt(panel.id.replace('injectionPanel', ''));
    panel.remove();
    toggleInjectionPanel(panelId);
  });
  
  showNotification('🗑 Snippet deleted', 'info', 2000);
}

// Auto-inject on frame load (modify existing onBrowserFrameLoad)
const originalOnBrowserFrameLoad = onBrowserFrameLoad;
window.onBrowserFrameLoad = function(panelId) {
  originalOnBrowserFrameLoad(panelId);
  
  // Auto-inject if enabled
  if (browserState.injection.autoInject && (browserState.injection.css || browserState.injection.js)) {
    setTimeout(() => {
      injectCustomCode(panelId, browserState.injection.css, browserState.injection.js);
    }, 100); // Small delay to ensure page is ready
  }
};

// Export functions
window.createBrowserPanel = createBrowserPanel;
window.browserNavigate = browserNavigate;
window.browserBack = browserBack;
window.browserForward = browserForward;
window.browserReload = browserReload;
window.onBrowserFrameLoad = onBrowserFrameLoad;
window.toggleBrowserDevTools = toggleBrowserDevTools;
window.switchDevToolsTab = switchDevToolsTab;
window.clearBrowserConsole = clearBrowserConsole;
window.clearBrowserNetwork = clearBrowserNetwork;
window.executeConsole = executeConsole;
window.toggleBrowserResponsive = toggleBrowserResponsive;
window.setBrowserDevice = setBrowserDevice;
window.setBrowserViewport = setBrowserViewport;
window.setBrowserScale = setBrowserScale;
window.browserScreenshot = browserScreenshot;
window.closeBrowserPanel = closeBrowserPanel;
window.openBrowserInPane = openBrowserInPane;
window.startLivePreview = startLivePreview;
window.refreshElementsPanel = refreshElementsPanel;
window.toggleElementNode = toggleElementNode;
window.setupLiveReloadConnection = setupLiveReloadConnection;
window.initLiveReload = initLiveReload;
window.toggleInjectionPanel = toggleInjectionPanel;
window.applyInjection = applyInjection;
window.clearInjection = clearInjection;
window.saveInjectionSnippet = saveInjectionSnippet;
window.loadSnippet = loadSnippet;
window.deleteSnippet = deleteSnippet;
window.toggleAutoInject = toggleAutoInject;

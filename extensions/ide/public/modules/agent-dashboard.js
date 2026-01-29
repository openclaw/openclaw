// ============================================
// AGENT DASHBOARD MODULE - Multi-Agent Management UI
// ============================================
// Surfaces existing DNA sessions_spawn/sessions_list in the IDE

const agentDashboardState = {
  agents: [],
  activeAgentId: null,
  pollInterval: null,
  isExpanded: false,
  models: [
    { id: 'kimi', name: 'Kimi K2.5', description: 'Default, good all-rounder' },
    { id: 'gpt5', name: 'GPT-5.2', description: 'Research & summarization' },
    { id: 'glm', name: 'GLM-4.7', description: 'Alternative, cost-effective' },
    { id: 'opus', name: 'Claude Opus', description: 'Complex reasoning' },
  ],
  defaultModel: 'kimi',
};

/**
 * Initialize agent dashboard
 */
function initAgentDashboard() {
  // Initial fetch
  refreshAgentList();
  
  // Poll for updates every 10 seconds
  agentDashboardState.pollInterval = setInterval(refreshAgentList, 10000);
  
  console.log('🤖 Agent dashboard initialized');
}

/**
 * Refresh the list of active agents
 */
async function refreshAgentList() {
  try {
    const response = await fetch('/api/agents/list');
    const data = await response.json();
    
    if (data.error) {
      console.error('Failed to fetch agents:', data.error);
      return;
    }
    
    agentDashboardState.agents = data.sessions || [];
    renderAgentList();
    
  } catch (error) {
    console.error('Agent list fetch error:', error);
  }
}

/**
 * Render the agent list in the sidebar
 */
function renderAgentList() {
  const container = document.getElementById('agentDashboardList');
  if (!container) return;
  
  const agents = agentDashboardState.agents;
  
  if (!agents || agents.length === 0) {
    container.innerHTML = `
      <div class="agent-dashboard-empty">
        <span class="empty-icon">🤖</span>
        <span class="empty-text">No active agents</span>
        <button class="agent-spawn-btn" onclick="showSpawnAgentModal()">
          + Spawn Agent
        </button>
      </div>
    `;
    return;
  }
  
  let html = '';
  
  for (const agent of agents) {
    const statusIcon = getAgentStatusIcon(agent.status);
    const statusClass = agent.status?.toLowerCase() || 'unknown';
    const model = agent.model?.split('/').pop() || 'unknown';
    const elapsed = formatElapsed(agent.startTime);
    
    html += `
      <div class="agent-dashboard-item ${statusClass} ${agent.sessionKey === agentDashboardState.activeAgentId ? 'active' : ''}"
           onclick="selectAgent('${escapeHtml(agent.sessionKey)}')">
        <div class="agent-item-header">
          <span class="agent-item-status">${statusIcon}</span>
          <span class="agent-item-label">${escapeHtml(agent.label || agent.sessionKey.slice(0, 12))}</span>
        </div>
        <div class="agent-item-info">
          <span class="agent-item-model">${escapeHtml(model)}</span>
          <span class="agent-item-time">${elapsed}</span>
        </div>
        <div class="agent-item-task">${escapeHtml(truncate(agent.task || '', 50))}</div>
        <div class="agent-item-actions">
          <button onclick="event.stopPropagation(); viewAgentHistory('${escapeHtml(agent.sessionKey)}')" title="View output">👁</button>
          <button onclick="event.stopPropagation(); killAgent('${escapeHtml(agent.sessionKey)}')" title="Stop agent">⏹</button>
        </div>
      </div>
    `;
  }
  
  html += `
    <button class="agent-spawn-btn-inline" onclick="showSpawnAgentModal()">
      + Spawn New Agent
    </button>
  `;
  
  container.innerHTML = html;
  
  // Update badge
  updateAgentBadge(agents.filter(a => a.status === 'running').length);
}

/**
 * Show the spawn agent modal
 */
function showSpawnAgentModal() {
  let modal = document.getElementById('spawnAgentModal');
  
  if (!modal) {
    modal = createSpawnAgentModal();
    document.body.appendChild(modal);
  }
  
  modal.classList.remove('hidden');
  
  // Focus task input
  document.getElementById('spawnAgentTask')?.focus();
}

/**
 * Create the spawn agent modal
 */
function createSpawnAgentModal() {
  const modal = document.createElement('div');
  modal.id = 'spawnAgentModal';
  modal.className = 'spawn-agent-modal hidden';
  
  const modelOptions = agentDashboardState.models.map(m => 
    `<option value="${m.id}" ${m.id === agentDashboardState.defaultModel ? 'selected' : ''}>${m.name}</option>`
  ).join('');
  
  modal.innerHTML = `
    <div class="spawn-agent-overlay" onclick="hideSpawnAgentModal()"></div>
    <div class="spawn-agent-content">
      <div class="spawn-agent-header">
        <span class="spawn-agent-icon">🤖</span>
        <span class="spawn-agent-title">Spawn Sub-Agent</span>
        <button class="spawn-agent-close" onclick="hideSpawnAgentModal()">×</button>
      </div>
      
      <div class="spawn-agent-body">
        <div class="spawn-agent-field">
          <label for="spawnAgentTask">Task Description</label>
          <textarea 
            id="spawnAgentTask" 
            placeholder="Describe what you want the agent to do...&#10;&#10;Example: Research best practices for React authentication and summarize in a markdown doc"
            rows="4"
          ></textarea>
        </div>
        
        <div class="spawn-agent-row">
          <div class="spawn-agent-field">
            <label for="spawnAgentLabel">Label (optional)</label>
            <input type="text" id="spawnAgentLabel" placeholder="e.g., research-auth" />
          </div>
          
          <div class="spawn-agent-field">
            <label for="spawnAgentModel">Model</label>
            <select id="spawnAgentModel">
              ${modelOptions}
            </select>
          </div>
        </div>
        
        <div class="spawn-agent-field">
          <label for="spawnAgentTimeout">Timeout (seconds)</label>
          <input type="number" id="spawnAgentTimeout" value="300" min="30" max="3600" />
        </div>
        
        <div class="spawn-agent-hint">
          Sub-agents run in isolated sessions. Results are delivered when complete.
        </div>
      </div>
      
      <div class="spawn-agent-footer">
        <button class="spawn-agent-btn secondary" onclick="hideSpawnAgentModal()">Cancel</button>
        <button class="spawn-agent-btn primary" onclick="spawnAgent()">
          <span>▶</span> Spawn Agent
        </button>
      </div>
    </div>
  `;
  
  return modal;
}

/**
 * Hide spawn agent modal
 */
function hideSpawnAgentModal() {
  const modal = document.getElementById('spawnAgentModal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

/**
 * Spawn a new sub-agent
 */
async function spawnAgent() {
  const task = document.getElementById('spawnAgentTask')?.value?.trim();
  const label = document.getElementById('spawnAgentLabel')?.value?.trim();
  const model = document.getElementById('spawnAgentModel')?.value;
  const timeout = parseInt(document.getElementById('spawnAgentTimeout')?.value) || 300;
  
  if (!task) {
    showNotification('Please enter a task description', 'warning');
    return;
  }
  
  hideSpawnAgentModal();
  
  showNotification('🤖 Spawning agent...', 'info');
  
  try {
    const response = await fetch('/api/agents/spawn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task,
        label: label || undefined,
        model: model || undefined,
        timeoutSeconds: timeout
      })
    });
    
    const result = await response.json();
    
    if (result.error) {
      showNotification(`⚠ Failed to spawn agent: ${result.error}`, 'error');
      return;
    }
    
    showNotification(`✓ Agent spawned: ${result.label || result.sessionKey?.slice(0, 12)}`, 'success');
    
    // Refresh list
    await refreshAgentList();
    
    // Clear form
    if (document.getElementById('spawnAgentTask')) {
      document.getElementById('spawnAgentTask').value = '';
      document.getElementById('spawnAgentLabel').value = '';
    }
    
  } catch (error) {
    console.error('Spawn agent error:', error);
    showNotification(`⚠ Error: ${error.message}`, 'error');
  }
}

/**
 * Select an agent to view details
 * @param {string} sessionKey - Agent session key
 */
async function selectAgent(sessionKey) {
  agentDashboardState.activeAgentId = sessionKey;
  renderAgentList();
  
  // Show agent details panel
  await showAgentDetails(sessionKey);
}

/**
 * Show agent details in a panel
 * @param {string} sessionKey - Agent session key
 */
async function showAgentDetails(sessionKey) {
  const agent = agentDashboardState.agents.find(a => a.sessionKey === sessionKey);
  if (!agent) return;
  
  // Fetch full history
  const history = await fetchAgentHistory(sessionKey);
  
  const detailsPanel = document.getElementById('agentDetailsPanel');
  if (detailsPanel) {
    detailsPanel.innerHTML = renderAgentDetailsHTML(agent, history);
    detailsPanel.classList.remove('hidden');
  }
}

/**
 * View agent history/output
 * @param {string} sessionKey - Agent session key
 */
async function viewAgentHistory(sessionKey) {
  const history = await fetchAgentHistory(sessionKey);
  
  // Show in modal or panel
  const agent = agentDashboardState.agents.find(a => a.sessionKey === sessionKey);
  const label = agent?.label || sessionKey.slice(0, 12);
  
  let html = `
    <div class="agent-history-view">
      <div class="agent-history-header">
        <span>📜 Output: ${escapeHtml(label)}</span>
      </div>
      <div class="agent-history-content">
  `;
  
  if (history?.messages?.length > 0) {
    for (const msg of history.messages) {
      const role = msg.role === 'assistant' ? '🤖' : '👤';
      html += `
        <div class="agent-history-message ${msg.role}">
          <span class="msg-role">${role}</span>
          <div class="msg-content">${escapeHtml(msg.content || '').replace(/\n/g, '<br>')}</div>
        </div>
      `;
    }
  } else {
    html += '<div class="agent-history-empty">No output yet</div>';
  }
  
  html += '</div></div>';
  
  if (typeof showModal === 'function') {
    showModal(`Agent Output: ${label}`, html);
  } else {
    // Fallback: show in console
    console.log('Agent history:', history);
  }
}

/**
 * Fetch agent history from API
 * @param {string} sessionKey - Agent session key
 */
async function fetchAgentHistory(sessionKey) {
  try {
    const response = await fetch(`/api/agents/history?sessionKey=${encodeURIComponent(sessionKey)}`);
    return await response.json();
  } catch (error) {
    console.error('Fetch history error:', error);
    return { messages: [] };
  }
}

/**
 * Kill/stop an agent
 * @param {string} sessionKey - Agent session key
 */
async function killAgent(sessionKey) {
  if (!confirm('Stop this agent?')) return;
  
  try {
    const response = await fetch('/api/agents/kill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey })
    });
    
    const result = await response.json();
    
    if (result.error) {
      showNotification(`⚠ Failed to stop agent: ${result.error}`, 'error');
      return;
    }
    
    showNotification('✓ Agent stopped', 'success');
    await refreshAgentList();
    
  } catch (error) {
    console.error('Kill agent error:', error);
    showNotification(`⚠ Error: ${error.message}`, 'error');
  }
}

/**
 * Get status icon for agent
 * @param {string} status - Agent status
 */
function getAgentStatusIcon(status) {
  const icons = {
    running: '▶',
    completed: '✓',
    error: '✗',
    pending: '○',
    cancelled: '⊘',
  };
  return icons[status?.toLowerCase()] || '?';
}

/**
 * Update the agent count badge
 * @param {number} count - Number of running agents
 */
function updateAgentBadge(count) {
  const badge = document.getElementById('agentDashboardBadge');
  if (badge) {
    badge.textContent = count || '';
    badge.classList.toggle('hidden', count === 0);
  }
}

/**
 * Format elapsed time
 * @param {number} startTime - Start timestamp
 */
function formatElapsed(startTime) {
  if (!startTime) return '';
  
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

/**
 * Truncate text
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Max length
 */
function truncate(text, maxLength) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

/**
 * Escape HTML
 */
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render agent details HTML
 */
function renderAgentDetailsHTML(agent, history) {
  return `
    <div class="agent-details">
      <div class="agent-details-header">
        <span class="agent-details-label">${escapeHtml(agent.label || agent.sessionKey)}</span>
        <span class="agent-details-status ${agent.status}">${agent.status}</span>
      </div>
      <div class="agent-details-task">${escapeHtml(agent.task || 'No task')}</div>
      <div class="agent-details-meta">
        <span>Model: ${escapeHtml(agent.model || 'unknown')}</span>
        <span>Started: ${formatElapsed(agent.startTime)} ago</span>
      </div>
    </div>
  `;
}

/**
 * Toggle agent dashboard panel
 */
function toggleAgentDashboard() {
  const panel = document.getElementById('panel-agents');
  if (panel) {
    agentDashboardState.isExpanded = !panel.classList.contains('hidden');
  }
  switchPanel('agents');
}

// Export functions
window.initAgentDashboard = initAgentDashboard;
window.refreshAgentList = refreshAgentList;
window.showSpawnAgentModal = showSpawnAgentModal;
window.hideSpawnAgentModal = hideSpawnAgentModal;
window.spawnAgent = spawnAgent;
window.selectAgent = selectAgent;
window.viewAgentHistory = viewAgentHistory;
window.killAgent = killAgent;
window.toggleAgentDashboard = toggleAgentDashboard;

// Initialize on load
document.addEventListener('DOMContentLoaded', initAgentDashboard);

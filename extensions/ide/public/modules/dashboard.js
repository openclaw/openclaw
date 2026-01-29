// ============================================
// PROJECT DASHBOARD MODULE
// ============================================
// Overview of project stats, TODOs, git activity

const Dashboard = {
  stats: null,
  lastRefresh: 0,
  CACHE_TTL: 60000, // 1 minute cache
  
  async init() {
    console.log('[Dashboard] Initialized');
  },
  
  /**
   * Fetch project statistics
   */
  async fetchStats(force = false) {
    // Use cache if fresh
    if (!force && this.stats && (Date.now() - this.lastRefresh) < this.CACHE_TTL) {
      return this.stats;
    }
    
    try {
      const res = await fetch('/api/dashboard/stats');
      const data = await res.json();
      
      if (!data.error) {
        this.stats = data;
        this.lastRefresh = Date.now();
      }
      
      return this.stats;
    } catch (err) {
      console.error('[Dashboard] Failed to fetch stats:', err);
      return null;
    }
  },
  
  /**
   * Get project statistics
   */
  getStats() {
    return this.stats;
  }
};

/**
 * Show the dashboard panel
 */
async function showDashboard() {
  const panel = document.getElementById('panel-dashboard');
  if (!panel) {
    console.error('[Dashboard] Panel not found');
    return;
  }
  
  // Show loading state
  panel.innerHTML = `
    <div class="dashboard-loading">
      <div class="loading-spinner"></div>
      <span>Loading project stats...</span>
    </div>
  `;
  
  // Switch to dashboard panel
  switchPanel('dashboard');
  
  // Fetch stats
  const stats = await Dashboard.fetchStats(true);
  
  if (!stats) {
    panel.innerHTML = `
      <div class="dashboard-error">
        <p>Failed to load project statistics</p>
        <button onclick="showDashboard()">Retry</button>
      </div>
    `;
    return;
  }
  
  // Render dashboard
  renderDashboard(panel, stats);
}

/**
 * Render dashboard content
 */
function renderDashboard(panel, stats) {
  const { project, files, git, todos, performance } = stats;
  
  let html = `
    <div class="dashboard-container">
      <!-- Project Header -->
      <div class="dashboard-header">
        <h2>📊 ${escapeHtml(project?.name || 'Project Dashboard')}</h2>
        <button class="dashboard-refresh" onclick="showDashboard()" title="Refresh">↻</button>
      </div>
      
      <!-- Stats Grid -->
      <div class="dashboard-stats-grid">
        <div class="stat-card">
          <div class="stat-icon">📄</div>
          <div class="stat-value">${formatNumber(files?.total || 0)}</div>
          <div class="stat-label">Files</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">📝</div>
          <div class="stat-value">${formatNumber(files?.lines || 0)}</div>
          <div class="stat-label">Lines of Code</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">✅</div>
          <div class="stat-value">${todos?.total || 0}</div>
          <div class="stat-label">TODOs</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">⚡</div>
          <div class="stat-value">${git?.commits7d || 0}</div>
          <div class="stat-label">Commits (7d)</div>
        </div>
      </div>
      
      <!-- Git Activity -->
      <div class="dashboard-section">
        <h3>📈 Recent Activity</h3>
        <div class="git-activity">
  `;
  
  if (git?.recentCommits?.length > 0) {
    html += '<div class="commit-list">';
    git.recentCommits.slice(0, 5).forEach(commit => {
      const date = new Date(commit.date);
      const relativeTime = getRelativeTime(date);
      html += `
        <div class="commit-item">
          <span class="commit-hash" title="${escapeHtml(commit.hash)}">${escapeHtml(commit.hash.substring(0, 7))}</span>
          <span class="commit-message">${escapeHtml(truncate(commit.message, 50))}</span>
          <span class="commit-time" title="${date.toLocaleString()}">${relativeTime}</span>
        </div>
      `;
    });
    html += '</div>';
  } else {
    html += '<p class="no-data">No recent commits</p>';
  }
  
  html += `
        </div>
      </div>
      
      <!-- File Types -->
      <div class="dashboard-section">
        <h3>📁 File Types</h3>
        <div class="file-types">
  `;
  
  if (files?.byType && Object.keys(files.byType).length > 0) {
    const sortedTypes = Object.entries(files.byType)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    
    const maxCount = sortedTypes[0]?.[1] || 1;
    
    html += '<div class="file-type-bars">';
    sortedTypes.forEach(([ext, count]) => {
      const percent = Math.round((count / maxCount) * 100);
      const icon = getFileTypeIcon(ext);
      html += `
        <div class="file-type-row">
          <span class="file-type-label">${icon} ${ext || 'no ext'}</span>
          <div class="file-type-bar-bg">
            <div class="file-type-bar" style="width: ${percent}%"></div>
          </div>
          <span class="file-type-count">${count}</span>
        </div>
      `;
    });
    html += '</div>';
  } else {
    html += '<p class="no-data">No files analyzed</p>';
  }
  
  html += `
        </div>
      </div>
      
      <!-- TODOs -->
      <div class="dashboard-section">
        <h3>📋 TODOs & FIXMEs</h3>
        <div class="todos-list">
  `;
  
  if (todos?.items?.length > 0) {
    html += '<div class="todo-items">';
    todos.items.slice(0, 8).forEach(todo => {
      const typeClass = todo.type.toLowerCase();
      html += `
        <div class="todo-item ${typeClass}" onclick="openFile('${escapeHtml(todo.file)}', false).then(() => goToLine(${todo.line}))">
          <span class="todo-type">${todo.type}</span>
          <span class="todo-text">${escapeHtml(truncate(todo.text, 60))}</span>
          <span class="todo-location">${escapeHtml(getFileName(todo.file))}:${todo.line}</span>
        </div>
      `;
    });
    html += '</div>';
    
    if (todos.total > 8) {
      html += `<p class="todos-more">And ${todos.total - 8} more...</p>`;
    }
  } else {
    html += '<p class="no-data">No TODOs found 🎉</p>';
  }
  
  html += `
        </div>
      </div>
      
      <!-- Quick Access -->
      <div class="dashboard-section">
        <h3>⚡ Quick Access</h3>
        <div class="quick-access">
          ${files?.keyFiles?.map(f => `
            <button class="quick-file" onclick="openFile('${escapeHtml(f.path)}', false)" title="${escapeHtml(f.path)}">
              ${getFileIcon(f.path)} ${escapeHtml(f.name)}
            </button>
          `).join('') || '<p class="no-data">No key files detected</p>'}
        </div>
      </div>
      
      <div class="dashboard-footer">
        <span>Last updated: ${new Date().toLocaleTimeString()}</span>
      </div>
    </div>
  `;
  
  panel.innerHTML = html;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function formatNumber(num) {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
}

function truncate(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len - 3) + '...' : str;
}

function escapeHtml(text) {
  if (typeof text !== 'string') return String(text);
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getFileName(path) {
  return path.split('/').pop();
}

function getRelativeTime(date) {
  const now = Date.now();
  const diff = now - date.getTime();
  
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function getFileTypeIcon(ext) {
  const icons = {
    'js': '🟨',
    'ts': '🔷',
    'jsx': '⚛️',
    'tsx': '⚛️',
    'json': '📋',
    'md': '📝',
    'css': '🎨',
    'html': '🌐',
    'py': '🐍',
    'go': '🐹',
    'rs': '🦀',
    'sh': '📜',
    'yml': '⚙️',
    'yaml': '⚙️',
  };
  return icons[ext] || '📄';
}

function getFileIcon(path) {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  return getFileTypeIcon(ext);
}

// ============================================
// EXPORTS
// ============================================

window.Dashboard = Dashboard;
window.showDashboard = showDashboard;

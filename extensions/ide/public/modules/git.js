// ============================================
// GIT MODULE - Enhanced with staging & remote ops
// ============================================
// Depends on: state (global), showNotification

// Git state
const gitState = {
  staged: [],
  unstaged: [],
  untracked: [],
  ahead: 0,
  behind: 0,
};

async function loadGitStatus() {
  try {
    const res = await fetch('/api/git/status');
    const data = await res.json();
    
    // Update status bar
    if (data.branch) {
      state.git.branch = data.branch;
      document.getElementById('statusBranch').textContent = data.branch;
    }
    
    const gitStatus = document.getElementById('gitStatus');
    
    if (data.error) {
      gitStatus.innerHTML = `<p style="padding: 15px; color: #888;">${data.error}</p>`;
      return;
    }
    
    // Parse changes into staged/unstaged/untracked
    gitState.staged = [];
    gitState.unstaged = [];
    gitState.untracked = [];
    
    for (const change of data.changes) {
      const indexStatus = change.status[0];
      const workStatus = change.status[1] || ' ';
      
      if (indexStatus === '?') {
        gitState.untracked.push({ ...change, status: '?' });
      } else {
        if (indexStatus !== ' ') {
          gitState.staged.push({ ...change, status: indexStatus });
        }
        if (workStatus !== ' ' && workStatus !== '?') {
          gitState.unstaged.push({ ...change, status: workStatus });
        }
      }
    }
    
    renderGitPanel(data.branch);
    
    // Fetch remote status in background
    fetchRemoteStatus();
    
  } catch (err) {
    console.error('Git status error:', err);
  }
}

async function fetchRemoteStatus() {
  try {
    const res = await fetch('/api/git/remote-status');
    const data = await res.json();
    gitState.ahead = data.ahead || 0;
    gitState.behind = data.behind || 0;
    updateRemoteIndicators();
  } catch (e) {
    // Ignore remote status errors
  }
}

function updateRemoteIndicators() {
  const indicators = [];
  if (gitState.ahead > 0) indicators.push(`↑${gitState.ahead}`);
  if (gitState.behind > 0) indicators.push(`↓${gitState.behind}`);
  
  const branchEl = document.getElementById('statusBranch');
  if (branchEl && indicators.length > 0) {
    branchEl.textContent = `${state.git.branch} ${indicators.join(' ')}`;
  }
}

async function renderGitPanel(branch) {
  const gitStatus = document.getElementById('gitStatus');
  const totalChanges = gitState.staged.length + gitState.unstaged.length + gitState.untracked.length;
  
  // Load stashes in background
  const stashes = await loadStashes();
  
  let html = `
    <div class="git-panel">
      <!-- Branch & Remote Actions -->
      <div class="git-header">
        <div class="git-branch" onclick="showBranchPicker()" title="Click to switch branch">
          <span class="git-branch-icon">⎇</span>
          <strong>${branch}</strong>
          <span class="git-branch-dropdown">▾</span>
          ${gitState.ahead > 0 ? `<span class="git-ahead">↑${gitState.ahead}</span>` : ''}
          ${gitState.behind > 0 ? `<span class="git-behind">↓${gitState.behind}</span>` : ''}
        </div>
        <div class="git-remote-actions">
          <button onclick="gitFetch()" title="Fetch">↻</button>
          <button onclick="gitPull()" title="Pull" ${gitState.behind === 0 ? 'disabled' : ''}>↓</button>
          <button onclick="gitPush()" title="Push" ${gitState.ahead === 0 ? 'disabled' : ''}>↑</button>
        </div>
      </div>
  `;
  
  if (totalChanges === 0) {
    html += '<p class="git-empty">✓ No pending changes</p>';
  } else {
    // Commit section at top
    html += `
      <div class="git-commit-section">
        <div class="git-commit-input">
          <input type="text" id="commitMessage" placeholder="Commit message...">
          <button onclick="generateCommitMessage()" title="Generate with AI" class="git-ai-btn">🐾</button>
        </div>
        <button onclick="gitCommit()" class="git-commit-btn" ${gitState.staged.length === 0 ? 'disabled' : ''}>
          Commit${gitState.staged.length > 0 ? ` (${gitState.staged.length})` : ''}
        </button>
      </div>
    `;
    
    // Staged changes
    if (gitState.staged.length > 0) {
      html += `
        <div class="git-section">
          <div class="git-section-header">
            <span>Staged Changes (${gitState.staged.length})</span>
            <button onclick="gitUnstageAll()" class="git-section-btn" title="Unstage all">−</button>
          </div>
          <div class="git-changes">
            ${gitState.staged.map(c => renderGitChange(c, 'staged')).join('')}
          </div>
        </div>
      `;
    }
    
    // Unstaged changes
    if (gitState.unstaged.length > 0) {
      html += `
        <div class="git-section">
          <div class="git-section-header">
            <span>Changes (${gitState.unstaged.length})</span>
            <button onclick="gitStageAll()" class="git-section-btn" title="Stage all">+</button>
          </div>
          <div class="git-changes">
            ${gitState.unstaged.map(c => renderGitChange(c, 'unstaged')).join('')}
          </div>
        </div>
      `;
    }
    
    // Untracked files
    if (gitState.untracked.length > 0) {
      html += `
        <div class="git-section">
          <div class="git-section-header">
            <span>Untracked (${gitState.untracked.length})</span>
            <button onclick="gitStageAll()" class="git-section-btn" title="Stage all">+</button>
          </div>
          <div class="git-changes">
            ${gitState.untracked.map(c => renderGitChange(c, 'untracked')).join('')}
          </div>
        </div>
      `;
    }
    
    // Stash button when there are changes
    html += `
      <div class="git-stash-action">
        <button onclick="gitStashSave()" class="git-stash-btn" title="Stash all changes">
          📦 Stash Changes
        </button>
      </div>
    `;
  }
  
  // Stashes section
  if (stashes.length > 0) {
    html += `
      <div class="git-section git-stashes">
        <div class="git-section-header">
          <span>Stashes (${stashes.length})</span>
        </div>
        <div class="git-stash-list">
          ${stashes.map(s => `
            <div class="git-stash-item">
              <span class="git-stash-msg">${s.message}</span>
              <div class="git-stash-actions">
                <button onclick="gitStashApply(${s.index}, true)" title="Pop (apply + drop)">↑</button>
                <button onclick="gitStashApply(${s.index}, false)" title="Apply (keep stash)">↳</button>
                <button onclick="gitStashDrop(${s.index})" title="Drop" class="git-stash-drop">🗑</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }
  
  html += '</div>';
  gitStatus.innerHTML = html;
}

function renderGitChange(change, type) {
  const statusColors = { 
    'M': 'var(--modified)', 
    'A': 'var(--added)', 
    'D': 'var(--deleted)', 
    '?': 'var(--text-secondary)', 
    'U': 'var(--info)',
    'R': 'var(--info)'
  };
  const color = statusColors[change.status] || 'var(--text-secondary)';
  const escapedFile = change.file.replace(/'/g, "\\'");
  
  let actions = '';
  if (type === 'staged') {
    actions = `
      <button onclick="gitUnstage('${escapedFile}')" title="Unstage" class="git-file-btn">−</button>
    `;
  } else if (type === 'unstaged') {
    actions = `
      <button onclick="gitStage('${escapedFile}')" title="Stage" class="git-file-btn">+</button>
      <button onclick="gitDiscard('${escapedFile}')" title="Discard changes" class="git-file-btn git-discard">↩</button>
    `;
  } else {
    actions = `
      <button onclick="gitStage('${escapedFile}')" title="Stage" class="git-file-btn">+</button>
    `;
  }
  
  return `
    <div class="git-change">
      <span class="git-status-badge" style="color: ${color};">${change.status}</span>
      <span class="git-file" onclick="openFile('${state.workspace}/${escapedFile}')">${change.file}</span>
      <div class="git-file-actions">${actions}</div>
    </div>
  `;
}

// Stage operations
async function gitStage(file) {
  try {
    const res = await fetch('/api/git/stage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const data = await res.json();
    if (data.success) {
      loadGitStatus();
    } else {
      showNotification('Failed to stage file', 'error');
    }
  } catch (err) {
    showNotification('Failed to stage file', 'error');
  }
}

async function gitUnstage(file) {
  try {
    const res = await fetch('/api/git/unstage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const data = await res.json();
    if (data.success) {
      loadGitStatus();
    } else {
      showNotification('Failed to unstage file', 'error');
    }
  } catch (err) {
    showNotification('Failed to unstage file', 'error');
  }
}

async function gitStageAll() {
  try {
    const res = await fetch('/api/git/stage-all', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      loadGitStatus();
    }
  } catch (err) {
    showNotification('Failed to stage files', 'error');
  }
}

async function gitUnstageAll() {
  try {
    const res = await fetch('/api/git/unstage-all', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      loadGitStatus();
    }
  } catch (err) {
    showNotification('Failed to unstage files', 'error');
  }
}

async function gitDiscard(file) {
  if (!confirm(`Discard changes to ${file}? This cannot be undone.`)) return;
  
  try {
    const res = await fetch('/api/git/discard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const data = await res.json();
    if (data.success) {
      showNotification('Changes discarded', 'success');
      loadGitStatus();
    } else {
      showNotification('Failed to discard changes', 'error');
    }
  } catch (err) {
    showNotification('Failed to discard changes', 'error');
  }
}

// Remote operations
async function gitPush() {
  showNotification('Pushing...', 'info');
  try {
    const res = await fetch('/api/git/push', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showNotification('Pushed successfully!', 'success');
      loadGitStatus();
    } else {
      showNotification(`Push failed: ${data.output || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showNotification('Push failed', 'error');
  }
}

async function gitPull() {
  showNotification('Pulling...', 'info');
  try {
    const res = await fetch('/api/git/pull', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showNotification('Pulled successfully!', 'success');
      loadGitStatus();
    } else {
      showNotification(`Pull failed: ${data.output || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showNotification('Pull failed', 'error');
  }
}

async function gitFetch() {
  showNotification('Fetching...', 'info');
  try {
    const res = await fetch('/api/git/fetch', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showNotification('Fetched successfully!', 'success');
      fetchRemoteStatus();
    } else {
      showNotification('Fetch failed', 'error');
    }
  } catch (err) {
    showNotification('Fetch failed', 'error');
  }
}

// Commit with only staged files
async function gitCommit() {
  const messageInput = document.getElementById('commitMessage');
  const message = messageInput.value.trim();
  
  if (!message) {
    showNotification('Enter a commit message', 'error');
    return;
  }
  
  if (gitState.staged.length === 0) {
    showNotification('No staged changes to commit', 'error');
    return;
  }
  
  try {
    // Commit only staged files (don't add -A)
    const res = await fetch('/api/git/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, stagedOnly: true })
    });
    
    const data = await res.json();
    if (data.success) {
      showNotification('Changes committed!', 'success');
      messageInput.value = '';
      loadGitStatus();
    } else {
      showNotification('Commit failed', 'error');
    }
  } catch (err) {
    showNotification('Commit failed', 'error');
  }
}

async function generateCommitMessage() {
  const messageInput = document.getElementById('commitMessage');
  const generateBtn = event?.target || document.querySelector('.git-ai-btn');
  
  if (generateBtn) {
    generateBtn.disabled = true;
    generateBtn.textContent = '...';
  }
  
  try {
    const res = await fetch('/api/git/generate-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    
    const data = await res.json();
    
    if (data.message) {
      messageInput.value = data.message;
      showNotification('Commit message generated!', 'success');
    } else if (data.error) {
      showNotification(data.error, 'error');
    }
  } catch (err) {
    showNotification('Failed to generate message', 'error');
  } finally {
    if (generateBtn) {
      generateBtn.disabled = false;
      generateBtn.textContent = '🐾';
    }
  }
}

// ============================================
// BRANCH MANAGEMENT
// ============================================

async function loadBranches() {
  try {
    const res = await fetch('/api/git/branches');
    const data = await res.json();
    return data.branches || [];
  } catch (err) {
    console.error('Failed to load branches:', err);
    return [];
  }
}

async function showBranchPicker() {
  const branches = await loadBranches();
  const currentBranch = state.git.branch;
  
  // Create modal
  const modal = document.createElement('div');
  modal.className = 'git-branch-modal';
  modal.innerHTML = `
    <div class="git-branch-picker">
      <div class="git-branch-picker-header">
        <input type="text" id="branchSearch" placeholder="Search or create branch..." autofocus>
        <button onclick="closeBranchPicker()" class="git-branch-close">×</button>
      </div>
      <div class="git-branch-list" id="branchList">
        ${branches.map(b => `
          <div class="git-branch-item ${b.current ? 'current' : ''}" 
               onclick="gitCheckout('${b.name}')"
               data-branch="${b.name.toLowerCase()}">
            <span class="git-branch-indicator">${b.current ? '●' : '○'}</span>
            <span class="git-branch-name">${b.name}</span>
            ${b.isRemote ? '<span class="git-branch-remote">remote</span>' : ''}
            ${!b.current && !b.isRemote ? `<button onclick="event.stopPropagation(); gitDeleteBranch('${b.name}')" class="git-branch-delete" title="Delete branch">🗑</button>` : ''}
          </div>
        `).join('')}
      </div>
      <div class="git-branch-create" id="branchCreate" style="display: none;">
        <button onclick="gitCreateBranch()" class="git-branch-create-btn">
          Create branch: <span id="newBranchName"></span>
        </button>
      </div>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Setup search/filter
  const searchInput = document.getElementById('branchSearch');
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    const items = document.querySelectorAll('.git-branch-item');
    let hasMatch = false;
    
    items.forEach(item => {
      const matches = item.dataset.branch.includes(query);
      item.style.display = matches ? '' : 'none';
      if (matches) hasMatch = true;
    });
    
    // Show create option if no exact match
    const createSection = document.getElementById('branchCreate');
    const exactMatch = branches.some(b => b.name.toLowerCase() === query);
    if (query && !exactMatch) {
      createSection.style.display = 'block';
      document.getElementById('newBranchName').textContent = query;
    } else {
      createSection.style.display = 'none';
    }
  });
  
  // Close on escape
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeBranchPicker();
    if (e.key === 'Enter') {
      const query = e.target.value.trim();
      if (query) {
        const exactMatch = branches.find(b => b.name.toLowerCase() === query.toLowerCase());
        if (exactMatch) {
          gitCheckout(exactMatch.name);
        } else {
          gitCreateBranch(query);
        }
      }
    }
  });
  
  // Close on click outside
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeBranchPicker();
  });
}

function closeBranchPicker() {
  const modal = document.querySelector('.git-branch-modal');
  if (modal) modal.remove();
}

async function gitCheckout(branch) {
  closeBranchPicker();
  showNotification(`Switching to ${branch}...`, 'info');
  
  try {
    const res = await fetch('/api/git/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch })
    });
    const data = await res.json();
    
    if (data.success) {
      showNotification(`Switched to ${branch}`, 'success');
      loadGitStatus();
    } else {
      showNotification(`Failed to switch: ${data.output || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showNotification('Failed to switch branch', 'error');
  }
}

async function gitCreateBranch(name) {
  const branchName = name || document.getElementById('branchSearch')?.value.trim();
  if (!branchName) return;
  
  closeBranchPicker();
  showNotification(`Creating branch ${branchName}...`, 'info');
  
  try {
    const res = await fetch('/api/git/branch/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: branchName, checkout: true })
    });
    const data = await res.json();
    
    if (data.success) {
      showNotification(`Created and switched to ${branchName}`, 'success');
      loadGitStatus();
    } else {
      showNotification(`Failed to create branch: ${data.output || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showNotification('Failed to create branch', 'error');
  }
}

async function gitDeleteBranch(name) {
  if (!confirm(`Delete branch "${name}"?`)) return;
  
  try {
    const res = await fetch('/api/git/branch/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await res.json();
    
    if (data.success) {
      showNotification(`Deleted branch ${name}`, 'success');
      // Refresh branch picker if open
      const modal = document.querySelector('.git-branch-modal');
      if (modal) {
        modal.remove();
        showBranchPicker();
      }
    } else {
      showNotification(`Failed to delete: ${data.output || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showNotification('Failed to delete branch', 'error');
  }
}

// ============================================
// STASH MANAGEMENT
// ============================================

async function loadStashes() {
  try {
    const res = await fetch('/api/git/stash');
    const data = await res.json();
    return data.stashes || [];
  } catch (err) {
    console.error('Failed to load stashes:', err);
    return [];
  }
}

async function gitStashSave(message) {
  const msg = message || prompt('Stash message (optional):');
  
  showNotification('Stashing changes...', 'info');
  try {
    const res = await fetch('/api/git/stash/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, includeUntracked: true })
    });
    const data = await res.json();
    
    if (data.success) {
      showNotification('Changes stashed!', 'success');
      loadGitStatus();
    } else {
      showNotification('No changes to stash', 'warning');
    }
  } catch (err) {
    showNotification('Failed to stash', 'error');
  }
}

async function gitStashApply(index, pop = false) {
  showNotification('Applying stash...', 'info');
  try {
    const res = await fetch('/api/git/stash/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index, pop })
    });
    const data = await res.json();
    
    if (data.success) {
      showNotification(pop ? 'Stash popped!' : 'Stash applied!', 'success');
      loadGitStatus();
    } else {
      showNotification(`Failed: ${data.output || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showNotification('Failed to apply stash', 'error');
  }
}

async function gitStashDrop(index) {
  if (!confirm('Drop this stash? This cannot be undone.')) return;
  
  try {
    const res = await fetch('/api/git/stash/drop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index })
    });
    const data = await res.json();
    
    if (data.success) {
      showNotification('Stash dropped', 'success');
      loadGitStatus();
    } else {
      showNotification('Failed to drop stash', 'error');
    }
  } catch (err) {
    showNotification('Failed to drop stash', 'error');
  }
}

// Export to window
window.gitState = gitState;
window.loadGitStatus = loadGitStatus;
window.gitCommit = gitCommit;
window.generateCommitMessage = generateCommitMessage;
window.gitStage = gitStage;
window.gitUnstage = gitUnstage;
window.gitStageAll = gitStageAll;
window.gitUnstageAll = gitUnstageAll;
window.gitDiscard = gitDiscard;
window.gitPush = gitPush;
window.gitPull = gitPull;
window.gitFetch = gitFetch;
window.showBranchPicker = showBranchPicker;
window.closeBranchPicker = closeBranchPicker;
window.gitCheckout = gitCheckout;
window.gitCreateBranch = gitCreateBranch;
window.gitDeleteBranch = gitDeleteBranch;
window.gitStashSave = gitStashSave;
window.gitStashApply = gitStashApply;
window.gitStashDrop = gitStashDrop;

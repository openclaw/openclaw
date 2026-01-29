/**
 * Brain Panel - Full Self-Learning System UI
 * 
 * Provides:
 * - Dockable side panel with tabs
 * - Overview tab with progress rings
 * - Timeline tab with activity feed
 * - Profile tab with user facts
 * - Decisions tab
 * - Preferences tab
 * - Coding tab
 * - Achievements tab
 * 
 * Phase 3 Implementation - PRD-SELF-LEARNING-SYSTEM.md
 */

class BrainPanel {
  constructor() {
    this.panelElement = null;
    this.isOpen = false;
    this.activeTab = 'overview';
    this.graph = null;
    this.panelWidth = 380;
    this.isResizing = false;
    
    // Bind methods
    this.init = this.init.bind(this);
    this.open = this.open.bind(this);
    this.close = this.close.bind(this);
    this.toggle = this.toggle.bind(this);
    this.switchTab = this.switchTab.bind(this);
  }
  
  /**
   * Initialize the Brain Panel
   */
  async init() {
    try {
      console.log('[BrainPanel] Initializing...');
      
      // Wait for DOM
      if (document.readyState === 'loading') {
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
      }
      
      // Create panel element
      this.createPanel();
      
      // Inject styles
      this.injectStyles();
      
      // Setup keyboard shortcuts
      this.setupKeyboardShortcuts();
      
      // Listen for brain updates
      this.setupEventListeners();
      
      // Load initial data
      await this.loadData();
      
      // Connect to brain module
      if (window.brainModule) {
        window.brainModule.openPanel = () => this.open();
      }
      
      console.log('[BrainPanel] Initialized successfully');
    } catch (err) {
      console.error('[BrainPanel] Initialization failed:', err);
    }
  }
  
  /**
   * Create the panel DOM structure
   */
  createPanel() {
    // Check if already exists
    if (document.getElementById('brain-panel')) {
      this.panelElement = document.getElementById('brain-panel');
      return;
    }
    
    this.panelElement = document.createElement('div');
    this.panelElement.id = 'brain-panel';
    this.panelElement.className = 'brain-panel';
    this.panelElement.style.display = 'none';
    
    this.panelElement.innerHTML = `
      <div class="brain-panel-resize-handle"></div>
      <div class="brain-panel-header">
        <div class="brain-panel-title">
          <span class="brain-panel-icon">🧠</span>
          <span>Clawd's Brain</span>
        </div>
        <div class="brain-panel-actions">
          <button class="brain-panel-action" onclick="window.brainPanel?.refresh()" title="Refresh">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
            </svg>
          </button>
          <button class="brain-panel-action brain-panel-close" onclick="window.brainPanel?.close()" title="Close (Cmd+Shift+B)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>
      
      <nav class="brain-panel-tabs">
        <button class="brain-tab active" data-tab="overview" title="Overview">🏠</button>
        <button class="brain-tab" data-tab="timeline" title="Timeline">📜</button>
        <button class="brain-tab" data-tab="profile" title="Profile">👤</button>
        <button class="brain-tab" data-tab="coding" title="Coding Style">👨‍💻</button>
        <button class="brain-tab" data-tab="decisions" title="Decisions">🧭</button>
        <button class="brain-tab" data-tab="preferences" title="Preferences">🎨</button>
        <button class="brain-tab" data-tab="achievements" title="Achievements">🏆</button>
        <button class="brain-tab" data-tab="settings" title="Privacy & Settings">⚙️</button>
      </nav>
      
      <div class="brain-panel-content">
        <!-- Tab content loads here -->
      </div>
    `;
    
    document.body.appendChild(this.panelElement);
    
    // Setup tab clicks
    this.panelElement.querySelectorAll('.brain-tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });
    
    // Setup resize handle
    this.setupResizeHandle();
  }
  
  /**
   * Setup resize handle for panel width
   */
  setupResizeHandle() {
    const handle = this.panelElement.querySelector('.brain-panel-resize-handle');
    if (!handle) return;
    
    let startX, startWidth;
    
    const onMouseMove = (e) => {
      if (!this.isResizing) return;
      const dx = startX - e.clientX;
      const newWidth = Math.max(300, Math.min(600, startWidth + dx));
      this.panelElement.style.width = `${newWidth}px`;
      this.panelWidth = newWidth;
    };
    
    const onMouseUp = () => {
      this.isResizing = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      
      // Save width preference
      localStorage.setItem('brain-panel-width', this.panelWidth);
    };
    
    handle.addEventListener('mousedown', (e) => {
      this.isResizing = true;
      startX = e.clientX;
      startWidth = this.panelElement.offsetWidth;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    });
    
    // Restore saved width
    const savedWidth = localStorage.getItem('brain-panel-width');
    if (savedWidth) {
      this.panelWidth = parseInt(savedWidth);
      this.panelElement.style.width = `${this.panelWidth}px`;
    }
  }
  
  /**
   * Load data from brain module or API
   */
  async loadData() {
    try {
      // Try to get from brain module first
      if (window.brainModule?.graph) {
        this.graph = window.brainModule.graph;
        return;
      }
      
      // Otherwise fetch from API
      const response = await fetch('/api/brain/graph');
      if (response.ok) {
        this.graph = await response.json();
      }
    } catch (err) {
      console.error('[BrainPanel] Failed to load data:', err);
    }
  }
  
  /**
   * Open the panel
   */
  open() {
    if (!this.panelElement) return;
    
    this.panelElement.style.display = 'flex';
    this.panelElement.style.width = `${this.panelWidth}px`;
    this.isOpen = true;
    
    // Animate in
    requestAnimationFrame(() => {
      this.panelElement.classList.add('open');
    });
    
    // Render current tab
    this.renderTab(this.activeTab);
    
    // Adjust main content
    this.adjustMainContent(true);
  }
  
  /**
   * Close the panel
   */
  close() {
    if (!this.panelElement) return;
    
    this.panelElement.classList.remove('open');
    this.isOpen = false;
    
    // Hide after animation
    setTimeout(() => {
      if (!this.isOpen) {
        this.panelElement.style.display = 'none';
      }
    }, 200);
    
    // Restore main content
    this.adjustMainContent(false);
  }
  
  /**
   * Toggle panel open/close
   */
  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }
  
  /**
   * Adjust main content when panel opens/closes
   */
  adjustMainContent(panelOpen) {
    const mainContent = document.querySelector('.editor-container') || 
                        document.querySelector('.main-content') ||
                        document.querySelector('#app');
    
    if (mainContent) {
      if (panelOpen) {
        mainContent.style.marginRight = `${this.panelWidth}px`;
      } else {
        mainContent.style.marginRight = '';
      }
    }
  }
  
  /**
   * Switch to a different tab
   */
  switchTab(tabId) {
    this.activeTab = tabId;
    
    // Update tab buttons
    this.panelElement.querySelectorAll('.brain-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.tab === tabId);
    });
    
    // Render tab content
    this.renderTab(tabId);
  }
  
  /**
   * Render tab content
   */
  renderTab(tabId) {
    const content = this.panelElement.querySelector('.brain-panel-content');
    if (!content) return;
    
    switch (tabId) {
      case 'overview':
        content.innerHTML = this.renderOverviewTab();
        break;
      case 'timeline':
        content.innerHTML = this.renderTimelineTab();
        this.loadTimeline();
        break;
      case 'profile':
        content.innerHTML = this.renderProfileTab();
        break;
      case 'coding':
        content.innerHTML = this.renderCodingTab();
        break;
      case 'decisions':
        content.innerHTML = this.renderDecisionsTab();
        break;
      case 'preferences':
        content.innerHTML = this.renderPreferencesTab();
        break;
      case 'achievements':
        content.innerHTML = this.renderAchievementsTab();
        break;
      case 'settings':
        content.innerHTML = this.renderSettingsTab();
        this.setupSettingsListeners();
        break;
      default:
        content.innerHTML = '<div class="brain-tab-placeholder">Tab not found</div>';
    }
  }
  
  /**
   * Render Overview Tab
   */
  renderOverviewTab() {
    const stats = this.graph?.stats || {};
    const accuracy = Math.round((stats.accuracy || 0) * 100);
    const streak = stats.streak || 0;
    const totalObs = stats.totalObservations || 0;
    const entities = Object.keys(this.graph?.entities || {}).length;
    const today = new Date().toISOString().split('T')[0];
    const todayCount = this.graph?.changelog?.filter(c => c.date?.startsWith(today)).length || 0;
    
    // Calculate category stats
    const facts = Object.keys(this.graph?.facts || {}).length;
    const preferences = Object.keys(this.graph?.preferences || {}).length;
    const patterns = Object.keys(this.graph?.patterns || {}).length;
    
    return `
      <div class="brain-tab-content overview-tab">
        <!-- Progress Rings -->
        <div class="progress-rings">
          ${this.renderProgressRing(accuracy, 'Accuracy', '#4ade80')}
          ${this.renderProgressRing(Math.min(100, totalObs), 'Learned', '#8b5cf6')}
          ${this.renderProgressRing(Math.min(100, streak * 14), 'Calibration', '#f97316')}
        </div>
        
        <!-- Streak Banner -->
        ${streak > 0 ? `
          <div class="streak-banner">
            <span class="streak-flame">🔥</span>
            <span class="streak-count">${streak}-day learning streak!</span>
          </div>
        ` : ''}
        
        <!-- Quick Stats -->
        <div class="quick-stats">
          <div class="stat-card">
            <div class="stat-value">${totalObs}</div>
            <div class="stat-label">Total Observations</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${entities}</div>
            <div class="stat-label">Entities</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">${todayCount}</div>
            <div class="stat-label">Today</div>
          </div>
        </div>
        
        <!-- Category Breakdown -->
        <div class="section">
          <div class="section-title">Knowledge Breakdown</div>
          <div class="category-bars">
            ${this.renderCategoryBar('Facts', facts, 50, '📊')}
            ${this.renderCategoryBar('Preferences', preferences, 30, '🎨')}
            ${this.renderCategoryBar('Patterns', patterns, 20, '🔄')}
          </div>
        </div>
        
        <!-- Recent Learnings -->
        <div class="section">
          <div class="section-title">Recently Learned</div>
          <div class="recent-list">
            ${this.renderRecentLearnings()}
          </div>
        </div>
        
        <!-- Weekly Activity Heatmap -->
        <div class="section">
          <div class="section-title">This Week</div>
          <div class="activity-heatmap">
            ${this.renderWeeklyHeatmap()}
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Render a progress ring
   */
  renderProgressRing(percent, label, color) {
    const radius = 36;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percent / 100) * circumference;
    
    return `
      <div class="progress-ring">
        <svg width="100" height="100" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="${radius}" 
            fill="none" stroke="var(--bg-tertiary, #333)" stroke-width="8"/>
          <circle cx="50" cy="50" r="${radius}"
            fill="none" stroke="${color}" stroke-width="8"
            stroke-dasharray="${circumference}"
            stroke-dashoffset="${offset}"
            stroke-linecap="round"
            transform="rotate(-90 50 50)"
            class="progress-ring-fill"/>
        </svg>
        <div class="ring-center">
          <div class="ring-value">${percent}%</div>
          <div class="ring-label">${label}</div>
        </div>
      </div>
    `;
  }
  
  /**
   * Render category bar
   */
  renderCategoryBar(name, count, max, icon) {
    const percent = Math.min(100, (count / max) * 100);
    return `
      <div class="category-bar">
        <div class="category-info">
          <span class="category-icon">${icon}</span>
          <span class="category-name">${name}</span>
          <span class="category-count">${count}</span>
        </div>
        <div class="category-progress">
          <div class="category-fill" style="width: ${percent}%"></div>
        </div>
      </div>
    `;
  }
  
  /**
   * Render recent learnings list
   */
  renderRecentLearnings() {
    const recent = this.graph?.observations?.recently_confirmed || [];
    if (recent.length === 0) {
      return '<div class="empty-state">No recent learnings yet</div>';
    }
    
    return recent.slice(0, 5).map(item => `
      <div class="recent-item">
        <span class="recent-icon">✨</span>
        <span class="recent-text">${this.escapeHtml(item.observation || item.content || 'Unknown')}</span>
        <span class="recent-time">${this.formatTime(item.confirmed)}</span>
      </div>
    `).join('');
  }
  
  /**
   * Render weekly activity heatmap
   */
  renderWeeklyHeatmap() {
    const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const today = new Date();
    const dayOfWeek = today.getDay();
    
    // Get activity counts for last 7 days
    const activityCounts = [];
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split('T')[0];
      const count = this.graph?.changelog?.filter(c => c.date?.startsWith(dateStr)).length || 0;
      activityCounts.push({ day: days[(dayOfWeek - i + 7) % 7], count, isToday: i === 0 });
    }
    
    return activityCounts.map(({ day, count, isToday }) => {
      const intensity = count === 0 ? 0 : count < 3 ? 1 : count < 6 ? 2 : 3;
      return `
        <div class="heatmap-day ${isToday ? 'today' : ''}" 
             data-intensity="${intensity}" 
             title="${count} activities">
          <div class="heatmap-label">${day}</div>
          <div class="heatmap-cell"></div>
        </div>
      `;
    }).join('');
  }
  
  /**
   * Render Timeline Tab
   */
  renderTimelineTab() {
    return `
      <div class="brain-tab-content timeline-tab">
        <div class="timeline-filters">
          <select class="timeline-filter" onchange="window.brainPanel?.filterTimeline(this.value)">
            <option value="all">All Activities</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Pending</option>
            <option value="decision">Decisions</option>
            <option value="achievement">Achievements</option>
          </select>
        </div>
        <div class="timeline-list" id="timeline-list">
          <div class="loading">Loading timeline...</div>
        </div>
      </div>
    `;
  }
  
  /**
   * Load timeline data
   */
  async loadTimeline() {
    try {
      const response = await fetch('/api/brain/timeline?limit=100');
      if (response.ok) {
        const data = await response.json();
        this.renderTimelineItems(data.timeline || []);
      }
    } catch (err) {
      console.error('[BrainPanel] Timeline load error:', err);
    }
  }
  
  /**
   * Render timeline items
   */
  renderTimelineItems(items) {
    const container = document.getElementById('timeline-list');
    if (!container) return;
    
    if (items.length === 0) {
      container.innerHTML = '<div class="empty-state">No activity yet</div>';
      return;
    }
    
    // Group by date
    const grouped = {};
    items.forEach(item => {
      const date = new Date(item.date).toLocaleDateString('en-US', { 
        month: 'short', day: 'numeric', year: 'numeric' 
      });
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(item);
    });
    
    container.innerHTML = Object.entries(grouped).map(([date, dayItems]) => `
      <div class="timeline-group">
        <div class="timeline-date">${date}</div>
        ${dayItems.map(item => `
          <div class="timeline-item" data-type="${item.type}">
            <div class="timeline-icon">${item.icon || '📝'}</div>
            <div class="timeline-content">
              <div class="timeline-text">${this.escapeHtml(item.content)}</div>
              <div class="timeline-meta">
                <span class="timeline-type">${item.type}</span>
                <span class="timeline-time">${this.formatTime(item.date)}</span>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `).join('');
  }
  
  /**
   * Render Profile Tab
   */
  renderProfileTab() {
    const facts = this.graph?.facts || {};
    const entities = this.graph?.entities || {};
    
    return `
      <div class="brain-tab-content profile-tab">
        <div class="profile-header">
          <div class="profile-avatar">👤</div>
          <div class="profile-info">
            <div class="profile-name">${this.escapeHtml(facts.name?.value || 'User')}</div>
            <div class="profile-since">Learning since ${this.graph?.stats?.learningStartDate 
              ? new Date(this.graph.stats.learningStartDate).toLocaleDateString() 
              : 'today'}</div>
          </div>
        </div>
        
        <div class="section">
          <div class="section-title">Known Facts</div>
          <div class="facts-list">
            ${this.renderFactsList(facts)}
          </div>
        </div>
        
        <div class="section">
          <div class="section-title">Entities</div>
          <div class="entities-list">
            ${this.renderEntitiesList(entities)}
          </div>
        </div>
        
        <div class="section">
          <div class="section-title">Add Knowledge</div>
          <div class="add-fact-form">
            <input type="text" class="add-fact-input" placeholder="What should I remember?">
            <button class="add-fact-btn" onclick="window.brainPanel?.addFact()">Add</button>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Render facts list
   */
  renderFactsList(facts) {
    const entries = Object.entries(facts);
    if (entries.length === 0) {
      return '<div class="empty-state">No facts recorded yet</div>';
    }
    
    return entries.map(([key, value]) => `
      <div class="fact-item" data-id="${key}">
        <div class="fact-key">${this.formatKey(key)}</div>
        <div class="fact-value">${this.escapeHtml(value.value || value)}</div>
        <div class="fact-confidence ${value.confidence || 'tentative'}">${value.confidence || 'tentative'}</div>
        <button class="fact-delete" onclick="window.brainPanel?.deleteFact('${key}')" title="Forget">×</button>
      </div>
    `).join('');
  }
  
  /**
   * Render entities list
   */
  renderEntitiesList(entities) {
    const entries = Object.entries(entities);
    if (entries.length === 0) {
      return '<div class="empty-state">No entities discovered yet</div>';
    }
    
    return entries.slice(0, 10).map(([id, entity]) => `
      <div class="entity-item">
        <div class="entity-icon">${entity.type === 'person' ? '👤' : entity.type === 'business' ? '🏢' : '📦'}</div>
        <div class="entity-info">
          <div class="entity-name">${this.escapeHtml(entity.name || id)}</div>
          <div class="entity-type">${entity.type || 'unknown'}</div>
        </div>
      </div>
    `).join('');
  }
  
  /**
   * Render Coding Tab
   */
  renderCodingTab() {
    const coding = this.graph?.preferences?.coding || {};
    const patterns = this.graph?.patterns || {};
    
    return `
      <div class="brain-tab-content coding-tab">
        <div class="section">
          <div class="section-title">Code Style Preferences</div>
          <div class="prefs-list">
            ${this.renderPreferenceItems(coding, 'coding')}
          </div>
        </div>
        
        <div class="section">
          <div class="section-title">Detected Patterns</div>
          <div class="patterns-list">
            ${this.renderPatternsList(patterns)}
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Render Decisions Tab
   */
  renderDecisionsTab() {
    const decisions = this.graph?.decisions?.recent || [];
    const riskProfile = this.graph?.decisions?.risk_profile || 'balanced';
    
    return `
      <div class="brain-tab-content decisions-tab">
        <div class="risk-profile">
          <div class="risk-icon">${riskProfile === 'cautious' ? '🛡️' : riskProfile === 'bold' ? '🚀' : '⚖️'}</div>
          <div class="risk-info">
            <div class="risk-label">Decision Style</div>
            <div class="risk-value">${this.capitalize(riskProfile)}</div>
          </div>
        </div>
        
        <div class="section">
          <div class="section-title">Recent Decisions</div>
          <div class="decisions-list">
            ${decisions.length === 0 
              ? '<div class="empty-state">No decisions recorded yet</div>'
              : decisions.slice(0, 10).map(d => `
                <div class="decision-item">
                  <div class="decision-icon">🧭</div>
                  <div class="decision-content">
                    <div class="decision-text">${this.escapeHtml(d.decision)}</div>
                    <div class="decision-context">${this.escapeHtml(d.context || '')}</div>
                    <div class="decision-date">${this.formatTime(d.date)}</div>
                  </div>
                </div>
              `).join('')
            }
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Render Preferences Tab
   */
  renderPreferencesTab() {
    const prefs = this.graph?.preferences || {};
    
    return `
      <div class="brain-tab-content preferences-tab">
        ${Object.entries(prefs).filter(([k]) => k !== 'coding').map(([category, items]) => `
          <div class="section">
            <div class="section-title">${this.formatKey(category)}</div>
            <div class="prefs-list">
              ${this.renderPreferenceItems(items, category)}
            </div>
          </div>
        `).join('') || '<div class="empty-state">No preferences recorded yet</div>'}
      </div>
    `;
  }
  
  /**
   * Render preference items
   */
  renderPreferenceItems(items, category) {
    if (!items || typeof items !== 'object') return '';
    
    return Object.entries(items).map(([key, value]) => `
      <div class="pref-item">
        <div class="pref-key">${this.formatKey(key)}</div>
        <div class="pref-value">${this.escapeHtml(typeof value === 'object' ? value.value : value)}</div>
      </div>
    `).join('') || '<div class="empty-state">None yet</div>';
  }
  
  /**
   * Render patterns list
   */
  renderPatternsList(patterns) {
    const entries = Object.entries(patterns);
    if (entries.length === 0) {
      return '<div class="empty-state">No patterns detected yet</div>';
    }
    
    return entries.slice(0, 10).map(([key, value]) => `
      <div class="pattern-item">
        <div class="pattern-icon">🔄</div>
        <div class="pattern-info">
          <div class="pattern-name">${this.formatKey(key)}</div>
          <div class="pattern-desc">${this.escapeHtml(value.description || value.value || '')}</div>
        </div>
      </div>
    `).join('');
  }
  
  /**
   * Render Achievements Tab
   */
  renderAchievementsTab() {
    const unlocked = this.graph?.achievements?.unlocked || [];
    const available = this.graph?.achievements?.available || [];
    
    return `
      <div class="brain-tab-content achievements-tab">
        <div class="achievements-summary">
          <div class="achievements-count">
            <span class="count-value">${unlocked.length}</span>
            <span class="count-label">Unlocked</span>
          </div>
          <div class="achievements-total">
            of ${unlocked.length + available.length} achievements
          </div>
        </div>
        
        ${unlocked.length > 0 ? `
          <div class="section">
            <div class="section-title">🏆 Unlocked</div>
            <div class="achievements-grid">
              ${unlocked.map(a => `
                <div class="achievement-card unlocked">
                  <div class="achievement-icon">${a.icon}</div>
                  <div class="achievement-name">${a.name}</div>
                  <div class="achievement-date">${this.formatTime(a.unlockedAt)}</div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
        
        ${available.length > 0 ? `
          <div class="section">
            <div class="section-title">🔒 In Progress</div>
            <div class="achievements-grid">
              ${available.map(a => `
                <div class="achievement-card locked">
                  <div class="achievement-icon">${a.icon}</div>
                  <div class="achievement-name">${a.name}</div>
                  <div class="achievement-progress">
                    <div class="progress-bar">
                      <div class="progress-fill" style="width: ${Math.round((a.progress || 0) / (a.target || 1) * 100)}%"></div>
                    </div>
                    <div class="progress-text">${a.progress || 0}/${a.target || 1}</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }
  
  /**
   * Render Settings Tab (Privacy & Data Management)
   */
  renderSettingsTab() {
    const settings = this.graph?.settings || {};
    const stats = this.graph?.stats || {};
    
    return `
      <div class="brain-tab-content settings-tab">
        <!-- Privacy Settings -->
        <div class="settings-section">
          <div class="section-title">🔒 Privacy Settings</div>
          
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-name">What Clawd Can Learn</div>
              <div class="setting-desc">Control what types of information are collected</div>
            </div>
          </div>
          
          <div class="setting-toggles">
            <label class="toggle-item">
              <input type="checkbox" data-setting="learn.conversations" ${settings.learn?.conversations !== false ? 'checked' : ''}>
              <span>Conversations (explicit statements)</span>
            </label>
            <label class="toggle-item">
              <input type="checkbox" data-setting="learn.corrections" ${settings.learn?.corrections !== false ? 'checked' : ''}>
              <span>Corrections you make</span>
            </label>
            <label class="toggle-item">
              <input type="checkbox" data-setting="learn.codeStyle" ${settings.learn?.codeStyle !== false ? 'checked' : ''}>
              <span>Code style and preferences</span>
            </label>
            <label class="toggle-item">
              <input type="checkbox" data-setting="learn.decisions" ${settings.learn?.decisions !== false ? 'checked' : ''}>
              <span>Decision patterns</span>
            </label>
            <label class="toggle-item">
              <input type="checkbox" data-setting="learn.temporal" ${settings.learn?.temporal !== false ? 'checked' : ''}>
              <span>Time-based patterns (active hours)</span>
            </label>
          </div>
        </div>
        
        <!-- Visibility Settings -->
        <div class="settings-section">
          <div class="section-title">👁️ Display Settings</div>
          
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-name">Financial Data</div>
              <div class="setting-desc">How to display sensitive financial information</div>
            </div>
            <select class="setting-select" data-setting="display.financial">
              <option value="visible" ${settings.display?.financial === 'visible' ? 'selected' : ''}>Visible</option>
              <option value="blurred" ${settings.display?.financial !== 'visible' && settings.display?.financial !== 'hidden' ? 'selected' : ''}>Blurred (click to reveal)</option>
              <option value="hidden" ${settings.display?.financial === 'hidden' ? 'selected' : ''}>Hidden</option>
            </select>
          </div>
          
          <div class="setting-item">
            <div class="setting-info">
              <div class="setting-name">Personal Data</div>
              <div class="setting-desc">Phone, email, addresses</div>
            </div>
            <select class="setting-select" data-setting="display.personal">
              <option value="visible" ${settings.display?.personal === 'visible' ? 'selected' : ''}>Visible</option>
              <option value="blurred" ${settings.display?.personal !== 'visible' && settings.display?.personal !== 'hidden' ? 'selected' : ''}>Blurred</option>
              <option value="hidden" ${settings.display?.personal === 'hidden' ? 'selected' : ''}>Hidden</option>
            </select>
          </div>
          
          <div class="setting-item">
            <label class="toggle-item">
              <input type="checkbox" data-setting="display.notifications" ${settings.display?.notifications !== false ? 'checked' : ''}>
              <span>Show achievement notifications</span>
            </label>
          </div>
          
          <div class="setting-item">
            <label class="toggle-item">
              <input type="checkbox" data-setting="display.sounds" ${settings.display?.sounds !== false ? 'checked' : ''}>
              <span>Play sounds for achievements</span>
            </label>
          </div>
        </div>
        
        <!-- Data Management -->
        <div class="settings-section">
          <div class="section-title">💾 Data Management</div>
          
          <div class="data-stats">
            <div class="stat-item">
              <span class="stat-value">${stats.totalObservations || 0}</span>
              <span class="stat-label">Observations</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${Object.keys(this.graph?.entities || {}).length}</span>
              <span class="stat-label">Entities</span>
            </div>
            <div class="stat-item">
              <span class="stat-value">${(this.graph?.changelog || []).length}</span>
              <span class="stat-label">Events</span>
            </div>
          </div>
          
          <div class="data-actions">
            <button class="action-btn export-btn" onclick="brainPanel.exportData()">
              📤 Export All Data
            </button>
            <button class="action-btn import-btn" onclick="brainPanel.showImportDialog()">
              📥 Import Data
            </button>
            <button class="action-btn journal-btn" onclick="brainPanel.generateJournal()">
              📝 Generate Journal
            </button>
          </div>
          
          <div class="danger-zone">
            <div class="section-title danger">⚠️ Danger Zone</div>
            <button class="action-btn danger-btn" onclick="brainPanel.confirmClearCategory()">
              🗑️ Clear Category...
            </button>
            <button class="action-btn danger-btn" onclick="brainPanel.confirmFullReset()">
              💥 Full Reset
            </button>
          </div>
        </div>
        
        <!-- Sync Status -->
        <div class="settings-section">
          <div class="section-title">🔄 Sync Status</div>
          <div class="sync-status">
            <div class="sync-info">
              <span class="sync-label">Last synced:</span>
              <span class="sync-time">${this.formatTime(this.graph?.lastUpdated)}</span>
            </div>
            <button class="action-btn sync-btn" onclick="brainPanel.forceSync()">
              🔄 Sync Now
            </button>
          </div>
        </div>
      </div>
    `;
  }
  
  /**
   * Setup settings tab event listeners
   */
  setupSettingsListeners() {
    const panel = this.panelElement;
    if (!panel) return;
    
    // Toggle checkboxes
    panel.querySelectorAll('.settings-tab input[type="checkbox"]').forEach(checkbox => {
      checkbox.addEventListener('change', async (e) => {
        const setting = e.target.dataset.setting;
        const value = e.target.checked;
        await this.updateSetting(setting, value);
      });
    });
    
    // Select dropdowns
    panel.querySelectorAll('.settings-tab select').forEach(select => {
      select.addEventListener('change', async (e) => {
        const setting = e.target.dataset.setting;
        const value = e.target.value;
        await this.updateSetting(setting, value);
      });
    });
  }
  
  /**
   * Update a setting
   */
  async updateSetting(path, value) {
    try {
      // Parse path (e.g., "learn.conversations" -> {learn: {conversations: value}})
      const parts = path.split('.');
      const update = {};
      let current = update;
      
      for (let i = 0; i < parts.length - 1; i++) {
        current[parts[i]] = {};
        current = current[parts[i]];
      }
      current[parts[parts.length - 1]] = value;
      
      const response = await fetch('/api/brain/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update)
      });
      
      if (response.ok) {
        // Update local graph
        if (!this.graph.settings) this.graph.settings = {};
        this.mergeSettings(this.graph.settings, update);
        
        // Mark privacy as configured for achievement
        if (!this.graph.stats) this.graph.stats = {};
        this.graph.stats.privacyConfigured = true;
        
        if (window.showNotification) {
          window.showNotification('Setting saved', 'success', 2000);
        }
      }
    } catch (err) {
      console.error('[BrainPanel] Update setting error:', err);
    }
  }
  
  /**
   * Merge settings objects
   */
  mergeSettings(target, source) {
    for (const key in source) {
      if (typeof source[key] === 'object' && source[key] !== null) {
        if (!target[key]) target[key] = {};
        this.mergeSettings(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }
  
  /**
   * Export all brain data
   */
  async exportData() {
    try {
      const response = await fetch('/api/brain/export', { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        
        // Create download
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `clawd-brain-export-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
        
        // Mark as exported for achievement
        if (!this.graph.stats) this.graph.stats = {};
        this.graph.stats.exported = true;
        
        if (window.showNotification) {
          window.showNotification('Data exported successfully! 📤', 'success');
        }
      }
    } catch (err) {
      console.error('[BrainPanel] Export error:', err);
      if (window.showNotification) {
        window.showNotification('Export failed', 'error');
      }
    }
  }
  
  /**
   * Show import dialog
   */
  showImportDialog() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        
        // Validate structure
        if (!data.version || !data.data) {
          throw new Error('Invalid export file format');
        }
        
        // Confirm import
        if (!confirm(`Import ${data.data.observations || 0} observations and ${data.data.entities || 0} entities? This will merge with existing data.`)) {
          return;
        }
        
        // Send to server
        const response = await fetch('/api/brain/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data)
        });
        
        if (response.ok) {
          await this.refresh();
          if (window.showNotification) {
            window.showNotification('Data imported successfully! 📥', 'success');
          }
        }
      } catch (err) {
        console.error('[BrainPanel] Import error:', err);
        if (window.showNotification) {
          window.showNotification('Import failed: ' + err.message, 'error');
        }
      }
    };
    input.click();
  }
  
  /**
   * Generate and show journal
   */
  async generateJournal() {
    if (!window.brainModule) return;
    
    const journal = window.brainModule.generateJournalEntry('today');
    
    // Show in modal
    const modal = document.createElement('div');
    modal.className = 'brain-journal-modal';
    modal.innerHTML = `
      <div class="journal-backdrop" onclick="this.parentElement.remove()"></div>
      <div class="journal-content">
        <div class="journal-header">
          <span class="journal-title">${journal.title}</span>
          <button class="journal-close" onclick="this.closest('.brain-journal-modal').remove()">×</button>
        </div>
        <div class="journal-body">
          <div class="journal-text">${this.markdownToHtml(journal.narrative)}</div>
        </div>
        <div class="journal-footer">
          <button class="action-btn" onclick="brainPanel.copyJournal()">📋 Copy</button>
          <button class="action-btn" onclick="brainPanel.downloadJournal()">💾 Save</button>
        </div>
      </div>
    `;
    
    modal.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 10001;
      display: flex;
      align-items: center;
      justify-content: center;
    `;
    
    document.body.appendChild(modal);
    
    // Store for copy/download
    this.lastJournal = journal;
  }
  
  /**
   * Simple markdown to HTML
   */
  markdownToHtml(md) {
    return md
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/_(.+?)_/g, '<em>$1</em>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
      .replace(/\n/g, '<br>');
  }
  
  /**
   * Copy journal to clipboard
   */
  async copyJournal() {
    if (!this.lastJournal) return;
    await navigator.clipboard.writeText(this.lastJournal.narrative);
    if (window.showNotification) {
      window.showNotification('Copied to clipboard!', 'success', 2000);
    }
  }
  
  /**
   * Download journal as markdown
   */
  downloadJournal() {
    if (!this.lastJournal) return;
    const blob = new Blob([this.lastJournal.narrative], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clawd-journal-${new Date().toISOString().split('T')[0]}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }
  
  /**
   * Confirm clear category
   */
  confirmClearCategory() {
    const categories = ['preferences', 'entities', 'decisions', 'observations'];
    const category = prompt(`Which category to clear?\\n\\n${categories.join('\\n')}`);
    
    if (category && categories.includes(category)) {
      if (confirm(`Are you sure you want to clear all ${category}? This cannot be undone.`)) {
        this.clearCategory(category);
      }
    }
  }
  
  /**
   * Clear a category
   */
  async clearCategory(category) {
    try {
      const response = await fetch(`/api/brain/clear/${category}`, { method: 'DELETE' });
      if (response.ok) {
        await this.refresh();
        if (window.showNotification) {
          window.showNotification(`${category} cleared`, 'success');
        }
      }
    } catch (err) {
      console.error('[BrainPanel] Clear category error:', err);
    }
  }
  
  /**
   * Confirm full reset
   */
  confirmFullReset() {
    if (confirm('⚠️ FULL RESET\\n\\nThis will delete ALL learned data, preferences, and achievements.\\n\\nAre you absolutely sure?')) {
      if (confirm('Really? Everything will be gone. Last chance to cancel.')) {
        this.fullReset();
      }
    }
  }
  
  /**
   * Full reset
   */
  async fullReset() {
    try {
      const response = await fetch('/api/brain/reset', { method: 'POST' });
      if (response.ok) {
        await this.refresh();
        if (window.showNotification) {
          window.showNotification('Brain reset complete', 'warning');
        }
      }
    } catch (err) {
      console.error('[BrainPanel] Reset error:', err);
    }
  }
  
  /**
   * Force sync
   */
  async forceSync() {
    if (!window.brainModule) return;
    
    const result = await window.brainModule.syncWithServer();
    
    if (result.action === 'error') {
      if (window.showNotification) {
        window.showNotification('Sync failed: ' + result.error, 'error');
      }
    } else {
      await this.refresh();
      if (window.showNotification) {
        window.showNotification(`Sync complete (${result.action})`, 'success', 2000);
      }
    }
  }
  
  /**
   * Refresh panel data
   */
  async refresh() {
    await this.loadData();
    this.renderTab(this.activeTab);
  }
  
  /**
   * Add a new fact
   */
  async addFact() {
    const input = this.panelElement.querySelector('.add-fact-input');
    if (!input || !input.value.trim()) return;
    
    const content = input.value.trim();
    
    try {
      const response = await fetch('/api/brain/observe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'fact',
          content,
          confidence: 0.9,
          source: 'user_input'
        })
      });
      
      if (response.ok) {
        input.value = '';
        await this.refresh();
        if (window.showNotification) {
          window.showNotification('Knowledge added! 🧠', 'success');
        }
      }
    } catch (err) {
      console.error('[BrainPanel] Add fact error:', err);
    }
  }
  
  /**
   * Delete a fact
   */
  async deleteFact(id) {
    try {
      const response = await fetch(`/api/brain/forget/${id}`, { method: 'DELETE' });
      if (response.ok) {
        await this.refresh();
      }
    } catch (err) {
      console.error('[BrainPanel] Delete fact error:', err);
    }
  }
  
  /**
   * Filter timeline
   */
  filterTimeline(type) {
    const items = this.panelElement.querySelectorAll('.timeline-item');
    items.forEach(item => {
      if (type === 'all' || item.dataset.type === type) {
        item.style.display = '';
      } else {
        item.style.display = 'none';
      }
    });
  }
  
  /**
   * Setup keyboard shortcuts
   */
  setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Cmd+Shift+B to toggle panel
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'b') {
        e.preventDefault();
        this.toggle();
      }
      
      // Escape to close
      if (e.key === 'Escape' && this.isOpen) {
        this.close();
      }
    });
  }
  
  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Listen for brain sync events
    window.addEventListener('brain:synced', (e) => {
      if (e.detail?.graph) {
        this.graph = e.detail.graph;
        if (this.isOpen) {
          this.renderTab(this.activeTab);
        }
      }
    });
  }
  
  /**
   * Helper: Escape HTML
   */
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
  /**
   * Helper: Format key name
   */
  formatKey(key) {
    return key.replace(/_/g, ' ').replace(/([A-Z])/g, ' $1').trim()
      .split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }
  
  /**
   * Helper: Capitalize
   */
  capitalize(str) {
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
  }
  
  /**
   * Helper: Format time
   */
  formatTime(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now - date;
    
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
    
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  
  /**
   * Inject panel styles
   */
  injectStyles() {
    if (document.getElementById('brain-panel-styles')) return;
    
    const styles = document.createElement('style');
    styles.id = 'brain-panel-styles';
    styles.textContent = `
      /* Brain Panel Container */
      .brain-panel {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: 380px;
        background: var(--bg-primary, #1e1e2e);
        border-left: 1px solid var(--border-color, #333);
        display: flex;
        flex-direction: column;
        z-index: 1000;
        transform: translateX(100%);
        transition: transform 0.2s ease-out;
        box-shadow: -4px 0 20px rgba(0,0,0,0.2);
      }
      
      .brain-panel.open {
        transform: translateX(0);
      }
      
      /* Resize Handle */
      .brain-panel-resize-handle {
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 4px;
        cursor: ew-resize;
        background: transparent;
        transition: background 0.2s;
      }
      
      .brain-panel-resize-handle:hover {
        background: var(--accent-color, #8b5cf6);
      }
      
      /* Panel Header */
      .brain-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border-color, #333);
        background: var(--bg-secondary, #252535);
      }
      
      .brain-panel-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 14px;
      }
      
      .brain-panel-icon {
        font-size: 18px;
      }
      
      .brain-panel-actions {
        display: flex;
        gap: 4px;
      }
      
      .brain-panel-action {
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--text-secondary, #888);
        transition: all 0.2s;
      }
      
      .brain-panel-action:hover {
        background: var(--bg-tertiary, #333);
        color: var(--text-primary, #fff);
      }
      
      /* Tab Navigation */
      .brain-panel-tabs {
        display: flex;
        padding: 8px;
        gap: 4px;
        border-bottom: 1px solid var(--border-color, #333);
        background: var(--bg-secondary, #252535);
      }
      
      .brain-tab {
        flex: 1;
        padding: 8px;
        background: transparent;
        border: none;
        border-radius: 6px;
        cursor: pointer;
        font-size: 16px;
        transition: all 0.2s;
        opacity: 0.6;
      }
      
      .brain-tab:hover {
        background: var(--bg-tertiary, #333);
        opacity: 0.8;
      }
      
      .brain-tab.active {
        background: var(--accent-color, #8b5cf6);
        opacity: 1;
      }
      
      /* Panel Content */
      .brain-panel-content {
        flex: 1;
        overflow-y: auto;
        padding: 16px;
      }
      
      .brain-tab-content {
        animation: fadeIn 0.2s ease-out;
      }
      
      @keyframes fadeIn {
        from { opacity: 0; transform: translateY(10px); }
        to { opacity: 1; transform: translateY(0); }
      }
      
      /* Progress Rings */
      .progress-rings {
        display: flex;
        justify-content: space-around;
        padding: 16px 0;
      }
      
      .progress-ring {
        position: relative;
        width: 100px;
        height: 100px;
      }
      
      .progress-ring svg {
        transform: rotate(-90deg);
      }
      
      .progress-ring-fill {
        transition: stroke-dashoffset 0.5s ease-out;
      }
      
      .ring-center {
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        text-align: center;
      }
      
      .ring-value {
        font-size: 18px;
        font-weight: 700;
        color: var(--text-primary, #fff);
      }
      
      .ring-label {
        font-size: 10px;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
      }
      
      /* Streak Banner */
      .streak-banner {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 12px;
        background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
        border-radius: 8px;
        margin-bottom: 16px;
      }
      
      .streak-flame {
        font-size: 20px;
        animation: flame 0.5s ease-in-out infinite alternate;
      }
      
      @keyframes flame {
        from { transform: scale(1); }
        to { transform: scale(1.1); }
      }
      
      .streak-count {
        font-weight: 600;
        color: white;
      }
      
      /* Quick Stats */
      .quick-stats {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 12px;
        margin-bottom: 16px;
      }
      
      .stat-card {
        padding: 12px;
        background: var(--bg-secondary, #252535);
        border-radius: 8px;
        text-align: center;
      }
      
      .stat-value {
        font-size: 24px;
        font-weight: 700;
        color: var(--text-primary, #fff);
      }
      
      .stat-label {
        font-size: 10px;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
      }
      
      /* Sections */
      .section {
        margin-bottom: 20px;
      }
      
      .section-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 12px;
      }
      
      /* Category Bars */
      .category-bars {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      
      .category-bar {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      
      .category-info {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      
      .category-icon {
        font-size: 14px;
      }
      
      .category-name {
        flex: 1;
        font-size: 13px;
        color: var(--text-primary, #fff);
      }
      
      .category-count {
        font-size: 12px;
        color: var(--text-secondary, #888);
      }
      
      .category-progress {
        height: 6px;
        background: var(--bg-tertiary, #333);
        border-radius: 3px;
        overflow: hidden;
      }
      
      .category-fill {
        height: 100%;
        background: linear-gradient(90deg, #8b5cf6 0%, #a78bfa 100%);
        border-radius: 3px;
        transition: width 0.3s ease-out;
      }
      
      /* Recent List */
      .recent-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .recent-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px;
        background: var(--bg-secondary, #252535);
        border-radius: 6px;
      }
      
      .recent-icon {
        flex-shrink: 0;
      }
      
      .recent-text {
        flex: 1;
        font-size: 13px;
        color: var(--text-primary, #fff);
        line-height: 1.4;
      }
      
      .recent-time {
        font-size: 11px;
        color: var(--text-secondary, #888);
        white-space: nowrap;
      }
      
      /* Activity Heatmap */
      .activity-heatmap {
        display: flex;
        justify-content: space-between;
      }
      
      .heatmap-day {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
      }
      
      .heatmap-label {
        font-size: 10px;
        color: var(--text-secondary, #888);
      }
      
      .heatmap-cell {
        width: 24px;
        height: 24px;
        border-radius: 4px;
        background: var(--bg-tertiary, #333);
      }
      
      .heatmap-day[data-intensity="1"] .heatmap-cell {
        background: rgba(139, 92, 246, 0.3);
      }
      
      .heatmap-day[data-intensity="2"] .heatmap-cell {
        background: rgba(139, 92, 246, 0.6);
      }
      
      .heatmap-day[data-intensity="3"] .heatmap-cell {
        background: #8b5cf6;
      }
      
      .heatmap-day.today .heatmap-cell {
        border: 2px solid #8b5cf6;
      }
      
      /* Timeline */
      .timeline-filters {
        margin-bottom: 16px;
      }
      
      .timeline-filter {
        width: 100%;
        padding: 8px 12px;
        background: var(--bg-secondary, #252535);
        border: 1px solid var(--border-color, #333);
        border-radius: 6px;
        color: var(--text-primary, #fff);
        font-size: 13px;
      }
      
      .timeline-list {
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      
      .timeline-group {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .timeline-date {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-secondary, #888);
        padding-bottom: 4px;
        border-bottom: 1px solid var(--border-color, #333);
      }
      
      .timeline-item {
        display: flex;
        gap: 12px;
        padding: 10px;
        background: var(--bg-secondary, #252535);
        border-radius: 8px;
      }
      
      .timeline-icon {
        font-size: 16px;
        flex-shrink: 0;
      }
      
      .timeline-content {
        flex: 1;
        min-width: 0;
      }
      
      .timeline-text {
        font-size: 13px;
        color: var(--text-primary, #fff);
        line-height: 1.4;
        word-break: break-word;
      }
      
      .timeline-meta {
        display: flex;
        gap: 8px;
        margin-top: 4px;
      }
      
      .timeline-type {
        font-size: 10px;
        padding: 2px 6px;
        background: var(--bg-tertiary, #333);
        border-radius: 4px;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
      }
      
      .timeline-time {
        font-size: 11px;
        color: var(--text-secondary, #888);
      }
      
      /* Profile Tab */
      .profile-header {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 16px;
        background: var(--bg-secondary, #252535);
        border-radius: 12px;
        margin-bottom: 20px;
      }
      
      .profile-avatar {
        width: 64px;
        height: 64px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
        border-radius: 50%;
        font-size: 32px;
      }
      
      .profile-name {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary, #fff);
      }
      
      .profile-since {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-top: 4px;
      }
      
      /* Facts List */
      .facts-list, .prefs-list, .entities-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .fact-item, .pref-item {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px;
        background: var(--bg-secondary, #252535);
        border-radius: 6px;
      }
      
      .fact-key, .pref-key {
        font-size: 12px;
        color: var(--text-secondary, #888);
        min-width: 100px;
      }
      
      .fact-value, .pref-value {
        flex: 1;
        font-size: 13px;
        color: var(--text-primary, #fff);
      }
      
      .fact-confidence {
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        text-transform: uppercase;
      }
      
      .fact-confidence.validated {
        background: rgba(74, 222, 128, 0.2);
        color: #4ade80;
      }
      
      .fact-confidence.inferred {
        background: rgba(251, 191, 36, 0.2);
        color: #fbbf24;
      }
      
      .fact-confidence.tentative {
        background: rgba(148, 163, 184, 0.2);
        color: #94a3b8;
      }
      
      .fact-delete {
        width: 20px;
        height: 20px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        color: var(--text-secondary, #888);
        opacity: 0;
        transition: opacity 0.2s;
      }
      
      .fact-item:hover .fact-delete {
        opacity: 1;
      }
      
      .fact-delete:hover {
        background: rgba(239, 68, 68, 0.2);
        color: #ef4444;
      }
      
      /* Add Fact Form */
      .add-fact-form {
        display: flex;
        gap: 8px;
      }
      
      .add-fact-input {
        flex: 1;
        padding: 10px 12px;
        background: var(--bg-secondary, #252535);
        border: 1px solid var(--border-color, #333);
        border-radius: 6px;
        color: var(--text-primary, #fff);
        font-size: 13px;
      }
      
      .add-fact-input::placeholder {
        color: var(--text-secondary, #888);
      }
      
      .add-fact-btn {
        padding: 10px 16px;
        background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
        border: none;
        border-radius: 6px;
        color: white;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s;
      }
      
      .add-fact-btn:hover {
        transform: scale(1.02);
      }
      
      /* Entity Items */
      .entity-item {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px;
        background: var(--bg-secondary, #252535);
        border-radius: 6px;
      }
      
      .entity-icon {
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg-tertiary, #333);
        border-radius: 50%;
        font-size: 16px;
      }
      
      .entity-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary, #fff);
      }
      
      .entity-type {
        font-size: 11px;
        color: var(--text-secondary, #888);
      }
      
      /* Pattern Items */
      .pattern-item {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        padding: 10px;
        background: var(--bg-secondary, #252535);
        border-radius: 6px;
      }
      
      .pattern-icon {
        font-size: 16px;
      }
      
      .pattern-name {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-primary, #fff);
      }
      
      .pattern-desc {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-top: 2px;
      }
      
      /* Decisions Tab */
      .risk-profile {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 16px;
        background: var(--bg-secondary, #252535);
        border-radius: 12px;
        margin-bottom: 20px;
      }
      
      .risk-icon {
        font-size: 32px;
      }
      
      .risk-label {
        font-size: 11px;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
      }
      
      .risk-value {
        font-size: 18px;
        font-weight: 600;
        color: var(--text-primary, #fff);
      }
      
      .decisions-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      
      .decision-item {
        display: flex;
        gap: 12px;
        padding: 12px;
        background: var(--bg-secondary, #252535);
        border-radius: 8px;
      }
      
      .decision-icon {
        font-size: 16px;
        flex-shrink: 0;
      }
      
      .decision-text {
        font-size: 13px;
        color: var(--text-primary, #fff);
        line-height: 1.4;
      }
      
      .decision-context {
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-top: 4px;
      }
      
      .decision-date {
        font-size: 11px;
        color: var(--text-secondary, #888);
        margin-top: 4px;
      }
      
      /* Achievements Tab */
      .achievements-summary {
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 20px;
        background: linear-gradient(135deg, var(--bg-secondary, #252535) 0%, var(--bg-tertiary, #2a2a3a) 100%);
        border-radius: 12px;
        margin-bottom: 20px;
      }
      
      .achievements-count {
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      
      .count-value {
        font-size: 36px;
        font-weight: 700;
        color: #fbbf24;
      }
      
      .count-label {
        font-size: 11px;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
      }
      
      .achievements-total {
        font-size: 13px;
        color: var(--text-secondary, #888);
      }
      
      .achievements-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 12px;
      }
      
      .achievement-card {
        padding: 16px;
        background: var(--bg-secondary, #252535);
        border-radius: 8px;
        text-align: center;
      }
      
      .achievement-card.unlocked {
        border: 1px solid rgba(251, 191, 36, 0.3);
      }
      
      .achievement-card.locked {
        opacity: 0.7;
      }
      
      .achievement-card .achievement-icon {
        font-size: 24px;
        margin-bottom: 8px;
      }
      
      .achievement-card .achievement-name {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary, #fff);
      }
      
      .achievement-card .achievement-date {
        font-size: 10px;
        color: var(--text-secondary, #888);
        margin-top: 4px;
      }
      
      .achievement-progress {
        margin-top: 8px;
      }
      
      .achievement-progress .progress-bar {
        height: 4px;
        background: var(--bg-tertiary, #333);
        border-radius: 2px;
        overflow: hidden;
      }
      
      .achievement-progress .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #8b5cf6 0%, #a78bfa 100%);
        border-radius: 2px;
      }
      
      .achievement-progress .progress-text {
        font-size: 10px;
        color: var(--text-secondary, #888);
        margin-top: 4px;
      }
      
      /* Empty State */
      .empty-state {
        padding: 24px;
        text-align: center;
        color: var(--text-secondary, #888);
        font-size: 13px;
      }
      
      /* Loading */
      .loading {
        padding: 24px;
        text-align: center;
        color: var(--text-secondary, #888);
        font-size: 13px;
      }
    `;
    
    document.head.appendChild(styles);
  }
}

// Create global instance
window.brainPanel = new BrainPanel();

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.brainPanel.init());
} else {
  window.brainPanel.init();
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BrainPanel;
}

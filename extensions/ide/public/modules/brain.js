/**
 * Brain Module - Self-Learning System UI
 * 
 * Provides:
 * - Status bar indicator (confidence + streak)
 * - Quick popover with learning stats
 * - localStorage cache layer
 * - Real-time updates
 * 
 * Phase 1 Implementation - PRD-SELF-LEARNING-SYSTEM.md
 */

class BrainModule {
  constructor() {
    this.graph = null;
    this.cacheKey = 'clawd-brain-cache';
    this.lastUpdate = null;
    this.popoverVisible = false;
    this.statusBarElement = null;
    this.popoverElement = null;
    
    // Session tracking
    this.lastActivity = Date.now();
    this.idleTimeout = null;
    this.IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
    this.sessionConsolidated = false;
    
    // Sync tracking
    this.syncInterval = null;
    this.pushTimeout = null;
    
    // Bind methods
    this.init = this.init.bind(this);
    this.loadGraph = this.loadGraph.bind(this);
    this.updateStatusBar = this.updateStatusBar.bind(this);
    this.togglePopover = this.togglePopover.bind(this);
    this.trackActivity = this.trackActivity.bind(this);
    this.checkIdle = this.checkIdle.bind(this);
  }
  
  /**
   * Initialize the Brain module
   */
  async init() {
    try {
      console.log('[Brain] Initializing Self-Learning System...');
      
      // Load from cache first for instant display
      this.loadFromCache();
      
      // Wait for DOM to be ready
      if (document.readyState === 'loading') {
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
      }
      
      // Small delay to ensure status bar is rendered
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Create UI elements
      this.createStatusBar();
      this.createPopover();
      
      // Load fresh data from server
      await this.loadGraph();
      
      // Listen for updates
      this.setupEventListeners();
      
      // Start Phase 2 features
      this.startPeriodicSync();
      this.startIdleTracking();
      this.setupSessionEndTrigger();
      
      console.log('[Brain] Initialized successfully with Phase 2 features');
    } catch (err) {
      console.error('[Brain] Initialization failed:', err);
    }
  }
  
  /**
   * Track user activity to detect idle state
   */
  trackActivity() {
    this.lastActivity = Date.now();
    this.sessionConsolidated = false;
    
    // Reset idle timeout
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
    }
    
    this.idleTimeout = setTimeout(() => this.checkIdle(), this.IDLE_THRESHOLD_MS);
  }
  
  /**
   * Check if user has been idle and trigger consolidation
   */
  checkIdle() {
    const idleTime = Date.now() - this.lastActivity;
    
    if (idleTime >= this.IDLE_THRESHOLD_MS && !this.sessionConsolidated) {
      console.log('[Brain] User idle for 30+ minutes, triggering consolidation...');
      this.sessionConsolidated = true;
      this.triggerConsolidation();
    }
  }
  
  /**
   * Start tracking user activity for idle detection
   */
  startIdleTracking() {
    // Track various activity events
    const events = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    
    // Throttled activity tracker
    let throttleTimeout = null;
    const throttledTrack = () => {
      if (!throttleTimeout) {
        throttleTimeout = setTimeout(() => {
          this.trackActivity();
          throttleTimeout = null;
        }, 5000); // Throttle to once per 5 seconds
      }
    };
    
    events.forEach(event => {
      document.addEventListener(event, throttledTrack, { passive: true });
    });
    
    // Initial activity
    this.trackActivity();
    
    console.log('[Brain] Idle tracking started (30 min threshold)');
  }
  
  /**
   * Setup session-end trigger for browser close
   */
  setupSessionEndTrigger() {
    // Trigger consolidation on page unload
    window.addEventListener('beforeunload', () => {
      if (!this.sessionConsolidated) {
        // Use sendBeacon for reliable delivery
        const pending = this.getPendingObservations();
        if (pending.length > 0) {
          navigator.sendBeacon('/api/brain/consolidate', JSON.stringify({
            observations: pending,
            sessionEnd: new Date().toISOString()
          }));
        }
      }
    });
    
    // Also trigger on visibility change (tab hidden for extended time)
    let hiddenTime = null;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenTime = Date.now();
      } else if (hiddenTime) {
        const hiddenDuration = Date.now() - hiddenTime;
        // If hidden for more than 10 minutes, consolidate
        if (hiddenDuration > 10 * 60 * 1000 && !this.sessionConsolidated) {
          console.log('[Brain] Tab was hidden for 10+ minutes, consolidating...');
          this.triggerConsolidation();
        }
        hiddenTime = null;
      }
    });
    
    console.log('[Brain] Session-end triggers configured');
  }
  
  /**
   * Load graph from localStorage cache
   */
  loadFromCache() {
    try {
      const cached = localStorage.getItem(this.cacheKey);
      if (cached) {
        const data = JSON.parse(cached);
        this.graph = data.graph;
        this.lastUpdate = new Date(data.timestamp);
        console.log('[Brain] Loaded from cache:', this.graph?.stats);
      }
    } catch (e) {
      console.warn('[Brain] Cache load failed:', e);
    }
  }
  
  /**
   * Save graph to localStorage cache
   */
  saveToCache() {
    try {
      const data = {
        graph: this.graph,
        timestamp: new Date().toISOString()
      };
      localStorage.setItem(this.cacheKey, JSON.stringify(data));
    } catch (e) {
      console.warn('[Brain] Cache save failed:', e);
    }
  }
  
  /**
   * Load knowledge graph from server
   */
  async loadGraph() {
    try {
      const response = await fetch('/api/brain/graph');
      if (response.ok) {
        this.graph = await response.json();
        this.lastUpdate = new Date();
        this.saveToCache();
        this.updateStatusBar();
        console.log('[Brain] Loaded graph from server');
      } else {
        console.warn('[Brain] Failed to load graph:', response.status);
      }
    } catch (e) {
      console.warn('[Brain] Graph load error:', e);
      // Use cached data if available
      if (this.graph) {
        this.updateStatusBar();
      }
    }
  }
  
  /**
   * Create status bar indicator
   */
  createStatusBar() {
    try {
      // Find or create status bar container
      let statusBar = document.querySelector('.status-bar-right');
      if (!statusBar) {
        statusBar = document.querySelector('.status-bar');
        if (!statusBar) {
          console.warn('[Brain] Status bar not found, retrying in 500ms...');
          setTimeout(() => this.createStatusBar(), 500);
          return;
        }
      }
      
      // Check if already created
      if (document.querySelector('.brain-indicator')) {
        console.log('[Brain] Status bar indicator already exists');
        this.statusBarElement = document.querySelector('.brain-indicator');
        return;
      }
      
      // Create brain indicator
      this.statusBarElement = document.createElement('div');
      this.statusBarElement.className = 'brain-indicator';
      this.statusBarElement.innerHTML = this.getStatusBarHTML();
      
      // Use arrow function to preserve 'this' context
      this.statusBarElement.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.togglePopover(e);
      });
      
      // Insert at the beginning of status bar right section
      if (statusBar.firstChild) {
        statusBar.insertBefore(this.statusBarElement, statusBar.firstChild);
      } else {
        statusBar.appendChild(this.statusBarElement);
      }
      
      // Add styles
      this.injectStyles();
      
      console.log('[Brain] Status bar indicator created');
    } catch (err) {
      console.error('[Brain] Failed to create status bar:', err);
    }
  }
  
  /**
   * Get status bar HTML
   */
  getStatusBarHTML() {
    const stats = this.graph?.stats || { accuracy: 0, streak: 0 };
    const accuracy = Math.round((stats.accuracy || 0) * 100);
    const streak = stats.streak || 0;
    
    // Determine brain state color
    let brainClass = 'brain-gray';
    if (accuracy >= 90) brainClass = 'brain-green';
    else if (accuracy >= 70) brainClass = 'brain-amber';
    
    return `
      <span class="brain-icon ${brainClass}" title="Brain confidence: ${accuracy}%">🧠</span>
      <span class="brain-accuracy">${accuracy}%</span>
      ${streak > 0 ? `<span class="brain-streak" title="${streak}-day learning streak">🔥${streak}</span>` : ''}
    `;
  }
  
  /**
   * Update status bar display
   */
  updateStatusBar() {
    if (this.statusBarElement) {
      this.statusBarElement.innerHTML = this.getStatusBarHTML();
    }
    // Also update popover if visible
    if (this.popoverVisible && this.popoverElement) {
      this.popoverElement.innerHTML = this.getPopoverHTML();
    }
  }
  
  /**
   * Create popover element
   */
  createPopover() {
    try {
      // Check if already exists
      if (document.querySelector('.brain-popover')) {
        this.popoverElement = document.querySelector('.brain-popover');
        return;
      }
      
      this.popoverElement = document.createElement('div');
      this.popoverElement.className = 'brain-popover';
      this.popoverElement.innerHTML = this.getPopoverHTML();
      this.popoverElement.style.display = 'none';
      document.body.appendChild(this.popoverElement);
      
      // Close on outside click
      document.addEventListener('click', (e) => {
        if (this.popoverVisible && 
            this.popoverElement &&
            this.statusBarElement &&
            !this.popoverElement.contains(e.target) && 
            !this.statusBarElement.contains(e.target)) {
          this.hidePopover();
        }
      });
      
      console.log('[Brain] Popover created');
    } catch (err) {
      console.error('[Brain] Failed to create popover:', err);
    }
  }
  
  /**
   * Get popover HTML content
   */
  getPopoverHTML() {
    const stats = this.graph?.stats || {};
    const accuracy = Math.round((stats.accuracy || 0) * 100);
    const streak = stats.streak || 0;
    const totalObs = stats.totalObservations || 0;
    const startDate = stats.learningStartDate 
      ? new Date(stats.learningStartDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'Today';
    
    // Get recent observations
    const recentConfirmed = this.graph?.observations?.recently_confirmed || [];
    const recentItems = recentConfirmed.slice(0, 3);
    
    // Get pending achievements
    const available = this.graph?.achievements?.available || [];
    const nearComplete = available
      .filter(a => a.progress > 0)
      .sort((a, b) => (b.progress / b.target) - (a.progress / a.target))
      .slice(0, 2);
    
    // Calculate learning rate (observations today)
    const today = new Date().toISOString().split('T')[0];
    const todayObs = this.graph?.changelog?.filter(c => c.date?.startsWith(today)).length || 0;
    
    return `
      <div class="brain-popover-header">
        <span class="brain-popover-title">🧠 Clawd's Brain</span>
        <span class="brain-popover-subtitle">Learning about you since ${startDate}</span>
      </div>
      
      <div class="brain-popover-metrics">
        <div class="brain-metric">
          <div class="brain-metric-value ${accuracy >= 90 ? 'metric-green' : accuracy >= 70 ? 'metric-amber' : ''}">${accuracy}%</div>
          <div class="brain-metric-label">Accuracy</div>
        </div>
        <div class="brain-metric">
          <div class="brain-metric-value">${totalObs}</div>
          <div class="brain-metric-label">Learned</div>
        </div>
        <div class="brain-metric">
          <div class="brain-metric-value">${this.graph?.stats?.totalEntities || 0}</div>
          <div class="brain-metric-label">Entities</div>
        </div>
      </div>
      
      <div class="brain-popover-section">
        ${streak > 0 ? `<div class="brain-streak-badge">🔥 ${streak}-day learning streak</div>` : ''}
        ${todayObs > 0 ? `<div class="brain-today">📚 ${todayObs} patterns learned today</div>` : ''}
      </div>
      
      ${recentItems.length > 0 ? `
        <div class="brain-popover-section">
          <div class="brain-section-title">Recent Learnings</div>
          <ul class="brain-recent-list">
            ${recentItems.map(item => `
              <li class="brain-recent-item">
                <span class="brain-recent-icon">✨</span>
                <span class="brain-recent-text">${item.observation}</span>
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}
      
      ${nearComplete.length > 0 ? `
        <div class="brain-popover-section">
          <div class="brain-section-title">Achievement Progress</div>
          ${nearComplete.map(a => `
            <div class="brain-achievement-progress">
              <span class="brain-achievement-icon">${a.icon}</span>
              <span class="brain-achievement-name">${a.name}</span>
              <span class="brain-achievement-bar">
                <span class="brain-achievement-fill" style="width: ${Math.round((a.progress / a.target) * 100)}%"></span>
              </span>
              <span class="brain-achievement-count">${a.progress}/${a.target}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
      
      <div class="brain-popover-footer">
        <button class="brain-open-panel-btn" onclick="window.brainModule?.openPanel()">
          Open Full Panel →
        </button>
      </div>
    `;
  }
  
  /**
   * Toggle popover visibility
   */
  togglePopover(e) {
    console.log('[Brain] togglePopover called', { visible: this.popoverVisible, event: e });
    e?.stopPropagation();
    if (this.popoverVisible) {
      console.log('[Brain] Hiding popover');
      this.hidePopover();
    } else {
      console.log('[Brain] Showing popover');
      this.showPopover();
    }
  }
  
  /**
   * Show popover
   */
  showPopover() {
    console.log('[Brain] showPopover called', { 
      hasPopover: !!this.popoverElement, 
      hasStatusBar: !!this.statusBarElement 
    });
    
    if (!this.popoverElement || !this.statusBarElement) {
      console.warn('[Brain] Missing elements, cannot show popover');
      return;
    }
    
    // Update content
    this.popoverElement.innerHTML = this.getPopoverHTML();
    
    // Position popover ABOVE status bar indicator (since status bar is at bottom)
    const rect = this.statusBarElement.getBoundingClientRect();
    const statusBarHeight = 24; // Height of status bar
    console.log('[Brain] Positioning popover', { rect, windowWidth: window.innerWidth, windowHeight: window.innerHeight });
    
    // Position from bottom: just above the status bar
    const bottomPosition = window.innerHeight - rect.top + 8;
    const rightPosition = Math.max(10, window.innerWidth - rect.right);
    
    this.popoverElement.style.position = 'fixed';
    this.popoverElement.style.bottom = `${bottomPosition}px`;
    this.popoverElement.style.right = `${rightPosition}px`;
    this.popoverElement.style.top = 'auto';
    this.popoverElement.style.maxHeight = `${rect.top - 20}px`; // Don't exceed available space
    this.popoverElement.style.overflowY = 'auto';
    this.popoverElement.style.display = 'block';
    
    console.log('[Brain] Popover positioned at', { bottom: bottomPosition, right: rightPosition });
    
    this.popoverVisible = true;
    console.log('[Brain] Popover shown');
  }
  
  /**
   * Hide popover
   */
  hidePopover() {
    if (this.popoverElement) {
      this.popoverElement.style.display = 'none';
    }
    this.popoverVisible = false;
  }
  
  /**
   * Open full Brain Panel (Phase 3)
   */
  openPanel() {
    // TODO: Phase 3 - Full panel implementation
    console.log('[Brain] Full panel not yet implemented');
    this.hidePopover();
    
    // For now, show a notification
    if (window.showNotification) {
      window.showNotification('Brain Panel coming in Phase 3! 🧠', 'info');
    }
  }
  
  /**
   * Record a new observation
   */
  async observe(observation) {
    try {
      const response = await fetch('/api/brain/observe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(observation)
      });
      
      if (response.ok) {
        const result = await response.json();
        // Refresh graph
        await this.loadGraph();
        
        // Show toast for first achievement
        if (result.achievement) {
          this.showAchievementToast(result.achievement);
        }
        
        return result;
      }
    } catch (e) {
      console.error('[Brain] Observe error:', e);
    }
    return null;
  }
  
  /**
   * Confirm an inference
   */
  async confirm(observationId) {
    try {
      const response = await fetch(`/api/brain/confirm/${observationId}`, {
        method: 'PUT'
      });
      
      if (response.ok) {
        await this.loadGraph();
        return true;
      }
    } catch (e) {
      console.error('[Brain] Confirm error:', e);
    }
    return false;
  }
  
  /**
   * Forget (delete) knowledge
   */
  async forget(observationId) {
    try {
      const response = await fetch(`/api/brain/forget/${observationId}`, {
        method: 'DELETE'
      });
      
      if (response.ok) {
        await this.loadGraph();
        return true;
      }
    } catch (e) {
      console.error('[Brain] Forget error:', e);
    }
    return false;
  }
  
  /**
   * Show achievement toast
   */
  showAchievementToast(achievement) {
    if (window.showNotification) {
      window.showNotification(
        `${achievement.icon} Achievement Unlocked: ${achievement.name}!`,
        'success',
        5000
      );
    }
  }
  
  /**
   * Setup event listeners
   */
  setupEventListeners() {
    // Refresh on window focus
    window.addEventListener('focus', () => {
      // Only refresh if last update was more than 5 minutes ago
      if (this.lastUpdate && Date.now() - this.lastUpdate.getTime() > 5 * 60 * 1000) {
        this.loadGraph();
      }
    });
    
    // Listen for brain events from other modules
    window.addEventListener('brain:observe', (e) => {
      if (e.detail) {
        this.observe(e.detail);
      }
    });
    
    window.addEventListener('brain:refresh', () => {
      this.loadGraph();
    });
    
    // Listen for WebSocket brain:updated events (real-time sync)
    this.setupWebSocketListener();
  }
  
  /**
   * Setup WebSocket listener for real-time brain updates
   */
  setupWebSocketListener() {
    // Try to get the existing WebSocket connection or create observer
    const checkWs = () => {
      if (window.ws && window.ws.readyState === WebSocket.OPEN) {
        // Already have a connection, add message handler
        const originalOnMessage = window.ws.onmessage;
        window.ws.onmessage = (event) => {
          // Call original handler first
          if (originalOnMessage) {
            originalOnMessage.call(window.ws, event);
          }
          
          // Handle brain updates
          try {
            const data = JSON.parse(event.data);
            if (data.type === 'brain:updated' && data.graph) {
              console.log('[Brain] Received real-time update via WebSocket');
              this.graph = data.graph;
              this.lastUpdate = new Date();
              this.saveToCache();
              this.updateStatusBar();
              
              // Dispatch event for panel refresh
              window.dispatchEvent(new CustomEvent('brain:synced', { 
                detail: { graph: data.graph, timestamp: data.timestamp }
              }));
            }
          } catch (e) {
            // Not JSON or not brain event, ignore
          }
        };
        console.log('[Brain] WebSocket listener attached');
        return true;
      }
      return false;
    };
    
    // Try immediately
    if (!checkWs()) {
      // Retry a few times
      let attempts = 0;
      const retryInterval = setInterval(() => {
        attempts++;
        if (checkWs() || attempts > 10) {
          clearInterval(retryInterval);
        }
      }, 1000);
    }
  }
  
  /**
   * Inject CSS styles
   */
  injectStyles() {
    if (document.getElementById('brain-styles')) return;
    
    const styles = document.createElement('style');
    styles.id = 'brain-styles';
    styles.textContent = `
      /* Brain Indicator in Status Bar */
      .brain-indicator {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        cursor: pointer;
        border-radius: 4px;
        transition: background-color 0.2s;
        user-select: none;
      }
      
      .brain-indicator:hover {
        background-color: var(--bg-tertiary, rgba(255,255,255,0.1));
      }
      
      .brain-icon {
        font-size: 14px;
        transition: transform 0.3s;
      }
      
      .brain-indicator:hover .brain-icon {
        transform: scale(1.1);
      }
      
      .brain-green {
        animation: brain-pulse-green 2s infinite;
      }
      
      .brain-amber {
        opacity: 0.9;
      }
      
      .brain-gray {
        opacity: 0.6;
        filter: grayscale(50%);
      }
      
      @keyframes brain-pulse-green {
        0%, 100% { filter: drop-shadow(0 0 2px #4ade80); }
        50% { filter: drop-shadow(0 0 6px #4ade80); }
      }
      
      .brain-accuracy {
        font-size: 11px;
        color: var(--text-secondary, #888);
      }
      
      .brain-streak {
        font-size: 11px;
        color: #f97316;
        margin-left: 4px;
      }
      
      /* Brain Popover */
      .brain-popover {
        position: fixed;
        z-index: 10000;
        width: 320px;
        background: var(--bg-primary, #1e1e2e);
        border: 1px solid var(--border-color, #333);
        border-radius: 12px;
        box-shadow: 0 10px 40px rgba(0,0,0,0.3);
        overflow: hidden;
        animation: brain-popover-in 0.2s ease-out;
      }
      
      @keyframes brain-popover-in {
        from {
          opacity: 0;
          transform: translateY(-10px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
      
      .brain-popover-header {
        padding: 16px;
        background: linear-gradient(135deg, var(--bg-secondary, #252535) 0%, var(--bg-tertiary, #2a2a3a) 100%);
        border-bottom: 1px solid var(--border-color, #333);
      }
      
      .brain-popover-title {
        display: block;
        font-size: 16px;
        font-weight: 600;
        color: var(--text-primary, #fff);
      }
      
      .brain-popover-subtitle {
        display: block;
        font-size: 12px;
        color: var(--text-secondary, #888);
        margin-top: 4px;
      }
      
      .brain-popover-metrics {
        display: flex;
        justify-content: space-around;
        padding: 16px;
        background: var(--bg-secondary, #252535);
      }
      
      .brain-metric {
        text-align: center;
      }
      
      .brain-metric-value {
        font-size: 24px;
        font-weight: 700;
        color: var(--text-primary, #fff);
      }
      
      .brain-metric-value.metric-green {
        color: #4ade80;
      }
      
      .brain-metric-value.metric-amber {
        color: #fbbf24;
      }
      
      .brain-metric-label {
        font-size: 11px;
        color: var(--text-secondary, #888);
        margin-top: 4px;
      }
      
      .brain-popover-section {
        padding: 12px 16px;
        border-top: 1px solid var(--border-color, #333);
      }
      
      .brain-streak-badge {
        display: inline-block;
        padding: 4px 12px;
        background: linear-gradient(135deg, #f97316 0%, #ea580c 100%);
        border-radius: 12px;
        font-size: 12px;
        font-weight: 600;
        color: white;
      }
      
      .brain-today {
        display: inline-block;
        margin-left: 8px;
        font-size: 12px;
        color: var(--text-secondary, #888);
      }
      
      .brain-section-title {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-secondary, #888);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 8px;
      }
      
      .brain-recent-list {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      
      .brain-recent-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 4px 0;
        font-size: 13px;
        color: var(--text-primary, #fff);
      }
      
      .brain-recent-icon {
        flex-shrink: 0;
      }
      
      .brain-recent-text {
        line-height: 1.4;
      }
      
      .brain-achievement-progress {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 0;
      }
      
      .brain-achievement-icon {
        font-size: 16px;
      }
      
      .brain-achievement-name {
        font-size: 12px;
        color: var(--text-primary, #fff);
        flex: 1;
      }
      
      .brain-achievement-bar {
        width: 60px;
        height: 4px;
        background: var(--bg-tertiary, #333);
        border-radius: 2px;
        overflow: hidden;
      }
      
      .brain-achievement-fill {
        height: 100%;
        background: linear-gradient(90deg, #8b5cf6 0%, #a78bfa 100%);
        border-radius: 2px;
        transition: width 0.3s;
      }
      
      .brain-achievement-count {
        font-size: 11px;
        color: var(--text-secondary, #888);
        min-width: 30px;
        text-align: right;
      }
      
      .brain-popover-footer {
        padding: 12px 16px;
        border-top: 1px solid var(--border-color, #333);
        background: var(--bg-secondary, #252535);
      }
      
      .brain-open-panel-btn {
        width: 100%;
        padding: 10px;
        background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);
        border: none;
        border-radius: 8px;
        color: white;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s, box-shadow 0.2s;
      }
      
      .brain-open-panel-btn:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(139, 92, 246, 0.3);
      }
      
      .brain-open-panel-btn:active {
        transform: translateY(0);
      }
    `;
    
    document.head.appendChild(styles);
  }
  
  /**
   * Get current stats (for external access)
   */
  getStats() {
    return this.graph?.stats || null;
  }
  
  /**
   * Get preferences (for external access)
   */
  getPreferences() {
    return this.graph?.preferences || null;
  }
  
  /**
   * Get entities (for external access)
   */
  getEntities() {
    return this.graph?.entities || null;
  }
  
  // ===========================================
  // PHASE 2: Recording Pipeline
  // ===========================================
  
  /**
   * Calculate confidence score for an observation
   * Based on PRD formula: count, recency, consistency, validation
   * @param {Object} observation - The observation to score
   * @returns {number} Confidence score 0-1
   */
  calculateConfidence(observation) {
    let confidence = 0.20; // Base: single observation
    
    // Observation count factor
    const count = observation.count || 1;
    if (count >= 3) confidence += 0.20;
    if (count >= 10) confidence += 0.20;
    if (count >= 25) confidence += 0.15;
    
    // Recency factor
    const lastObserved = observation.lastObserved ? new Date(observation.lastObserved) : new Date();
    const daysSince = Math.floor((Date.now() - lastObserved.getTime()) / (1000 * 60 * 60 * 24));
    if (daysSince < 7) confidence += 0.10;
    if (daysSince > 30) confidence -= 0.15;
    
    // Consistency factor
    const contradictions = observation.contradictions || 0;
    if (contradictions === 0) confidence += 0.10;
    if (contradictions > 0) confidence -= 0.20 * Math.min(contradictions, 3);
    
    // User validation factor (overrides)
    if (observation.userConfirmed) confidence = Math.max(confidence, 0.95);
    if (observation.userDenied) confidence = 0;
    
    // Source factor
    if (observation.source === 'explicit') confidence = Math.max(confidence, 0.95);
    if (observation.source === 'correction') confidence = 1.0;
    
    return Math.min(Math.max(confidence, 0), 1.0);
  }
  
  /**
   * Get confidence level info (icon, label, color)
   * @param {number} confidence - Confidence score 0-1
   * @returns {Object} Level info
   */
  getConfidenceLevel(confidence) {
    if (confidence >= 0.95) return { icon: '🟢', label: 'Confirmed', color: '#22c55e' };
    if (confidence >= 0.80) return { icon: '🔵', label: 'Validated', color: '#3b82f6' };
    if (confidence >= 0.50) return { icon: '🟡', label: 'Inferred', color: '#eab308' };
    if (confidence >= 0.20) return { icon: '🟠', label: 'Tentative', color: '#f97316' };
    return { icon: '🔴', label: 'Guessed', color: '#ef4444' };
  }
  
  /**
   * Detect contradictions between new observation and existing knowledge
   * @param {Object} newObs - New observation
   * @returns {Array} List of contradictions found
   */
  detectContradictions(newObs) {
    const contradictions = [];
    if (!this.graph || !newObs) return contradictions;
    
    const { category, field, value } = newObs;
    
    // Check preferences
    if (category === 'preferences' && this.graph.preferences) {
      const sections = ['communication', 'coding', 'work'];
      for (const section of sections) {
        const sectionData = this.graph.preferences[section];
        if (sectionData && sectionData[field]) {
          const existing = sectionData[field];
          if (existing.value && existing.value !== value && existing.confidence > 0.5) {
            contradictions.push({
              type: 'preference',
              field: `${section}.${field}`,
              existingValue: existing.value,
              existingConfidence: existing.confidence,
              newValue: value,
              severity: existing.confidence > 0.8 ? 'high' : 'medium'
            });
          }
        }
      }
    }
    
    // Check entity attributes
    if (category === 'entity' && newObs.entityId && this.graph.entities) {
      const entity = this.graph.entities[newObs.entityId];
      if (entity && entity.attributes && entity.attributes[field]) {
        const existing = entity.attributes[field];
        if (existing.value && existing.value !== value && existing.confidence > 0.5) {
          contradictions.push({
            type: 'entity',
            entityId: newObs.entityId,
            field,
            existingValue: existing.value,
            existingConfidence: existing.confidence,
            newValue: value,
            severity: existing.confidence > 0.8 ? 'high' : 'medium'
          });
        }
      }
    }
    
    // Check decisions/patterns
    if (category === 'decision' && this.graph.decisions?.patterns) {
      const pattern = this.graph.decisions.patterns[field];
      if (pattern && pattern.value !== value && pattern.confidence > 0.7) {
        contradictions.push({
          type: 'decision_pattern',
          field,
          existingValue: pattern.value,
          existingConfidence: pattern.confidence,
          newValue: value,
          severity: 'medium'
        });
      }
    }
    
    return contradictions;
  }
  
  /**
   * Handle detected contradictions
   * @param {Array} contradictions - List of contradictions
   * @param {Object} newObs - The new observation causing contradictions
   * @returns {Object} Resolution action
   */
  async handleContradictions(contradictions, newObs) {
    if (contradictions.length === 0) {
      return { action: 'proceed', contradictions: [] };
    }
    
    // Log contradictions for review
    console.warn('[Brain] Contradictions detected:', contradictions);
    
    // For high severity, flag for user review
    const highSeverity = contradictions.filter(c => c.severity === 'high');
    
    if (highSeverity.length > 0) {
      // Store in pending for user review
      await this.flagForReview(contradictions, newObs);
      return { action: 'pending_review', contradictions: highSeverity };
    }
    
    // For medium/low severity with higher confidence new observation, replace
    const newConfidence = this.calculateConfidence(newObs);
    const shouldReplace = contradictions.every(c => newConfidence > c.existingConfidence + 0.2);
    
    if (shouldReplace) {
      // Archive old, use new
      await this.archiveContradicted(contradictions);
      return { action: 'replace', contradictions };
    }
    
    // Otherwise, note as exception
    return { action: 'note_exception', contradictions };
  }
  
  /**
   * Flag contradictions for user review
   */
  async flagForReview(contradictions, newObs) {
    const pending = this.graph.observations?.pending_review || [];
    pending.push({
      id: `review-${Date.now()}`,
      newObservation: newObs,
      contradictions,
      flaggedAt: new Date().toISOString(),
      status: 'pending'
    });
    
    if (!this.graph.observations) this.graph.observations = {};
    this.graph.observations.pending_review = pending;
    
    // Show notification
    this.showContradictionNotification(contradictions);
  }
  
  /**
   * Archive contradicted observations
   */
  async archiveContradicted(contradictions) {
    if (!this.graph.archive) this.graph.archive = [];
    
    for (const c of contradictions) {
      this.graph.archive.push({
        ...c,
        archivedAt: new Date().toISOString(),
        reason: 'contradicted_by_newer'
      });
    }
  }
  
  /**
   * Show notification for contradictions needing review
   */
  showContradictionNotification(contradictions) {
    const msg = contradictions.length === 1 
      ? `Conflicting observation detected: ${contradictions[0].field}`
      : `${contradictions.length} conflicting observations need review`;
    
    // Use IDE notification system if available
    if (window.showNotification) {
      window.showNotification(msg, 'warning', 5000);
    } else {
      console.warn('[Brain]', msg);
    }
  }
  
  // ===========================================
  // SYNC PROTOCOL
  // ===========================================
  
  /**
   * Bidirectional sync: localStorage <-> Server files
   * Called on session start and periodically
   */
  async syncWithServer() {
    try {
      console.log('[Brain] Starting bidirectional sync...');
      
      // Get server version
      const serverResponse = await fetch('/api/brain/graph');
      if (!serverResponse.ok) {
        throw new Error(`Server returned ${serverResponse.status}`);
      }
      const serverGraph = await serverResponse.json();
      const serverTimestamp = new Date(serverGraph.lastUpdated || 0).getTime();
      
      // Get local version
      const localTimestamp = this.lastUpdate ? this.lastUpdate.getTime() : 0;
      
      // Compare timestamps
      if (serverTimestamp > localTimestamp) {
        // Server is newer - pull
        console.log('[Brain] Server is newer, pulling...');
        this.graph = serverGraph;
        this.lastUpdate = new Date(serverTimestamp);
        this.saveToCache();
        this.updateStatusBar();
        return { action: 'pulled', from: 'server' };
      } else if (localTimestamp > serverTimestamp && this.hasLocalChanges()) {
        // Local is newer - push
        console.log('[Brain] Local is newer, pushing...');
        await this.pushToServer();
        return { action: 'pushed', to: 'server' };
      } else {
        console.log('[Brain] Already in sync');
        return { action: 'none', reason: 'in_sync' };
      }
    } catch (err) {
      console.error('[Brain] Sync failed:', err);
      return { action: 'error', error: err.message };
    }
  }
  
  /**
   * Check if there are local changes to push
   */
  hasLocalChanges() {
    const cached = localStorage.getItem(this.cacheKey);
    if (!cached) return false;
    
    try {
      const data = JSON.parse(cached);
      return data.pendingChanges && data.pendingChanges.length > 0;
    } catch {
      return false;
    }
  }
  
  /**
   * Push local changes to server
   */
  async pushToServer() {
    if (!this.graph) return;
    
    try {
      const response = await fetch('/api/brain/graph', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          graph: this.graph,
          timestamp: new Date().toISOString()
        })
      });
      
      if (!response.ok) {
        throw new Error(`Push failed: ${response.status}`);
      }
      
      // Clear pending changes
      this.clearPendingChanges();
      console.log('[Brain] Pushed to server successfully');
    } catch (err) {
      console.error('[Brain] Push failed:', err);
      throw err;
    }
  }
  
  /**
   * Queue a local change for later sync
   */
  queueChange(change) {
    try {
      const cached = localStorage.getItem(this.cacheKey);
      const data = cached ? JSON.parse(cached) : { graph: this.graph, timestamp: new Date().toISOString() };
      
      if (!data.pendingChanges) data.pendingChanges = [];
      data.pendingChanges.push({
        ...change,
        queuedAt: new Date().toISOString()
      });
      
      localStorage.setItem(this.cacheKey, JSON.stringify(data));
    } catch (err) {
      console.error('[Brain] Failed to queue change:', err);
    }
  }
  
  /**
   * Clear pending changes after successful push
   */
  clearPendingChanges() {
    try {
      const cached = localStorage.getItem(this.cacheKey);
      if (cached) {
        const data = JSON.parse(cached);
        data.pendingChanges = [];
        localStorage.setItem(this.cacheKey, JSON.stringify(data));
      }
    } catch (err) {
      console.error('[Brain] Failed to clear pending changes:', err);
    }
  }
  
  /**
   * Start periodic sync (every 5 minutes)
   */
  startPeriodicSync() {
    // Initial sync
    this.syncWithServer();
    
    // Periodic sync every 5 minutes
    this.syncInterval = setInterval(() => {
      this.syncWithServer();
    }, 5 * 60 * 1000);
    
    console.log('[Brain] Periodic sync started (every 5 min)');
  }
  
  /**
   * Stop periodic sync
   */
  stopPeriodicSync() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      console.log('[Brain] Periodic sync stopped');
    }
  }
  
  // ===========================================
  // SESSION CONSOLIDATION
  // ===========================================
  
  /**
   * Trigger session-end consolidation
   * Called when session ends (idle timeout or explicit)
   */
  async triggerConsolidation() {
    try {
      console.log('[Brain] Triggering session consolidation...');
      
      // Collect session observations from localStorage queue
      const pendingObs = this.getPendingObservations();
      if (pendingObs.length === 0) {
        console.log('[Brain] No pending observations to consolidate');
        return;
      }
      
      // Push any pending changes first
      await this.syncWithServer();
      
      // Trigger server-side consolidation
      const response = await fetch('/api/brain/consolidate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          observations: pendingObs,
          sessionEnd: new Date().toISOString()
        })
      });
      
      if (response.ok) {
        const result = await response.json();
        console.log('[Brain] Consolidation complete:', result);
        
        // Clear processed observations
        this.clearPendingObservations();
        
        // Refresh graph
        await this.loadGraph();
      } else {
        console.warn('[Brain] Consolidation request failed:', response.status);
      }
    } catch (err) {
      console.error('[Brain] Consolidation failed:', err);
    }
  }
  
  /**
   * Get pending observations from queue
   */
  getPendingObservations() {
    try {
      const key = 'clawd-brain-pending-obs';
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }
  
  /**
   * Add observation to pending queue
   */
  addPendingObservation(obs) {
    try {
      const key = 'clawd-brain-pending-obs';
      const pending = this.getPendingObservations();
      pending.push({
        ...obs,
        observedAt: new Date().toISOString()
      });
      localStorage.setItem(key, JSON.stringify(pending));
    } catch (err) {
      console.error('[Brain] Failed to queue observation:', err);
    }
  }
  
  /**
   * Clear pending observations
   */
  clearPendingObservations() {
    localStorage.removeItem('clawd-brain-pending-obs');
  }
  
  /**
   * Record an observation (with confidence and contradiction checks)
   * @param {Object} obs - The observation to record
   */
  async recordObservation(obs) {
    try {
      // Calculate confidence
      const confidence = this.calculateConfidence(obs);
      obs.confidence = confidence;
      obs.confidenceLevel = this.getConfidenceLevel(confidence);
      
      // Check for contradictions
      const contradictions = this.detectContradictions(obs);
      
      if (contradictions.length > 0) {
        const resolution = await this.handleContradictions(contradictions, obs);
        
        if (resolution.action === 'pending_review') {
          console.log('[Brain] Observation flagged for review');
          return { recorded: false, reason: 'pending_review', contradictions };
        }
      }
      
      // Add to pending queue
      this.addPendingObservation(obs);
      
      // Queue for server sync
      this.queueChange({
        type: 'observation',
        data: obs
      });
      
      // Update local graph immediately for UI
      this.applyObservationLocally(obs);
      
      // Update streak
      this.updateStreak();
      
      // Check for achievement unlocks
      const newAchievements = this.checkAchievements();
      
      // Debounced push to server
      this.debouncedPush();
      
      return { recorded: true, confidence, contradictions, achievements: newAchievements };
    } catch (err) {
      console.error('[Brain] Failed to record observation:', err);
      return { recorded: false, error: err.message };
    }
  }
  
  /**
   * Apply observation to local graph for immediate UI update
   */
  applyObservationLocally(obs) {
    if (!this.graph) return;
    
    const { category, field, value, confidence } = obs;
    
    if (category === 'preferences') {
      const section = obs.section || 'communication';
      if (!this.graph.preferences) this.graph.preferences = {};
      if (!this.graph.preferences[section]) this.graph.preferences[section] = {};
      
      this.graph.preferences[section][field] = {
        value,
        confidence,
        lastObserved: new Date().toISOString(),
        observations: (this.graph.preferences[section][field]?.observations || 0) + 1
      };
    }
    
    // Update stats
    if (!this.graph.stats) this.graph.stats = {};
    this.graph.stats.totalObservations = (this.graph.stats.totalObservations || 0) + 1;
    this.graph.stats.lastActive = new Date().toISOString();
    
    // Save to cache
    this.saveToCache();
    this.updateStatusBar();
  }
  
  /**
   * Debounced push to server (30 second delay)
   */
  debouncedPush() {
    if (this.pushTimeout) {
      clearTimeout(this.pushTimeout);
    }
    
    this.pushTimeout = setTimeout(async () => {
      try {
        await this.pushToServer();
      } catch (err) {
        console.warn('[Brain] Debounced push failed:', err);
      }
    }, 30000); // 30 seconds
  }
  
  // ===========================================
  // PHASE 4: GAMIFICATION
  // ===========================================
  
  /**
   * Achievement definitions
   */
  static ACHIEVEMENTS = [
    { id: 'first_memory', name: 'First Memory', icon: '🎯', description: 'First observation recorded', condition: (s) => s.totalObservations >= 1 },
    { id: 'quick_learner', name: 'Quick Learner', icon: '📚', description: '10 observations in one day', condition: (s) => s.todayObservations >= 10 },
    { id: 'knowledge_builder', name: 'Knowledge Builder', icon: '🧱', description: '50 total observations', condition: (s) => s.totalObservations >= 50 },
    { id: 'century_club', name: 'Century Club', icon: '💯', description: '100+ total observations', condition: (s) => s.totalObservations >= 100 },
    { id: 'week_warrior', name: 'Week Warrior', icon: '🔥', description: '7-day learning streak', condition: (s) => s.streak >= 7 },
    { id: 'month_master', name: 'Month Master', icon: '🏆', description: '30-day learning streak', condition: (s) => s.streak >= 30 },
    { id: 'well_calibrated', name: 'Well Calibrated', icon: '🎯', description: '90%+ accuracy for a week', condition: (s) => s.accuracy >= 0.9 && s.accuracyStreak >= 7 },
    { id: 'pattern_hunter', name: 'Pattern Hunter', icon: '🔍', description: '25 patterns detected', condition: (s) => s.patternsDetected >= 25 },
    { id: 'code_whisperer', name: 'Code Whisperer', icon: '💻', description: '50 coding preferences learned', condition: (s) => s.codingPreferences >= 50 },
    { id: 'decision_tracker', name: 'Decision Tracker', icon: '🧭', description: '20 decisions logged', condition: (s) => s.decisionsLogged >= 20 },
    { id: 'feedback_friend', name: 'Feedback Friend', icon: '✅', description: '10 user confirmations', condition: (s) => s.confirmations >= 10 },
    { id: 'early_adopter', name: 'Early Adopter', icon: '🌟', description: 'Used Brain Panel in first week', condition: (s) => s.usedPanelFirstWeek },
    { id: 'data_master', name: 'Data Master', icon: '💾', description: 'Exported data successfully', condition: (s) => s.exported },
    { id: 'privacy_pro', name: 'Privacy Pro', icon: '🔒', description: 'Configured privacy settings', condition: (s) => s.privacyConfigured },
    { id: 'profile_complete', name: 'Profile Complete', icon: '👤', description: 'All profile sections filled', condition: (s) => s.profileSections >= 5 },
  ];
  
  /**
   * Check all achievements and unlock any that are newly earned
   */
  checkAchievements() {
    if (!this.graph) return [];
    
    const stats = this.getAchievementStats();
    const newlyUnlocked = [];
    
    if (!this.graph.achievements) {
      this.graph.achievements = { unlocked: [], available: [] };
    }
    
    const unlockedIds = new Set((this.graph.achievements.unlocked || []).map(a => a.id));
    
    for (const achievement of BrainModule.ACHIEVEMENTS) {
      // Skip already unlocked
      if (unlockedIds.has(achievement.id)) continue;
      
      // Check condition
      if (achievement.condition(stats)) {
        const unlocked = {
          ...achievement,
          unlockedAt: new Date().toISOString()
        };
        
        this.graph.achievements.unlocked.push(unlocked);
        newlyUnlocked.push(unlocked);
        
        console.log(`[Brain] 🏆 Achievement unlocked: ${achievement.name}`);
      }
    }
    
    // Update available (locked) achievements
    this.graph.achievements.available = BrainModule.ACHIEVEMENTS
      .filter(a => !unlockedIds.has(a.id) && !newlyUnlocked.find(n => n.id === a.id))
      .map(a => ({
        ...a,
        progress: this.getAchievementProgress(a, stats)
      }));
    
    // Show notifications for newly unlocked
    for (const a of newlyUnlocked) {
      this.showAchievementToast(a);
    }
    
    if (newlyUnlocked.length > 0) {
      this.saveToCache();
      this.debouncedPush();
    }
    
    return newlyUnlocked;
  }
  
  /**
   * Get stats object for achievement checking
   */
  getAchievementStats() {
    const stats = this.graph?.stats || {};
    const prefs = this.graph?.preferences || {};
    const decisions = this.graph?.decisions || {};
    
    // Count today's observations
    const today = new Date().toISOString().split('T')[0];
    const todayObs = (this.graph?.changelog || [])
      .filter(c => c.date?.startsWith(today))
      .length;
    
    // Count coding preferences
    const codingPrefs = Object.keys(prefs.coding || {}).length;
    
    // Count profile sections with data
    const entities = this.graph?.entities || {};
    const profileSections = Object.keys(entities).length;
    
    return {
      totalObservations: stats.totalObservations || 0,
      todayObservations: todayObs,
      streak: stats.streak || 0,
      accuracy: stats.accuracy || 0,
      accuracyStreak: stats.accuracyStreak || 0,
      patternsDetected: stats.patternsDetected || 0,
      codingPreferences: codingPrefs,
      decisionsLogged: (decisions.recent || []).length,
      confirmations: stats.confirmations || 0,
      usedPanelFirstWeek: stats.usedPanelFirstWeek || false,
      exported: stats.exported || false,
      privacyConfigured: stats.privacyConfigured || false,
      profileSections
    };
  }
  
  /**
   * Get progress toward a locked achievement (for progress bars)
   */
  getAchievementProgress(achievement, stats) {
    const targets = {
      'first_memory': { current: stats.totalObservations, target: 1 },
      'quick_learner': { current: stats.todayObservations, target: 10 },
      'knowledge_builder': { current: stats.totalObservations, target: 50 },
      'century_club': { current: stats.totalObservations, target: 100 },
      'week_warrior': { current: stats.streak, target: 7 },
      'month_master': { current: stats.streak, target: 30 },
      'pattern_hunter': { current: stats.patternsDetected, target: 25 },
      'code_whisperer': { current: stats.codingPreferences, target: 50 },
      'decision_tracker': { current: stats.decisionsLogged, target: 20 },
      'feedback_friend': { current: stats.confirmations, target: 10 },
      'profile_complete': { current: stats.profileSections, target: 5 },
    };
    
    const progress = targets[achievement.id];
    if (!progress) return { current: 0, target: 1, percent: 0 };
    
    return {
      ...progress,
      percent: Math.min(100, Math.round((progress.current / progress.target) * 100))
    };
  }
  
  /**
   * Show achievement unlock toast notification
   */
  showAchievementToast(achievement) {
    // Create toast container if not exists
    let toastContainer = document.getElementById('brain-toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'brain-toast-container';
      toastContainer.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 10000;
        display: flex;
        flex-direction: column;
        gap: 10px;
      `;
      document.body.appendChild(toastContainer);
    }
    
    // Create toast
    const toast = document.createElement('div');
    toast.className = 'brain-achievement-toast';
    toast.innerHTML = `
      <div class="toast-icon">${achievement.icon}</div>
      <div class="toast-content">
        <div class="toast-title">🏆 Achievement Unlocked!</div>
        <div class="toast-name">${achievement.name}</div>
        <div class="toast-desc">${achievement.description}</div>
      </div>
    `;
    
    toast.style.cssText = `
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      background: linear-gradient(135deg, #1e1e2e 0%, #2a2a3e 100%);
      border: 1px solid rgba(139, 92, 246, 0.5);
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 20px rgba(139, 92, 246, 0.2);
      animation: slideIn 0.3s ease, glow 2s ease-in-out infinite;
      max-width: 320px;
    `;
    
    // Add styles if not present
    if (!document.getElementById('brain-toast-styles')) {
      const styles = document.createElement('style');
      styles.id = 'brain-toast-styles';
      styles.textContent = `
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes slideOut {
          from { transform: translateX(0); opacity: 1; }
          to { transform: translateX(100%); opacity: 0; }
        }
        @keyframes glow {
          0%, 100% { box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 20px rgba(139, 92, 246, 0.2); }
          50% { box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 30px rgba(139, 92, 246, 0.4); }
        }
        .brain-achievement-toast .toast-icon {
          font-size: 32px;
          animation: bounce 0.5s ease;
        }
        @keyframes bounce {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.2); }
        }
        .brain-achievement-toast .toast-title {
          font-size: 11px;
          color: #a78bfa;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .brain-achievement-toast .toast-name {
          font-size: 16px;
          color: #fff;
          font-weight: 600;
          margin: 2px 0;
        }
        .brain-achievement-toast .toast-desc {
          font-size: 12px;
          color: #888;
        }
      `;
      document.head.appendChild(styles);
    }
    
    toastContainer.appendChild(toast);
    
    // Remove after 5 seconds
    setTimeout(() => {
      toast.style.animation = 'slideOut 0.3s ease forwards';
      setTimeout(() => toast.remove(), 300);
    }, 5000);
    
    // Play sound if available
    this.playAchievementSound();
  }
  
  /**
   * Play achievement unlock sound
   */
  playAchievementSound() {
    try {
      // Simple tone using Web Audio API
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      
      oscillator.frequency.setValueAtTime(523.25, audioContext.currentTime); // C5
      oscillator.frequency.setValueAtTime(659.25, audioContext.currentTime + 0.1); // E5
      oscillator.frequency.setValueAtTime(783.99, audioContext.currentTime + 0.2); // G5
      
      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.5);
      
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.5);
    } catch (e) {
      // Audio not available, silently ignore
    }
  }
  
  // ===========================================
  // STREAK MANAGEMENT
  // ===========================================
  
  /**
   * Update streak based on activity
   * Called when observations are recorded
   */
  updateStreak() {
    if (!this.graph) return;
    if (!this.graph.stats) this.graph.stats = {};
    
    const today = new Date().toISOString().split('T')[0];
    const lastActiveDate = this.graph.stats.lastActiveDate;
    
    if (!lastActiveDate) {
      // First ever activity
      this.graph.stats.streak = 1;
      this.graph.stats.lastActiveDate = today;
      this.graph.stats.longestStreak = 1;
      return;
    }
    
    if (lastActiveDate === today) {
      // Already active today, no change
      return;
    }
    
    // Check if yesterday
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    
    if (lastActiveDate === yesterday) {
      // Consecutive day - increment streak
      this.graph.stats.streak = (this.graph.stats.streak || 0) + 1;
      
      // Update longest streak
      if (this.graph.stats.streak > (this.graph.stats.longestStreak || 0)) {
        this.graph.stats.longestStreak = this.graph.stats.streak;
      }
      
      // Check for streak milestones
      const streakMilestones = [7, 14, 30, 60, 100];
      if (streakMilestones.includes(this.graph.stats.streak)) {
        this.showStreakMilestoneToast(this.graph.stats.streak);
      }
    } else {
      // Streak broken
      const oldStreak = this.graph.stats.streak || 0;
      if (oldStreak >= 3) {
        console.log(`[Brain] Streak broken after ${oldStreak} days`);
      }
      this.graph.stats.streak = 1;
    }
    
    this.graph.stats.lastActiveDate = today;
  }
  
  /**
   * Show streak milestone toast
   */
  showStreakMilestoneToast(days) {
    const milestoneMessages = {
      7: { icon: '🔥', title: 'Week Warrior!', desc: '7 days of continuous learning!' },
      14: { icon: '⚡', title: 'Two Week Titan!', desc: '14 days strong!' },
      30: { icon: '🏆', title: 'Month Master!', desc: '30 days of dedication!' },
      60: { icon: '💎', title: 'Diamond Dedication!', desc: '60 days - incredible!' },
      100: { icon: '👑', title: 'Century Legend!', desc: '100 days - you\'re unstoppable!' }
    };
    
    const milestone = milestoneMessages[days];
    if (!milestone) return;
    
    this.showAchievementToast({
      icon: milestone.icon,
      name: milestone.title,
      description: milestone.desc
    });
  }
  
  /**
   * Get streak info for display
   */
  getStreakInfo() {
    const stats = this.graph?.stats || {};
    return {
      current: stats.streak || 0,
      longest: stats.longestStreak || 0,
      lastActiveDate: stats.lastActiveDate,
      isActiveToday: stats.lastActiveDate === new Date().toISOString().split('T')[0]
    };
  }
  
  // ===========================================
  // GOALS & PROGRESS
  // ===========================================
  
  /**
   * Get progress toward predefined goals
   */
  getGoalsProgress() {
    const stats = this.getAchievementStats();
    
    return [
      {
        id: 'learn_100',
        name: 'Learn 100 things about user',
        icon: '📚',
        current: stats.totalObservations,
        target: 100,
        percent: Math.min(100, Math.round((stats.totalObservations / 100) * 100))
      },
      {
        id: 'week_streak',
        name: 'Maintain 7-day streak',
        icon: '🔥',
        current: stats.streak,
        target: 7,
        percent: Math.min(100, Math.round((stats.streak / 7) * 100))
      },
      {
        id: 'accuracy_90',
        name: 'Achieve 90% accuracy',
        icon: '🎯',
        current: Math.round(stats.accuracy * 100),
        target: 90,
        percent: Math.min(100, Math.round((stats.accuracy / 0.9) * 100))
      },
      {
        id: 'all_achievements',
        name: 'Unlock all achievements',
        icon: '🏆',
        current: (this.graph?.achievements?.unlocked || []).length,
        target: BrainModule.ACHIEVEMENTS.length,
        percent: Math.round(((this.graph?.achievements?.unlocked || []).length / BrainModule.ACHIEVEMENTS.length) * 100)
      }
    ];
  }
  
  // ===========================================
  // PHASE 5: INTELLIGENCE
  // ===========================================
  
  /**
   * Detect patterns from observation history
   * Analyzes changelog to find recurring behaviors
   */
  detectPatterns() {
    if (!this.graph?.changelog) return [];
    
    const patterns = [];
    const changelog = this.graph.changelog;
    
    // Group by category and field
    const groups = {};
    for (const entry of changelog) {
      const key = `${entry.category}:${entry.field}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(entry);
    }
    
    // Find patterns (3+ occurrences)
    for (const [key, entries] of Object.entries(groups)) {
      if (entries.length >= 3) {
        // Check for value consistency
        const values = entries.map(e => e.value);
        const valueCounts = {};
        values.forEach(v => { valueCounts[v] = (valueCounts[v] || 0) + 1; });
        
        const [category, field] = key.split(':');
        const mostCommon = Object.entries(valueCounts).sort((a, b) => b[1] - a[1])[0];
        
        if (mostCommon && mostCommon[1] >= 3) {
          patterns.push({
            type: 'preference',
            category,
            field,
            value: mostCommon[0],
            occurrences: mostCommon[1],
            consistency: mostCommon[1] / entries.length,
            confidence: Math.min(0.95, 0.5 + (mostCommon[1] * 0.1)),
            lastSeen: entries[entries.length - 1].date
          });
        }
      }
    }
    
    // Detect time-based patterns
    const timePatterns = this.detectTimePatterns(changelog);
    patterns.push(...timePatterns);
    
    // Detect sequence patterns
    const sequencePatterns = this.detectSequencePatterns(changelog);
    patterns.push(...sequencePatterns);
    
    // Store detected patterns
    if (!this.graph.patterns) this.graph.patterns = {};
    this.graph.patterns.detected = patterns;
    this.graph.patterns.lastAnalysis = new Date().toISOString();
    
    // Update stats
    if (!this.graph.stats) this.graph.stats = {};
    this.graph.stats.patternsDetected = patterns.length;
    
    return patterns;
  }
  
  /**
   * Detect time-based patterns (e.g., active hours)
   */
  detectTimePatterns(changelog) {
    const patterns = [];
    const hourCounts = new Array(24).fill(0);
    const dayCounts = new Array(7).fill(0);
    
    for (const entry of changelog) {
      if (!entry.date) continue;
      const date = new Date(entry.date);
      hourCounts[date.getHours()]++;
      dayCounts[date.getDay()]++;
    }
    
    // Find peak hours (top 3)
    const peakHours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .filter(h => h.count >= 3);
    
    if (peakHours.length > 0) {
      const startHour = Math.min(...peakHours.map(h => h.hour));
      const endHour = Math.max(...peakHours.map(h => h.hour));
      
      patterns.push({
        type: 'temporal',
        name: 'active_hours',
        value: `${startHour}:00-${endHour + 1}:00`,
        peakHours: peakHours.map(h => h.hour),
        confidence: 0.7,
        description: `Most active between ${startHour}:00 and ${endHour + 1}:00`
      });
    }
    
    // Find peak days
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const peakDay = dayCounts.indexOf(Math.max(...dayCounts));
    const totalDays = dayCounts.reduce((a, b) => a + b, 0);
    
    if (dayCounts[peakDay] / totalDays > 0.2) {
      patterns.push({
        type: 'temporal',
        name: 'peak_day',
        value: dayNames[peakDay],
        confidence: 0.6,
        description: `Most active on ${dayNames[peakDay]}s`
      });
    }
    
    return patterns;
  }
  
  /**
   * Detect sequence patterns (e.g., always does X before Y)
   */
  detectSequencePatterns(changelog) {
    const patterns = [];
    const sequences = {};
    
    // Look at consecutive pairs
    for (let i = 1; i < changelog.length; i++) {
      const prev = changelog[i - 1];
      const curr = changelog[i];
      
      if (!prev.field || !curr.field) continue;
      
      const key = `${prev.field}→${curr.field}`;
      sequences[key] = (sequences[key] || 0) + 1;
    }
    
    // Find common sequences
    for (const [seq, count] of Object.entries(sequences)) {
      if (count >= 3) {
        const [from, to] = seq.split('→');
        patterns.push({
          type: 'sequence',
          name: 'workflow_pattern',
          from,
          to,
          occurrences: count,
          confidence: Math.min(0.8, 0.4 + (count * 0.1)),
          description: `Often does "${from}" before "${to}"`
        });
      }
    }
    
    return patterns;
  }
  
  /**
   * Generate proactive suggestions based on patterns
   * Returns suggestions that might be helpful right now
   */
  generateSuggestions() {
    const suggestions = [];
    const patterns = this.graph?.patterns?.detected || [];
    const prefs = this.graph?.preferences || {};
    
    // Time-based suggestions
    const now = new Date();
    const currentHour = now.getHours();
    
    const timePattern = patterns.find(p => p.name === 'active_hours');
    if (timePattern && timePattern.peakHours) {
      if (!timePattern.peakHours.includes(currentHour)) {
        // Outside normal hours
        suggestions.push({
          type: 'observation',
          priority: 'low',
          message: `You're working outside your usual hours (${timePattern.value}). Taking a break?`,
          icon: '⏰'
        });
      }
    }
    
    // Preference-based suggestions
    if (prefs.coding?.naming?.value === 'camelCase' && prefs.coding?.naming?.confidence > 0.8) {
      suggestions.push({
        type: 'reminder',
        priority: 'info',
        message: `Remember: You prefer camelCase for naming`,
        icon: '💡',
        context: 'coding'
      });
    }
    
    // Streak suggestions
    const streakInfo = this.getStreakInfo();
    if (streakInfo.current > 0 && !streakInfo.isActiveToday) {
      suggestions.push({
        type: 'motivation',
        priority: 'medium',
        message: `Keep your ${streakInfo.current}-day streak alive! Record something today.`,
        icon: '🔥'
      });
    }
    
    // Achievement progress suggestions
    const goals = this.getGoalsProgress();
    const nearComplete = goals.filter(g => g.percent >= 80 && g.percent < 100);
    for (const goal of nearComplete) {
      suggestions.push({
        type: 'achievement',
        priority: 'low',
        message: `Almost there! ${goal.name} is ${goal.percent}% complete`,
        icon: goal.icon
      });
    }
    
    return suggestions;
  }
  
  /**
   * Generate journal-style narrative for a time period
   * @param {string} period - 'today', 'week', 'month'
   */
  generateJournalEntry(period = 'today') {
    const changelog = this.graph?.changelog || [];
    const prefs = this.graph?.preferences || {};
    const stats = this.graph?.stats || {};
    
    let startDate;
    const now = new Date();
    
    switch (period) {
      case 'today':
        startDate = new Date(now.setHours(0, 0, 0, 0));
        break;
      case 'week':
        startDate = new Date(now.setDate(now.getDate() - 7));
        break;
      case 'month':
        startDate = new Date(now.setMonth(now.getMonth() - 1));
        break;
      default:
        startDate = new Date(now.setHours(0, 0, 0, 0));
    }
    
    // Filter relevant entries
    const relevantEntries = changelog.filter(e => new Date(e.date) >= startDate);
    
    if (relevantEntries.length === 0) {
      return {
        period,
        title: `Nothing recorded ${period === 'today' ? 'today' : `this ${period}`}`,
        narrative: 'No new observations to report.',
        stats: { observations: 0 }
      };
    }
    
    // Group by category
    const byCategory = {};
    for (const entry of relevantEntries) {
      if (!byCategory[entry.category]) byCategory[entry.category] = [];
      byCategory[entry.category].push(entry);
    }
    
    // Generate narrative
    const parts = [];
    
    // Opening
    const dateStr = period === 'today' 
      ? new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
      : `the past ${period}`;
    parts.push(`## What I Learned — ${dateStr}\n`);
    
    // Stats summary
    parts.push(`📊 **${relevantEntries.length} observations** recorded\n`);
    
    // By category
    for (const [cat, entries] of Object.entries(byCategory)) {
      const catTitle = cat.charAt(0).toUpperCase() + cat.slice(1);
      parts.push(`\n### ${catTitle}\n`);
      
      const uniqueFields = [...new Set(entries.map(e => e.field))];
      for (const field of uniqueFields.slice(0, 5)) {
        const fieldEntries = entries.filter(e => e.field === field);
        const latestValue = fieldEntries[fieldEntries.length - 1].value;
        parts.push(`- **${field}**: ${latestValue}`);
        if (fieldEntries.length > 1) {
          parts.push(` _(confirmed ${fieldEntries.length}x)_`);
        }
        parts.push('\n');
      }
    }
    
    // Patterns noticed
    const patterns = this.detectPatterns();
    const newPatterns = patterns.filter(p => {
      const lastSeen = new Date(p.lastSeen || 0);
      return lastSeen >= startDate;
    });
    
    if (newPatterns.length > 0) {
      parts.push(`\n### Patterns Noticed\n`);
      for (const p of newPatterns.slice(0, 3)) {
        parts.push(`- ${p.description || p.name}\n`);
      }
    }
    
    // Closing
    if (stats.streak > 1) {
      parts.push(`\n---\n🔥 *${stats.streak}-day learning streak continues!*\n`);
    }
    
    return {
      period,
      title: `Learning Journal — ${dateStr}`,
      narrative: parts.join(''),
      stats: {
        observations: relevantEntries.length,
        categories: Object.keys(byCategory).length,
        patterns: newPatterns.length
      }
    };
  }
  
  /**
   * Check if an inference needs user verification
   * High-impact inferences should be confirmed before acting on them
   */
  needsVerification(observation) {
    // Always verify:
    // 1. Low confidence observations that would override high-confidence existing
    // 2. Sensitive categories (financial, personal)
    // 3. Significant behavior changes
    
    const sensitiveCategories = ['financial', 'personal', 'health', 'security'];
    const highImpactFields = ['timezone', 'location', 'name', 'email', 'phone'];
    
    // Check if sensitive
    if (sensitiveCategories.includes(observation.category)) {
      return { needs: true, reason: 'sensitive_category', priority: 'high' };
    }
    
    // Check if high-impact field
    if (highImpactFields.includes(observation.field)) {
      return { needs: true, reason: 'high_impact_field', priority: 'high' };
    }
    
    // Check confidence threshold
    if (observation.confidence < 0.5) {
      // Would this override something more confident?
      const existing = this.getExistingObservation(observation);
      if (existing && existing.confidence > 0.7) {
        return { needs: true, reason: 'override_confident', priority: 'medium' };
      }
    }
    
    // Check for contradictions
    const contradictions = this.detectContradictions(observation);
    if (contradictions.length > 0 && contradictions.some(c => c.severity === 'high')) {
      return { needs: true, reason: 'contradiction', priority: 'high', contradictions };
    }
    
    return { needs: false };
  }
  
  /**
   * Get existing observation for a field
   */
  getExistingObservation(obs) {
    if (!this.graph?.preferences) return null;
    
    const section = obs.section || 'communication';
    return this.graph.preferences[section]?.[obs.field] || null;
  }
  
  /**
   * Show verification prompt for high-impact inference
   */
  showVerificationPrompt(observation, reason) {
    return new Promise((resolve) => {
      // Create modal
      const modal = document.createElement('div');
      modal.className = 'brain-verification-modal';
      modal.innerHTML = `
        <div class="verification-backdrop"></div>
        <div class="verification-content">
          <div class="verification-header">
            <span class="verification-icon">🤔</span>
            <span class="verification-title">Confirm Observation?</span>
          </div>
          <div class="verification-body">
            <p>I noticed something that might be important:</p>
            <div class="verification-observation">
              <strong>${observation.field}</strong>: ${observation.value}
            </div>
            <p class="verification-reason">
              ${reason === 'sensitive_category' ? 'This is sensitive information.' : ''}
              ${reason === 'high_impact_field' ? 'This is important profile data.' : ''}
              ${reason === 'override_confident' ? 'This would change something I was confident about.' : ''}
              ${reason === 'contradiction' ? 'This conflicts with existing knowledge.' : ''}
            </p>
          </div>
          <div class="verification-actions">
            <button class="verify-btn confirm">✓ Correct</button>
            <button class="verify-btn deny">✗ Wrong</button>
            <button class="verify-btn skip">Skip</button>
          </div>
        </div>
      `;
      
      // Add styles
      modal.style.cssText = `
        position: fixed;
        inset: 0;
        z-index: 10001;
        display: flex;
        align-items: center;
        justify-content: center;
      `;
      
      const style = document.createElement('style');
      style.textContent = `
        .verification-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
        }
        .verification-content {
          position: relative;
          background: var(--bg-primary, #1e1e2e);
          border: 1px solid var(--border-color, #333);
          border-radius: 12px;
          padding: 24px;
          max-width: 400px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
        }
        .verification-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        .verification-icon { font-size: 24px; }
        .verification-title { font-size: 18px; font-weight: 600; color: #fff; }
        .verification-body p { color: #888; margin: 8px 0; }
        .verification-observation {
          background: var(--bg-secondary, #252535);
          padding: 12px 16px;
          border-radius: 8px;
          margin: 12px 0;
          color: #fff;
        }
        .verification-reason { font-style: italic; font-size: 13px; }
        .verification-actions {
          display: flex;
          gap: 8px;
          margin-top: 20px;
        }
        .verify-btn {
          flex: 1;
          padding: 10px;
          border: none;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          transition: transform 0.2s;
        }
        .verify-btn:hover { transform: translateY(-1px); }
        .verify-btn.confirm { background: #22c55e; color: #fff; }
        .verify-btn.deny { background: #ef4444; color: #fff; }
        .verify-btn.skip { background: #333; color: #888; }
      `;
      
      document.head.appendChild(style);
      document.body.appendChild(modal);
      
      // Handle actions
      modal.querySelector('.confirm').onclick = () => {
        modal.remove();
        resolve({ action: 'confirm', observation });
      };
      modal.querySelector('.deny').onclick = () => {
        modal.remove();
        resolve({ action: 'deny', observation });
      };
      modal.querySelector('.skip').onclick = () => {
        modal.remove();
        resolve({ action: 'skip', observation });
      };
      modal.querySelector('.verification-backdrop').onclick = () => {
        modal.remove();
        resolve({ action: 'skip', observation });
      };
    });
  }
}

// Create global instance
window.brainModule = new BrainModule();

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
  module.exports = BrainModule;
}

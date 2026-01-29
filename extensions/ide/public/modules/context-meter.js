/**
 * Context Meter Module - Real-time Token Usage Display
 * 
 * Inspired by Vercel AI SDK Context Component, adapted for Clawd IDE.
 * 
 * Features:
 * - SVG progress ring in status bar (like Vercel)
 * - Hover popover with token breakdown
 * - Color-coded thresholds (green/amber/red)
 * - Auto-refresh every 30 seconds
 * - Keyboard shortcut: Cmd+Shift+C
 * 
 * Comparison with Vercel AI SDK:
 * ✅ Progress ring visualization
 * ✅ Token breakdown (input, output, cached)
 * ✅ Intelligent formatting (K, M suffixes)
 * ✅ Interactive hover card
 * ✅ Color-coded by usage level
 * ➕ DNA-specific: /compact and /new suggestions
 * ➕ DNA-specific: Compaction status indicator
 * ➕ DNA-specific: Session duration tracking
 * ❌ Cost estimation (not applicable - self-hosted)
 */

class ContextMeterModule {
  constructor() {
    this.usage = null;
    this.lastUpdate = null;
    this.popoverVisible = false;
    this.statusBarElement = null;
    this.popoverElement = null;
    this.refreshInterval = null;
    
    this.init = this.init.bind(this);
    this.refresh = this.refresh.bind(this);
    this.togglePopover = this.togglePopover.bind(this);
  }

  /**
   * Initialize the Context Meter
   */
  async init() {
    try {
      console.log('[ContextMeter] Initializing...');
      
      // Wait for DOM
      if (document.readyState === 'loading') {
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve));
      }
      
      // Small delay for status bar
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Create UI
      this.createStatusBar();
      this.createPopover();
      this.injectStyles();
      
      // Initial fetch
      await this.refresh();
      
      // Auto-refresh every 30 seconds
      this.refreshInterval = setInterval(() => this.refresh(), 30000);
      
      // Keyboard shortcut: Cmd+Shift+C
      document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'C') {
          e.preventDefault();
          this.togglePopover();
        }
      });
      
      console.log('[ContextMeter] Initialized successfully');
    } catch (err) {
      console.error('[ContextMeter] Init failed:', err);
    }
  }

  /**
   * Create status bar indicator with SVG progress ring
   */
  createStatusBar() {
    const statusBar = document.querySelector('.status-bar-right') || document.querySelector('.status-bar');
    if (!statusBar) {
      console.warn('[ContextMeter] Status bar not found');
      return;
    }

    this.statusBarElement = document.createElement('div');
    this.statusBarElement.className = 'context-meter-indicator';
    this.statusBarElement.innerHTML = this.getStatusBarHTML(0);
    this.statusBarElement.title = 'Context Usage (Cmd+Shift+C)';
    this.statusBarElement.addEventListener('click', () => this.togglePopover());
    
    // Insert before brain indicator if exists, otherwise prepend
    const brainIndicator = statusBar.querySelector('.brain-status-indicator');
    if (brainIndicator) {
      statusBar.insertBefore(this.statusBarElement, brainIndicator);
    } else {
      statusBar.prepend(this.statusBarElement);
    }
  }

  /**
   * Generate status bar HTML with SVG progress ring
   */
  getStatusBarHTML(percent) {
    const radius = 8;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (percent / 100) * circumference;
    const color = this.getColorForPercent(percent);
    
    return `
      <svg class="context-meter-ring" width="20" height="20" viewBox="0 0 20 20">
        <circle 
          class="context-meter-ring-bg" 
          cx="10" cy="10" r="${radius}" 
          fill="none" 
          stroke="var(--border-color, #333)" 
          stroke-width="2"
        />
        <circle 
          class="context-meter-ring-progress" 
          cx="10" cy="10" r="${radius}" 
          fill="none" 
          stroke="${color}" 
          stroke-width="2"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${strokeDashoffset}"
          stroke-linecap="round"
          transform="rotate(-90 10 10)"
        />
      </svg>
      <span class="context-meter-text" style="color: ${color}">${percent}%</span>
    `;
  }

  /**
   * Get color based on usage percentage
   */
  getColorForPercent(percent) {
    if (percent >= 90) return '#ef4444'; // Red - critical
    if (percent >= 80) return '#f97316'; // Orange - high
    if (percent >= 70) return '#eab308'; // Yellow - elevated
    if (percent >= 60) return '#84cc16'; // Lime - moderate
    return '#22c55e'; // Green - healthy
  }

  /**
   * Create popover element
   */
  createPopover() {
    this.popoverElement = document.createElement('div');
    this.popoverElement.className = 'context-meter-popover';
    this.popoverElement.style.display = 'none';
    document.body.appendChild(this.popoverElement);

    // Close on click outside
    document.addEventListener('click', (e) => {
      if (this.popoverVisible && 
          !this.popoverElement.contains(e.target) && 
          !this.statusBarElement?.contains(e.target)) {
        this.hidePopover();
      }
    });
  }

  /**
   * Generate popover HTML
   */
  getPopoverHTML() {
    const usage = this.usage || {};
    const percent = usage.percent || 0;
    const tokens = usage.tokens || 0;
    const maxTokens = usage.maxTokens || 200000;
    const inputTokens = usage.inputTokens || 0;
    const outputTokens = usage.outputTokens || 0;
    const cachedTokens = usage.cachedTokens || 0;
    const sessionDuration = usage.sessionDuration || 0;
    const compactionStatus = usage.compactionStatus || 'available';
    
    const color = this.getColorForPercent(percent);
    const suggestion = this.getSuggestion(percent, compactionStatus);
    
    return `
      <div class="context-meter-header">
        <div class="context-meter-title">
          ${this.getLargeProgressRing(percent, color)}
          <div class="context-meter-title-text">
            <span class="context-meter-percent" style="color: ${color}">${percent}%</span>
            <span class="context-meter-label">Context Used</span>
          </div>
        </div>
      </div>
      
      <div class="context-meter-body">
        <div class="context-meter-breakdown">
          <div class="context-meter-row">
            <span class="context-meter-row-label">📥 Input</span>
            <span class="context-meter-row-value">${this.formatTokens(inputTokens)}</span>
          </div>
          <div class="context-meter-row">
            <span class="context-meter-row-label">📤 Output</span>
            <span class="context-meter-row-value">${this.formatTokens(outputTokens)}</span>
          </div>
          <div class="context-meter-row">
            <span class="context-meter-row-label">💾 Cached</span>
            <span class="context-meter-row-value">${this.formatTokens(cachedTokens)}</span>
          </div>
          <div class="context-meter-row context-meter-row-total">
            <span class="context-meter-row-label">Total</span>
            <span class="context-meter-row-value">${this.formatTokens(tokens)} / ${this.formatTokens(maxTokens)}</span>
          </div>
        </div>
        
        <div class="context-meter-meta">
          <div class="context-meter-row">
            <span class="context-meter-row-label">⏱️ Session</span>
            <span class="context-meter-row-value">${this.formatDuration(sessionDuration)}</span>
          </div>
          <div class="context-meter-row">
            <span class="context-meter-row-label">🗜️ Compaction</span>
            <span class="context-meter-row-value context-meter-compaction-${compactionStatus}">${this.formatCompactionStatus(compactionStatus)}</span>
          </div>
        </div>
        
        ${suggestion ? `
          <div class="context-meter-suggestion" style="border-left-color: ${color}">
            ${suggestion}
          </div>
        ` : ''}
      </div>
      
      <div class="context-meter-footer">
        <span class="context-meter-updated">Updated ${this.formatTimeAgo(this.lastUpdate)}</span>
        <button class="context-meter-refresh" onclick="window.contextMeter?.refresh()">↻ Refresh</button>
      </div>
    `;
  }

  /**
   * Generate large progress ring for popover header
   */
  getLargeProgressRing(percent, color) {
    const radius = 28;
    const circumference = 2 * Math.PI * radius;
    const strokeDashoffset = circumference - (percent / 100) * circumference;
    
    return `
      <svg class="context-meter-large-ring" width="70" height="70" viewBox="0 0 70 70">
        <circle 
          cx="35" cy="35" r="${radius}" 
          fill="none" 
          stroke="var(--border-color, #333)" 
          stroke-width="4"
        />
        <circle 
          cx="35" cy="35" r="${radius}" 
          fill="none" 
          stroke="${color}" 
          stroke-width="4"
          stroke-dasharray="${circumference}"
          stroke-dashoffset="${strokeDashoffset}"
          stroke-linecap="round"
          transform="rotate(-90 35 35)"
        />
      </svg>
    `;
  }

  /**
   * Get suggestion based on usage level
   */
  getSuggestion(percent, compactionStatus) {
    if (compactionStatus === 'failed' || compactionStatus === 'blocked') {
      return '⚠️ Compaction stuck. <code>/new</code> is the clean fix.';
    }
    
    if (percent >= 90) {
      return '🚨 Critical! <code>/new</code> now — session at risk.';
    }
    if (percent >= 80) {
      return '⚠️ Recommend <code>/new</code> — work is saved to memory.';
    }
    if (percent >= 70) {
      return '💡 Consider <code>/compact</code> or <code>/new</code>.';
    }
    if (percent >= 60) {
      return '🗜️ Good time for <code>/compact</code> if you want.';
    }
    if (percent >= 50) {
      return '✨ <code>/compact</code> available if things feel slow.';
    }
    return null;
  }

  /**
   * Format token count with K/M suffix
   */
  formatTokens(tokens) {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    }
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(0)}K`;
    }
    return tokens.toString();
  }

  /**
   * Format duration in human-readable form
   */
  formatDuration(minutes) {
    if (!minutes || minutes < 1) return 'Just started';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  }

  /**
   * Format compaction status
   */
  formatCompactionStatus(status) {
    const statusMap = {
      'available': '✅ Available',
      'blocked': '🚫 Blocked',
      'failed': '❌ Failed',
      'recent': '⏳ Recent',
    };
    return statusMap[status] || status;
  }

  /**
   * Format time ago
   */
  formatTimeAgo(date) {
    if (!date) return 'never';
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    return `${Math.floor(seconds / 3600)}h ago`;
  }

  /**
   * Toggle popover visibility
   */
  togglePopover() {
    if (this.popoverVisible) {
      this.hidePopover();
    } else {
      this.showPopover();
    }
  }

  /**
   * Show popover
   */
  showPopover() {
    if (!this.popoverElement || !this.statusBarElement) return;
    
    this.popoverElement.innerHTML = this.getPopoverHTML();
    
    // Position above status bar (similar to brain popover fix)
    const rect = this.statusBarElement.getBoundingClientRect();
    const bottomPosition = window.innerHeight - rect.top + 8;
    const rightPosition = Math.max(10, window.innerWidth - rect.right);
    
    this.popoverElement.style.position = 'fixed';
    this.popoverElement.style.bottom = `${bottomPosition}px`;
    this.popoverElement.style.right = `${rightPosition}px`;
    this.popoverElement.style.top = 'auto';
    this.popoverElement.style.maxHeight = `${rect.top - 20}px`;
    this.popoverElement.style.display = 'block';
    
    this.popoverVisible = true;
  }

  /**
   * Hide popover
   */
  hidePopover() {
    if (!this.popoverElement) return;
    this.popoverElement.style.display = 'none';
    this.popoverVisible = false;
  }

  /**
   * Refresh usage data from server
   */
  async refresh() {
    try {
      const response = await fetch('/api/context/usage');
      if (!response.ok) {
        // Fallback: estimate from session
        await this.estimateUsage();
        return;
      }
      
      this.usage = await response.json();
      this.lastUpdate = new Date();
      this.updateUI();
    } catch (err) {
      console.warn('[ContextMeter] Refresh failed, using estimate:', err.message);
      await this.estimateUsage();
    }
  }

  /**
   * Estimate usage when API not available
   */
  async estimateUsage() {
    // Use localStorage to track rough session info
    const sessionStart = localStorage.getItem('clawdSessionStart');
    const messageCount = parseInt(localStorage.getItem('clawdMessageCount') || '0');
    
    if (!sessionStart) {
      localStorage.setItem('clawdSessionStart', Date.now().toString());
    }
    
    // Rough estimate: 2K tokens per message on average
    const estimatedTokens = messageCount * 2000;
    const maxTokens = 200000; // Assume Opus
    
    this.usage = {
      percent: Math.min(99, Math.round((estimatedTokens / maxTokens) * 100)),
      tokens: estimatedTokens,
      maxTokens: maxTokens,
      inputTokens: Math.round(estimatedTokens * 0.7),
      outputTokens: Math.round(estimatedTokens * 0.3),
      cachedTokens: 0,
      sessionDuration: sessionStart ? Math.round((Date.now() - parseInt(sessionStart)) / 60000) : 0,
      compactionStatus: 'available',
      estimated: true,
    };
    
    this.lastUpdate = new Date();
    this.updateUI();
  }

  /**
   * Update UI elements
   */
  updateUI() {
    if (!this.usage) return;
    
    const percent = this.usage.percent || 0;
    
    // Update status bar
    if (this.statusBarElement) {
      this.statusBarElement.innerHTML = this.getStatusBarHTML(percent);
      
      // Add pulse animation for high usage
      if (percent >= 80) {
        this.statusBarElement.classList.add('context-meter-pulse');
      } else {
        this.statusBarElement.classList.remove('context-meter-pulse');
      }
    }
    
    // Update popover if visible
    if (this.popoverVisible && this.popoverElement) {
      this.popoverElement.innerHTML = this.getPopoverHTML();
    }
  }

  /**
   * Inject CSS styles
   */
  injectStyles() {
    if (document.getElementById('context-meter-styles')) return;
    
    const style = document.createElement('style');
    style.id = 'context-meter-styles';
    style.textContent = `
      /* Status Bar Indicator */
      .context-meter-indicator {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 2px 8px;
        cursor: pointer;
        border-radius: 4px;
        transition: background-color 0.2s;
        margin-right: 8px;
      }
      
      .context-meter-indicator:hover {
        background-color: var(--hover-bg, rgba(255,255,255,0.1));
      }
      
      .context-meter-ring {
        flex-shrink: 0;
      }
      
      .context-meter-text {
        font-size: 11px;
        font-weight: 500;
        font-family: 'JetBrains Mono', monospace;
      }
      
      .context-meter-pulse {
        animation: context-meter-pulse 2s ease-in-out infinite;
      }
      
      @keyframes context-meter-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.6; }
      }
      
      /* Popover */
      .context-meter-popover {
        background: var(--dropdown-bg, #1e1e1e);
        border: 1px solid var(--border-color, #333);
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        width: 280px;
        z-index: 10000;
        overflow: hidden;
        font-size: 12px;
      }
      
      .context-meter-header {
        padding: 16px;
        background: var(--sidebar-bg, #252526);
        border-bottom: 1px solid var(--border-color, #333);
      }
      
      .context-meter-title {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      
      .context-meter-title-text {
        display: flex;
        flex-direction: column;
      }
      
      .context-meter-percent {
        font-size: 24px;
        font-weight: 600;
        font-family: 'JetBrains Mono', monospace;
      }
      
      .context-meter-label {
        color: var(--text-muted, #888);
        font-size: 11px;
      }
      
      .context-meter-body {
        padding: 12px 16px;
      }
      
      .context-meter-breakdown,
      .context-meter-meta {
        margin-bottom: 12px;
      }
      
      .context-meter-row {
        display: flex;
        justify-content: space-between;
        padding: 4px 0;
      }
      
      .context-meter-row-label {
        color: var(--text-muted, #888);
      }
      
      .context-meter-row-value {
        font-family: 'JetBrains Mono', monospace;
        color: var(--text-color, #ccc);
      }
      
      .context-meter-row-total {
        border-top: 1px solid var(--border-color, #333);
        margin-top: 4px;
        padding-top: 8px;
        font-weight: 500;
      }
      
      .context-meter-compaction-available { color: #22c55e; }
      .context-meter-compaction-blocked { color: #f97316; }
      .context-meter-compaction-failed { color: #ef4444; }
      .context-meter-compaction-recent { color: #eab308; }
      
      .context-meter-suggestion {
        background: var(--input-bg, #2d2d2d);
        padding: 10px 12px;
        border-radius: 6px;
        border-left: 3px solid;
        margin-top: 8px;
        line-height: 1.4;
      }
      
      .context-meter-suggestion code {
        background: var(--code-bg, #1e1e1e);
        padding: 2px 6px;
        border-radius: 3px;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
      }
      
      .context-meter-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px 16px;
        background: var(--sidebar-bg, #252526);
        border-top: 1px solid var(--border-color, #333);
      }
      
      .context-meter-updated {
        color: var(--text-muted, #888);
        font-size: 10px;
      }
      
      .context-meter-refresh {
        background: none;
        border: none;
        color: var(--link-color, #4fc3f7);
        cursor: pointer;
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 4px;
      }
      
      .context-meter-refresh:hover {
        background: var(--hover-bg, rgba(255,255,255,0.1));
      }
    `;
    
    document.head.appendChild(style);
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
    }
    this.statusBarElement?.remove();
    this.popoverElement?.remove();
    document.getElementById('context-meter-styles')?.remove();
  }
}

// Initialize and export
window.contextMeter = new ContextMeterModule();

// Auto-init when DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.contextMeter.init());
} else {
  window.contextMeter.init();
}

export default ContextMeterModule;

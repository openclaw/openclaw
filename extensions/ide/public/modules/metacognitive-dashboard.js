/**
 * METACOGNITIVE DASHBOARD
 * Phase 4: Unified self-improvement interface
 * 
 * Integrates all self-improvement modules:
 * - Self-Critique
 * - Learning Memory
 * - Confidence Calibration
 * - Reflexion Engine
 * - Pattern Recognition
 * - Style Analyzer
 * - Adaptive Completions
 * - Capability Tracker
 */

class MetacognitiveDashboard {
  constructor() {
    this.panel = null;
    this.isOpen = false;
    this.activeTab = 'overview';
    
    this.init();
    console.log('[MetacognitiveDashboard] Initialized');
  }

  /**
   * Initialize the dashboard
   */
  init() {
    // Create panel element
    this.createPanel();
    
    // Add keyboard shortcut
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'M') {
        e.preventDefault();
        this.toggle();
      }
    });
  }

  /**
   * Create the dashboard panel
   */
  createPanel() {
    this.panel = document.createElement('div');
    this.panel.className = 'metacognitive-dashboard hidden';
    this.panel.innerHTML = `
      <div class="metacog-overlay" onclick="metacognitiveDashboard.close()"></div>
      <div class="metacog-modal">
        <div class="metacog-header">
          <span class="metacog-icon">🧠</span>
          <span class="metacog-title">Metacognitive Dashboard</span>
          <span class="metacog-subtitle">Self-Improvement & Learning</span>
          <button class="metacog-close" onclick="metacognitiveDashboard.close()">×</button>
        </div>
        
        <div class="metacog-tabs">
          <button class="metacog-tab active" data-tab="overview" onclick="metacognitiveDashboard.switchTab('overview')">Overview</button>
          <button class="metacog-tab" data-tab="capabilities" onclick="metacognitiveDashboard.switchTab('capabilities')">Capabilities</button>
          <button class="metacog-tab" data-tab="learning" onclick="metacognitiveDashboard.switchTab('learning')">Learning</button>
          <button class="metacog-tab" data-tab="calibration" onclick="metacognitiveDashboard.switchTab('calibration')">Calibration</button>
          <button class="metacog-tab" data-tab="reflexions" onclick="metacognitiveDashboard.switchTab('reflexions')">Reflexions</button>
          <button class="metacog-tab" data-tab="style" onclick="metacognitiveDashboard.switchTab('style')">Style</button>
        </div>
        
        <div class="metacog-content" id="metacogContent">
          <!-- Content loaded dynamically -->
        </div>
        
        <div class="metacog-footer">
          <span class="metacog-hint">Press <kbd>Cmd+Shift+M</kbd> to toggle</span>
          <div class="metacog-actions">
            <button onclick="metacognitiveDashboard.exportAll()">Export Data</button>
            <button onclick="metacognitiveDashboard.refresh()">Refresh</button>
          </div>
        </div>
      </div>
    `;
    
    document.body.appendChild(this.panel);
  }

  /**
   * Toggle dashboard visibility
   */
  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  /**
   * Open dashboard
   */
  open() {
    this.isOpen = true;
    this.panel.classList.remove('hidden');
    this.switchTab(this.activeTab);
  }

  /**
   * Close dashboard
   */
  close() {
    this.isOpen = false;
    this.panel.classList.add('hidden');
  }

  /**
   * Switch to a tab
   */
  switchTab(tab) {
    this.activeTab = tab;
    
    // Update tab buttons
    this.panel.querySelectorAll('.metacog-tab').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    
    // Render content
    const content = document.getElementById('metacogContent');
    content.innerHTML = this.renderTab(tab);
  }

  /**
   * Render tab content
   */
  renderTab(tab) {
    switch (tab) {
      case 'overview': return this.renderOverview();
      case 'capabilities': return this.renderCapabilities();
      case 'learning': return this.renderLearning();
      case 'calibration': return this.renderCalibration();
      case 'reflexions': return this.renderReflexions();
      case 'style': return this.renderStyle();
      default: return '<div class="metacog-empty">Unknown tab</div>';
    }
  }

  /**
   * Render overview tab
   */
  renderOverview() {
    const stats = this.gatherStats();
    
    return `
      <div class="metacog-overview">
        <div class="overview-cards">
          <div class="overview-card">
            <div class="card-icon">📊</div>
            <div class="card-value">${stats.calibrationScore !== null ? (stats.calibrationScore * 100).toFixed(0) + '%' : '—'}</div>
            <div class="card-label">Calibration Score</div>
            <div class="card-detail">${stats.calibrationSamples} predictions tracked</div>
          </div>
          
          <div class="overview-card">
            <div class="card-icon">✅</div>
            <div class="card-value">${stats.completionRate !== null ? (stats.completionRate * 100).toFixed(0) + '%' : '—'}</div>
            <div class="card-label">Completion Acceptance</div>
            <div class="card-detail">${stats.totalCompletions} completions tracked</div>
          </div>
          
          <div class="overview-card">
            <div class="card-icon">🎯</div>
            <div class="card-value">${stats.topSkill || '—'}</div>
            <div class="card-label">Top Skill</div>
            <div class="card-detail">${stats.topSkillScore ? (stats.topSkillScore * 100).toFixed(0) + '%' : 'No data yet'}</div>
          </div>
          
          <div class="overview-card">
            <div class="card-icon">📝</div>
            <div class="card-value">${stats.learnedPatterns}</div>
            <div class="card-label">Learned Patterns</div>
            <div class="card-detail">${stats.mistakePatterns} mistakes avoided</div>
          </div>
        </div>
        
        <div class="overview-section">
          <h3>🔍 Recent Insights</h3>
          <div class="insights-list">
            ${stats.insights.map(i => `
              <div class="insight-item ${i.type}">
                <span class="insight-icon">${i.icon}</span>
                <span class="insight-text">${i.message}</span>
              </div>
            `).join('') || '<div class="metacog-empty">No insights yet</div>'}
          </div>
        </div>
        
        <div class="overview-section">
          <h3>💡 Suggestions</h3>
          <div class="suggestions-list">
            ${stats.suggestions.map(s => `
              <div class="suggestion-item ${s.priority}">
                <span class="suggestion-badge">${s.priority}</span>
                <span class="suggestion-text">${s.message}</span>
              </div>
            `).join('') || '<div class="metacog-empty">No suggestions</div>'}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render capabilities tab
   */
  renderCapabilities() {
    if (!window.capabilityTracker) {
      return '<div class="metacog-empty">Capability tracker not loaded</div>';
    }

    const summary = window.capabilityTracker.getSummary();
    
    return `
      <div class="metacog-capabilities">
        <div class="capability-header">
          <div class="capability-stat">
            <span class="stat-value">${summary.totalSkills}</span>
            <span class="stat-label">Skills Tracked</span>
          </div>
          <div class="capability-stat">
            <span class="stat-value">${(summary.averageScore * 100).toFixed(0)}%</span>
            <span class="stat-label">Average Score</span>
          </div>
          <div class="capability-stat">
            <span class="stat-value">${summary.improvingSkills.length}</span>
            <span class="stat-label">Improving</span>
          </div>
          <div class="capability-stat">
            <span class="stat-value">${summary.decliningSkills.length}</span>
            <span class="stat-label">Declining</span>
          </div>
        </div>
        
        <h3>📊 Skill Levels</h3>
        <div class="capability-chart-container" id="capabilityChart">
          ${this.renderCapabilityChart(summary.topSkills)}
        </div>
        
        <div class="capability-sections">
          <div class="capability-section">
            <h4>💪 Strengths</h4>
            ${summary.strengths.map(s => `
              <div class="strength-item">
                <span class="strength-name">${s.skill}</span>
                <span class="strength-score">${(s.score * 100).toFixed(0)}%</span>
              </div>
            `).join('') || '<div class="metacog-empty">Keep working to identify strengths</div>'}
          </div>
          
          <div class="capability-section">
            <h4>🎯 Areas to Improve</h4>
            ${summary.gaps.map(g => `
              <div class="gap-item">
                <span class="gap-name">${g.skill}</span>
                <span class="gap-score">${(g.score * 100).toFixed(0)}%</span>
                <span class="gap-priority ${g.priority}">${g.priority}</span>
              </div>
            `).join('') || '<div class="metacog-empty">No significant gaps identified</div>'}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render capability chart
   */
  renderCapabilityChart(skills) {
    if (!skills || skills.length === 0) {
      return '<div class="metacog-empty">Not enough data to show chart</div>';
    }

    return skills.map(skill => {
      const percentage = (skill.score * 100).toFixed(0);
      const trendIcon = skill.trend === 'improving' ? '↑' : skill.trend === 'declining' ? '↓' : '→';
      const levelClass = skill.score >= 0.7 ? 'high' : skill.score >= 0.5 ? 'medium' : 'low';
      
      return `
        <div class="chart-row">
          <div class="chart-label">${skill.name}</div>
          <div class="chart-bar-bg">
            <div class="chart-bar ${levelClass}" style="width: ${percentage}%"></div>
          </div>
          <div class="chart-value">${percentage}% ${trendIcon}</div>
        </div>
      `;
    }).join('');
  }

  /**
   * Render learning tab
   */
  renderLearning() {
    if (!window.learningMemory) {
      return '<div class="metacog-empty">Learning memory not loaded</div>';
    }

    const stats = window.learningMemory.getStats();
    
    return `
      <div class="metacog-learning">
        <div class="learning-stats">
          <div class="learning-stat">
            <span class="stat-icon">✅</span>
            <span class="stat-value">${stats.successes}</span>
            <span class="stat-label">Success Patterns</span>
          </div>
          <div class="learning-stat">
            <span class="stat-icon">⚠️</span>
            <span class="stat-value">${stats.mistakes}</span>
            <span class="stat-label">Mistake Patterns</span>
          </div>
          <div class="learning-stat">
            <span class="stat-icon">✏️</span>
            <span class="stat-value">${stats.corrections}</span>
            <span class="stat-label">User Corrections</span>
          </div>
          <div class="learning-stat">
            <span class="stat-icon">⚙️</span>
            <span class="stat-value">${stats.preferences}</span>
            <span class="stat-label">Preferences</span>
          </div>
        </div>
        
        <div class="learning-section">
          <h3>📚 Recent Learnings</h3>
          <div class="learning-timeline">
            ${this.renderLearningTimeline()}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Render learning timeline
   */
  renderLearningTimeline() {
    if (!window.learningMemory) return '';
    
    const memory = window.learningMemory.memory;
    const items = [
      ...memory.successes.slice(0, 5).map(s => ({ ...s, type: 'success' })),
      ...memory.mistakes.slice(0, 5).map(m => ({ ...m, type: 'mistake' })),
      ...memory.corrections.slice(0, 5).map(c => ({ ...c, type: 'correction' }))
    ].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);

    if (items.length === 0) {
      return '<div class="metacog-empty">No learning history yet</div>';
    }

    return items.map(item => {
      const icon = item.type === 'success' ? '✅' : item.type === 'mistake' ? '⚠️' : '✏️';
      const text = item.pattern || item.description || item.original?.slice(0, 50) + '...';
      const time = this.formatTime(item.timestamp);
      
      return `
        <div class="timeline-item ${item.type}">
          <span class="timeline-icon">${icon}</span>
          <span class="timeline-text">${text}</span>
          <span class="timeline-time">${time}</span>
        </div>
      `;
    }).join('');
  }

  /**
   * Render calibration tab
   */
  renderCalibration() {
    if (!window.confidenceCalibration) {
      return '<div class="metacog-empty">Confidence calibration not loaded</div>';
    }

    const score = window.confidenceCalibration.getScore();
    const breakdown = window.confidenceCalibration.getBreakdown();
    const trend = window.confidenceCalibration.getTrend();
    const analysis = window.confidenceCalibration.getConfidenceAnalysis();
    
    return `
      <div class="metacog-calibration">
        <div class="calibration-score">
          <div class="score-circle ${score !== null ? (score >= 0.85 ? 'good' : score >= 0.7 ? 'medium' : 'poor') : ''}">
            <span class="score-value">${score !== null ? (score * 100).toFixed(0) + '%' : '—'}</span>
            <span class="score-label">Calibration</span>
          </div>
          <div class="score-description">
            ${score !== null 
              ? `Your predictions match outcomes ${(score * 100).toFixed(0)}% of the time`
              : 'Need more predictions to calculate calibration'}
          </div>
          ${trend ? `<div class="score-trend ${trend.trend}">${trend.trend === 'improving' ? '📈 Improving' : trend.trend === 'declining' ? '📉 Declining' : '➡️ Stable'}</div>` : ''}
        </div>
        
        <h3>📊 Confidence vs Accuracy</h3>
        <div class="calibration-chart">
          ${breakdown.map(b => `
            <div class="calibration-bucket">
              <div class="bucket-bars">
                <div class="bucket-bar expected" style="height: ${b.expected * 100}%"></div>
                <div class="bucket-bar actual" style="height: ${(b.actual || 0) * 100}%"></div>
              </div>
              <div class="bucket-label">${b.range}</div>
              <div class="bucket-count">(${b.total})</div>
            </div>
          `).join('')}
        </div>
        <div class="calibration-legend">
          <span><span class="legend-dot expected"></span> Expected</span>
          <span><span class="legend-dot actual"></span> Actual</span>
        </div>
        
        ${analysis.length > 0 ? `
          <h3>⚠️ Calibration Issues</h3>
          <div class="calibration-issues">
            ${analysis.map(a => `
              <div class="issue-item ${a.type}">
                ${a.message}
              </div>
            `).join('')}
          </div>
        ` : ''}
      </div>
    `;
  }

  /**
   * Render reflexions tab
   */
  renderReflexions() {
    if (!window.reflexionEngine) {
      return '<div class="metacog-empty">Reflexion engine not loaded</div>';
    }

    const stats = window.reflexionEngine.getStats();
    const reflexions = window.reflexionEngine.reflexions.slice(0, 10);
    
    return `
      <div class="metacog-reflexions">
        <div class="reflexion-stats">
          <div class="reflexion-stat">
            <span class="stat-value">${stats.total}</span>
            <span class="stat-label">Total Reflexions</span>
          </div>
          <div class="reflexion-stat">
            <span class="stat-value">${stats.resolved}</span>
            <span class="stat-label">Resolved</span>
          </div>
          <div class="reflexion-stat ${stats.recentTrend === 'improving' ? 'good' : stats.recentTrend === 'worsening' ? 'poor' : ''}">
            <span class="stat-value">${stats.recentTrend || '—'}</span>
            <span class="stat-label">Trend</span>
          </div>
        </div>
        
        <h3>🔍 Recent Failure Analysis</h3>
        <div class="reflexion-list">
          ${reflexions.map(r => `
            <div class="reflexion-item ${r.severity} ${r.resolved ? 'resolved' : ''}">
              <div class="reflexion-header">
                <span class="reflexion-task">${r.context.task || 'Unknown task'}</span>
                <span class="reflexion-severity ${r.severity}">${r.severity}</span>
              </div>
              <div class="reflexion-summary">${r.analysis.summary}</div>
              <div class="reflexion-prevention">
                <strong>Prevention:</strong> ${r.prevention.strategy}
              </div>
              <div class="reflexion-time">${this.formatTime(r.timestamp)}</div>
            </div>
          `).join('') || '<div class="metacog-empty">No reflexions recorded yet</div>'}
        </div>
      </div>
    `;
  }

  /**
   * Render style tab
   */
  renderStyle() {
    if (!window.styleAnalyzer) {
      return '<div class="metacog-empty">Style analyzer not loaded</div>';
    }

    const summary = window.styleAnalyzer.getSummary();
    const recommendations = window.styleAnalyzer.getRecommendations();
    
    return `
      <div class="metacog-style">
        <div class="style-header">
          <span class="style-icon">🎨</span>
          <span class="style-text">Analyzed ${summary.samplesAnalyzed} code samples</span>
        </div>
        
        <h3>📝 Detected Preferences</h3>
        <div class="style-prefs">
          <div class="style-pref">
            <span class="pref-label">Naming</span>
            <span class="pref-value">${recommendations.naming?.variables || '—'}</span>
          </div>
          <div class="style-pref">
            <span class="pref-label">Indentation</span>
            <span class="pref-value">${recommendations.formatting?.indentation || '—'}</span>
          </div>
          <div class="style-pref">
            <span class="pref-label">Quotes</span>
            <span class="pref-value">${recommendations.formatting?.quotes || '—'}</span>
          </div>
          <div class="style-pref">
            <span class="pref-label">Semicolons</span>
            <span class="pref-value">${recommendations.formatting?.semicolons || '—'}</span>
          </div>
          <div class="style-pref">
            <span class="pref-label">Async Style</span>
            <span class="pref-value">${recommendations.patterns?.async || '—'}</span>
          </div>
          <div class="style-pref">
            <span class="pref-label">Loop Style</span>
            <span class="pref-value">${recommendations.patterns?.loops || '—'}</span>
          </div>
          <div class="style-pref">
            <span class="pref-label">Error Handling</span>
            <span class="pref-value">${summary.errorHandling || '—'}</span>
          </div>
        </div>
        
        <p class="style-note">These preferences are used to tailor code suggestions to your style.</p>
      </div>
    `;
  }

  /**
   * Gather stats from all modules
   */
  gatherStats() {
    const stats = {
      calibrationScore: null,
      calibrationSamples: 0,
      completionRate: null,
      totalCompletions: 0,
      topSkill: null,
      topSkillScore: null,
      learnedPatterns: 0,
      mistakePatterns: 0,
      insights: [],
      suggestions: []
    };

    // Calibration
    if (window.confidenceCalibration) {
      stats.calibrationScore = window.confidenceCalibration.getScore();
      stats.calibrationSamples = window.confidenceCalibration.data.history.length;
    }

    // Completions
    if (window.adaptiveCompletions) {
      const compStats = window.adaptiveCompletions.getStats();
      stats.completionRate = compStats.acceptanceRate;
      stats.totalCompletions = compStats.total;
      stats.insights.push(...window.adaptiveCompletions.getInsights());
    }

    // Capabilities
    if (window.capabilityTracker) {
      const capSummary = window.capabilityTracker.getSummary();
      if (capSummary.topSkills.length > 0) {
        stats.topSkill = capSummary.topSkills[0].name;
        stats.topSkillScore = capSummary.topSkills[0].score;
      }
      stats.suggestions.push(...capSummary.suggestions);
    }

    // Learning
    if (window.learningMemory) {
      const learnStats = window.learningMemory.getStats();
      stats.learnedPatterns = learnStats.successes;
      stats.mistakePatterns = learnStats.mistakes;
    }

    return stats;
  }

  /**
   * Refresh dashboard
   */
  refresh() {
    if (this.isOpen) {
      this.switchTab(this.activeTab);
    }
  }

  /**
   * Export all data
   */
  exportAll() {
    const data = {
      exportedAt: new Date().toISOString(),
      modules: {}
    };

    if (window.learningMemory) data.modules.learningMemory = JSON.parse(window.learningMemory.export());
    if (window.confidenceCalibration) data.modules.calibration = JSON.parse(window.confidenceCalibration.export());
    if (window.reflexionEngine) data.modules.reflexions = JSON.parse(window.reflexionEngine.export());
    if (window.patternRecognition) data.modules.patterns = JSON.parse(window.patternRecognition.export());
    if (window.styleAnalyzer) data.modules.style = JSON.parse(window.styleAnalyzer.export());
    if (window.adaptiveCompletions) data.modules.completions = JSON.parse(window.adaptiveCompletions.export());
    if (window.capabilityTracker) data.modules.capabilities = JSON.parse(window.capabilityTracker.export());

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clawd-metacognitive-export-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Format timestamp
   */
  formatTime(ts) {
    const date = new Date(ts);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return date.toLocaleDateString();
  }
}

// Global instance
window.metacognitiveDashboard = new MetacognitiveDashboard();

// Export
if (typeof module !== 'undefined') {
  module.exports = { MetacognitiveDashboard };
}

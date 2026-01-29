/**
 * REFLEXION ENGINE
 * Phase 1: Learn from failures
 * 
 * Auto-triggered on failures to:
 * 1. Analyze what went wrong
 * 2. Identify root cause
 * 3. Extract learnable pattern
 * 4. Store for future prevention
 */

class ReflexionEngine {
  constructor() {
    this.storageKey = 'clawd_reflexions';
    this.reflexions = this.load();
    this.maxReflexions = 100;
    
    console.log('[Reflexion] Initialized with', this.reflexions.length, 'reflexions');
  }

  /**
   * Load reflexions
   */
  load() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }

  /**
   * Save reflexions
   */
  save() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.reflexions));
  }

  /**
   * Main reflexion method - called when a failure occurs
   */
  async reflect(failure) {
    const reflexion = {
      id: `ref_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      
      // What happened
      context: {
        task: failure.task,
        approach: failure.approach,
        expected: failure.expected,
        actual: failure.actual
      },
      
      // Analysis
      analysis: this.analyze(failure),
      
      // Extracted pattern
      pattern: this.extractPattern(failure),
      
      // Prevention strategy
      prevention: this.generatePrevention(failure),
      
      // Metadata
      category: failure.category || 'general',
      severity: this.assessSeverity(failure),
      resolved: false
    };

    // Store reflexion
    this.reflexions.unshift(reflexion);
    
    // Trim old reflexions
    if (this.reflexions.length > this.maxReflexions) {
      this.reflexions = this.reflexions.slice(0, this.maxReflexions);
    }

    // Also record in learning memory if available
    if (window.learningMemory) {
      window.learningMemory.recordMistake({
        pattern: reflexion.pattern.signature,
        description: reflexion.analysis.summary,
        category: reflexion.category,
        severity: reflexion.severity,
        prevention: reflexion.prevention.strategy
      });
    }

    this.save();
    
    return reflexion;
  }

  /**
   * Analyze the failure
   */
  analyze(failure) {
    const analysis = {
      summary: '',
      rootCauses: [],
      contributing: [],
      timeline: []
    };

    // Build timeline
    if (failure.steps) {
      for (let i = 0; i < failure.steps.length; i++) {
        analysis.timeline.push({
          step: i + 1,
          action: failure.steps[i].action,
          result: failure.steps[i].result,
          wasCorrect: failure.steps[i].success !== false
        });
      }

      // Find where it went wrong
      const failurePoint = analysis.timeline.findIndex(t => !t.wasCorrect);
      if (failurePoint >= 0) {
        analysis.failurePoint = failurePoint + 1;
        analysis.rootCauses.push(`Failure at step ${failurePoint + 1}: ${failure.steps[failurePoint].action}`);
      }
    }

    // Categorize root causes
    const error = failure.error || failure.actual || '';
    const errorStr = typeof error === 'string' ? error : JSON.stringify(error);

    // Common error patterns
    if (/undefined|null|NaN/i.test(errorStr)) {
      analysis.rootCauses.push('Null/undefined value encountered');
      analysis.contributing.push('Missing null check');
    }
    if (/timeout|timed out/i.test(errorStr)) {
      analysis.rootCauses.push('Operation timeout');
      analysis.contributing.push('Async operation took too long');
    }
    if (/permission|denied|unauthorized/i.test(errorStr)) {
      analysis.rootCauses.push('Permission issue');
      analysis.contributing.push('Missing or invalid credentials');
    }
    if (/not found|404|missing/i.test(errorStr)) {
      analysis.rootCauses.push('Resource not found');
      analysis.contributing.push('Invalid path or reference');
    }
    if (/syntax|parse|JSON/i.test(errorStr)) {
      analysis.rootCauses.push('Syntax/parsing error');
      analysis.contributing.push('Malformed data or code');
    }

    // Generate summary
    if (analysis.rootCauses.length > 0) {
      analysis.summary = `Failure caused by: ${analysis.rootCauses[0]}`;
    } else {
      analysis.summary = `Task "${failure.task}" failed with unexpected outcome`;
    }

    return analysis;
  }

  /**
   * Extract a learnable pattern from the failure
   */
  extractPattern(failure) {
    const pattern = {
      signature: '',
      context: [],
      antiPattern: null,
      confidence: 0.6
    };

    // Create signature from task + error type
    const taskWords = (failure.task || '').toLowerCase().split(/\s+/).slice(0, 3);
    const errorType = this.classifyError(failure.error || failure.actual);
    
    pattern.signature = `${taskWords.join('_')}_${errorType}`;

    // Context clues
    if (failure.approach) {
      pattern.context.push(`Approach: ${failure.approach}`);
    }
    if (failure.category) {
      pattern.context.push(`Category: ${failure.category}`);
    }

    // Identify anti-pattern
    if (failure.approach) {
      pattern.antiPattern = {
        description: failure.approach,
        reason: failure.error || 'Did not produce expected result'
      };
    }

    return pattern;
  }

  /**
   * Classify error type
   */
  classifyError(error) {
    const errorStr = typeof error === 'string' ? error : JSON.stringify(error || '');
    
    if (/undefined|null|NaN/i.test(errorStr)) return 'null_error';
    if (/timeout|timed out/i.test(errorStr)) return 'timeout';
    if (/permission|denied|auth|forbidden/i.test(errorStr)) return 'permission';
    if (/not found|404|missing/i.test(errorStr)) return 'not_found';
    if (/syntax|parse|JSON/i.test(errorStr)) return 'syntax';
    if (/network|connection|fetch|refused/i.test(errorStr)) return 'network';
    if (/memory|heap|stack/i.test(errorStr)) return 'memory';
    
    return 'unknown';
  }

  /**
   * Generate prevention strategy
   */
  generatePrevention(failure) {
    const prevention = {
      strategy: '',
      checks: [],
      alternatives: []
    };

    const errorType = this.classifyError(failure.error || failure.actual);

    // Strategy based on error type
    const strategies = {
      'null_error': {
        strategy: 'Add null checks before accessing properties',
        checks: ['Verify object exists', 'Check for undefined values', 'Use optional chaining'],
        alternatives: ['Use default values', 'Implement null object pattern']
      },
      'timeout': {
        strategy: 'Add timeout handling and retries',
        checks: ['Verify service availability', 'Check network conditions'],
        alternatives: ['Increase timeout', 'Add retry logic', 'Use async queue']
      },
      'permission': {
        strategy: 'Verify permissions before attempting action',
        checks: ['Check credentials', 'Verify user has access'],
        alternatives: ['Request elevated permissions', 'Use alternative API']
      },
      'not_found': {
        strategy: 'Verify resource exists before accessing',
        checks: ['Check path is correct', 'Verify file/resource exists'],
        alternatives: ['Create resource if missing', 'Use fallback path']
      },
      'syntax': {
        strategy: 'Validate data format before parsing',
        checks: ['Validate JSON structure', 'Check for malformed input'],
        alternatives: ['Use try-catch for parsing', 'Implement format detection']
      },
      'network': {
        strategy: 'Handle network failures gracefully',
        checks: ['Verify endpoint URL', 'Check connectivity'],
        alternatives: ['Use retry with backoff', 'Implement offline mode']
      }
    };

    const matched = strategies[errorType] || {
      strategy: 'Review and test the approach more carefully',
      checks: ['Verify all inputs', 'Check edge cases'],
      alternatives: ['Try a different approach', 'Break down into smaller steps']
    };

    return { ...prevention, ...matched };
  }

  /**
   * Assess severity of failure
   */
  assessSeverity(failure) {
    let severity = 'medium';

    // High severity indicators
    if (failure.error && /critical|fatal|crash|corrupt/i.test(String(failure.error))) {
      severity = 'high';
    }
    if (failure.retries && failure.retries > 3) {
      severity = 'high';
    }
    if (failure.impact === 'data_loss' || failure.impact === 'security') {
      severity = 'critical';
    }

    // Low severity indicators
    if (failure.recoverable === true) {
      severity = 'low';
    }
    if (failure.retries === 1) {
      severity = 'low';
    }

    return severity;
  }

  /**
   * Check if a similar failure has occurred before
   */
  findSimilar(failure) {
    const signature = this.extractPattern(failure).signature;
    
    return this.reflexions.filter(r => {
      // Exact signature match
      if (r.pattern.signature === signature) return true;
      
      // Fuzzy match on category + error type
      if (r.category === failure.category) {
        const rErrorType = this.classifyError(r.context.actual);
        const fErrorType = this.classifyError(failure.error || failure.actual);
        if (rErrorType === fErrorType) return true;
      }
      
      return false;
    });
  }

  /**
   * Get prevention advice for a task
   */
  getAdvice(task, category = null) {
    const advice = [];

    for (const reflexion of this.reflexions) {
      // Check relevance
      const taskLower = task.toLowerCase();
      const reflexionTask = (reflexion.context.task || '').toLowerCase();

      const isRelevant = 
        (category && reflexion.category === category) ||
        taskLower.split(/\s+/).some(word => reflexionTask.includes(word));

      if (isRelevant) {
        advice.push({
          from: reflexion.id,
          summary: reflexion.analysis.summary,
          prevention: reflexion.prevention.strategy,
          checks: reflexion.prevention.checks,
          severity: reflexion.severity
        });
      }
    }

    // Sort by severity and recency
    return advice.sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    }).slice(0, 5);
  }

  /**
   * Mark a reflexion as resolved
   */
  resolve(reflexionId, notes = null) {
    const reflexion = this.reflexions.find(r => r.id === reflexionId);
    if (reflexion) {
      reflexion.resolved = true;
      reflexion.resolvedAt = Date.now();
      if (notes) reflexion.resolutionNotes = notes;
      this.save();
    }
    return reflexion;
  }

  /**
   * Get reflexion statistics
   */
  getStats() {
    const stats = {
      total: this.reflexions.length,
      resolved: this.reflexions.filter(r => r.resolved).length,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
      byCategory: {},
      byErrorType: {},
      recentTrend: null
    };

    for (const r of this.reflexions) {
      stats.bySeverity[r.severity]++;
      stats.byCategory[r.category] = (stats.byCategory[r.category] || 0) + 1;
      
      const errorType = this.classifyError(r.context.actual);
      stats.byErrorType[errorType] = (stats.byErrorType[errorType] || 0) + 1;
    }

    // Calculate trend (last 7 days vs previous 7 days)
    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;

    const recent = this.reflexions.filter(r => r.timestamp > weekAgo).length;
    const older = this.reflexions.filter(r => r.timestamp > twoWeeksAgo && r.timestamp <= weekAgo).length;

    if (older > 0) {
      stats.recentTrend = recent < older ? 'improving' : recent > older ? 'worsening' : 'stable';
    }

    return stats;
  }

  /**
   * Render reflexion UI
   */
  renderReflexion(reflexion) {
    return `
      <div class="reflexion-item ${reflexion.severity}" data-id="${reflexion.id}">
        <div class="reflexion-header">
          <span class="reflexion-icon">${reflexion.resolved ? '✅' : '🔍'}</span>
          <span class="reflexion-task">${reflexion.context.task || 'Unknown task'}</span>
          <span class="reflexion-severity ${reflexion.severity}">${reflexion.severity}</span>
        </div>
        <div class="reflexion-summary">${reflexion.analysis.summary}</div>
        <div class="reflexion-prevention">
          <strong>Prevention:</strong> ${reflexion.prevention.strategy}
        </div>
        <div class="reflexion-time">${this.formatTime(reflexion.timestamp)}</div>
      </div>
    `;
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

  /**
   * Export reflexions
   */
  export() {
    return JSON.stringify(this.reflexions, null, 2);
  }

  /**
   * Clear all reflexions
   */
  clear() {
    this.reflexions = [];
    localStorage.removeItem(this.storageKey);
  }
}

// Global instance
window.reflexionEngine = new ReflexionEngine();

// Export
if (typeof module !== 'undefined') {
  module.exports = { ReflexionEngine };
}

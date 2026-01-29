/**
 * ADAPTIVE COMPLETIONS MODULE
 * Phase 2: Learn from completion acceptance
 * 
 * Tracks which completions get accepted vs rejected
 * and adapts suggestions accordingly.
 */

class AdaptiveCompletions {
  constructor() {
    this.storageKey = 'clawd_adaptive_completions';
    this.data = this.load();
    this.pendingCompletions = new Map();
    
    console.log('[AdaptiveCompletions] Initialized, acceptance rate:', this.getOverallRate());
  }

  /**
   * Load completion data
   */
  load() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) return JSON.parse(stored);
    } catch {}

    return {
      // Overall stats
      total: 0,
      accepted: 0,
      rejected: 0,
      modified: 0,
      
      // By completion type
      byType: {},
      
      // By language
      byLanguage: {},
      
      // By time of day
      byHour: {},
      
      // By completion length
      byLength: {
        short: { offered: 0, accepted: 0 },    // < 50 chars
        medium: { offered: 0, accepted: 0 },   // 50-200 chars
        long: { offered: 0, accepted: 0 }      // > 200 chars
      },
      
      // Recent completions for learning
      recentCompletions: [],
      
      // Learned preferences
      preferences: {
        preferredLength: null,
        preferredTypes: [],
        avoidTypes: []
      }
    };
  }

  /**
   * Save data
   */
  save() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.data));
  }

  /**
   * Track a completion being offered
   */
  offerCompletion(completion) {
    const id = `comp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    
    const record = {
      id,
      timestamp: Date.now(),
      completion: completion.text,
      type: completion.type || this.detectType(completion.text),
      language: completion.language || 'unknown',
      length: completion.text.length,
      context: completion.context || null,
      outcome: null
    };

    this.pendingCompletions.set(id, record);
    
    // Auto-expire after 30 seconds
    setTimeout(() => {
      if (this.pendingCompletions.has(id)) {
        this.recordOutcome(id, 'ignored');
      }
    }, 30000);

    return id;
  }

  /**
   * Record completion outcome
   */
  recordOutcome(completionId, outcome) {
    const record = this.pendingCompletions.get(completionId);
    if (!record) return null;

    record.outcome = outcome;
    record.resolvedAt = Date.now();
    
    this.pendingCompletions.delete(completionId);

    // Update stats
    this.data.total++;
    
    if (outcome === 'accepted') {
      this.data.accepted++;
    } else if (outcome === 'rejected') {
      this.data.rejected++;
    } else if (outcome === 'modified') {
      this.data.modified++;
    }

    // By type
    if (!this.data.byType[record.type]) {
      this.data.byType[record.type] = { offered: 0, accepted: 0 };
    }
    this.data.byType[record.type].offered++;
    if (outcome === 'accepted' || outcome === 'modified') {
      this.data.byType[record.type].accepted++;
    }

    // By language
    if (!this.data.byLanguage[record.language]) {
      this.data.byLanguage[record.language] = { offered: 0, accepted: 0 };
    }
    this.data.byLanguage[record.language].offered++;
    if (outcome === 'accepted' || outcome === 'modified') {
      this.data.byLanguage[record.language].accepted++;
    }

    // By hour
    const hour = new Date().getHours();
    if (!this.data.byHour[hour]) {
      this.data.byHour[hour] = { offered: 0, accepted: 0 };
    }
    this.data.byHour[hour].offered++;
    if (outcome === 'accepted' || outcome === 'modified') {
      this.data.byHour[hour].accepted++;
    }

    // By length
    const lengthCategory = record.length < 50 ? 'short' : record.length < 200 ? 'medium' : 'long';
    this.data.byLength[lengthCategory].offered++;
    if (outcome === 'accepted' || outcome === 'modified') {
      this.data.byLength[lengthCategory].accepted++;
    }

    // Store in recent completions
    this.data.recentCompletions.unshift(record);
    if (this.data.recentCompletions.length > 100) {
      this.data.recentCompletions = this.data.recentCompletions.slice(0, 100);
    }

    // Update preferences
    this.updatePreferences();

    this.save();
    return record;
  }

  /**
   * Detect completion type
   */
  detectType(text) {
    if (/^(import|from|require)/.test(text)) return 'import';
    if (/^(function|const\s+\w+\s*=|let\s+\w+\s*=)/.test(text)) return 'function';
    if (/^(if|else|switch)/.test(text)) return 'conditional';
    if (/^(for|while|do)/.test(text)) return 'loop';
    if (/^(class|interface|type)/.test(text)) return 'declaration';
    if (/^(return|throw)/.test(text)) return 'return';
    if (/^(try|catch|finally)/.test(text)) return 'error_handling';
    if (/^(console|logger|log)/.test(text)) return 'logging';
    if (/^\/[/*]/.test(text)) return 'comment';
    if (/^[a-z]\w*\(/.test(text)) return 'function_call';
    if (/^\s*\w+\s*[:=]/.test(text)) return 'assignment';
    return 'other';
  }

  /**
   * Update learned preferences
   */
  updatePreferences() {
    // Preferred length
    const lengths = this.data.byLength;
    let bestLength = 'medium';
    let bestRate = 0;
    
    for (const [len, stats] of Object.entries(lengths)) {
      if (stats.offered > 10) {
        const rate = stats.accepted / stats.offered;
        if (rate > bestRate) {
          bestRate = rate;
          bestLength = len;
        }
      }
    }
    this.data.preferences.preferredLength = bestLength;

    // Preferred and avoid types
    const typeRates = [];
    for (const [type, stats] of Object.entries(this.data.byType)) {
      if (stats.offered > 5) {
        typeRates.push({
          type,
          rate: stats.accepted / stats.offered,
          samples: stats.offered
        });
      }
    }

    typeRates.sort((a, b) => b.rate - a.rate);
    
    this.data.preferences.preferredTypes = typeRates
      .filter(t => t.rate > 0.7)
      .map(t => t.type);
    
    this.data.preferences.avoidTypes = typeRates
      .filter(t => t.rate < 0.3)
      .map(t => t.type);
  }

  /**
   * Score a potential completion
   */
  scoreCompletion(completion) {
    let score = 0.5; // Base score

    const type = completion.type || this.detectType(completion.text);
    const length = completion.text.length;
    const lengthCategory = length < 50 ? 'short' : length < 200 ? 'medium' : 'long';

    // Boost for preferred types
    if (this.data.preferences.preferredTypes.includes(type)) {
      score += 0.2;
    }

    // Penalty for avoided types
    if (this.data.preferences.avoidTypes.includes(type)) {
      score -= 0.3;
    }

    // Length preference
    if (this.data.preferences.preferredLength === lengthCategory) {
      score += 0.1;
    }

    // Historical acceptance rate for this type
    const typeStats = this.data.byType[type];
    if (typeStats && typeStats.offered > 10) {
      const typeRate = typeStats.accepted / typeStats.offered;
      score += (typeRate - 0.5) * 0.3; // Adjust by +/- 0.15 max
    }

    // Time of day factor
    const hour = new Date().getHours();
    const hourStats = this.data.byHour[hour];
    if (hourStats && hourStats.offered > 5) {
      const hourRate = hourStats.accepted / hourStats.offered;
      score += (hourRate - 0.5) * 0.1; // Adjust by +/- 0.05 max
    }

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Filter and sort completions
   */
  rankCompletions(completions) {
    return completions
      .map(c => ({
        ...c,
        adaptiveScore: this.scoreCompletion(c)
      }))
      .sort((a, b) => b.adaptiveScore - a.adaptiveScore);
  }

  /**
   * Should this completion be shown?
   */
  shouldShow(completion) {
    const score = this.scoreCompletion(completion);
    const type = completion.type || this.detectType(completion.text);

    // Always show if not enough data
    if (this.data.total < 20) return true;

    // Don't show if type has very low acceptance
    if (this.data.preferences.avoidTypes.includes(type) && score < 0.4) {
      return false;
    }

    // Show if score is reasonable
    return score > 0.3;
  }

  /**
   * Get overall acceptance rate
   */
  getOverallRate() {
    if (this.data.total === 0) return null;
    return (this.data.accepted + this.data.modified * 0.5) / this.data.total;
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      total: this.data.total,
      accepted: this.data.accepted,
      rejected: this.data.rejected,
      modified: this.data.modified,
      acceptanceRate: this.getOverallRate(),
      preferredTypes: this.data.preferences.preferredTypes,
      avoidTypes: this.data.preferences.avoidTypes,
      preferredLength: this.data.preferences.preferredLength,
      byType: Object.fromEntries(
        Object.entries(this.data.byType)
          .map(([type, stats]) => [type, stats.offered > 0 ? stats.accepted / stats.offered : 0])
      )
    };
  }

  /**
   * Get insights for display
   */
  getInsights() {
    const insights = [];
    const rate = this.getOverallRate();

    if (rate !== null) {
      insights.push({
        type: 'overall',
        message: `Overall acceptance rate: ${(rate * 100).toFixed(1)}%`,
        icon: rate > 0.6 ? '✅' : rate > 0.4 ? '🔶' : '⚠️'
      });
    }

    // Best performing type
    let bestType = null;
    let bestRate = 0;
    for (const [type, stats] of Object.entries(this.data.byType)) {
      if (stats.offered > 10) {
        const typeRate = stats.accepted / stats.offered;
        if (typeRate > bestRate) {
          bestType = type;
          bestRate = typeRate;
        }
      }
    }
    if (bestType) {
      insights.push({
        type: 'best_type',
        message: `Best at: ${bestType} completions (${(bestRate * 100).toFixed(0)}% accepted)`,
        icon: '🎯'
      });
    }

    // Most active hour
    let bestHour = null;
    let mostActivity = 0;
    for (const [hour, stats] of Object.entries(this.data.byHour)) {
      if (stats.offered > mostActivity) {
        mostActivity = stats.offered;
        bestHour = hour;
      }
    }
    if (bestHour) {
      insights.push({
        type: 'active_hour',
        message: `Most active around ${bestHour}:00`,
        icon: '🕐'
      });
    }

    return insights;
  }

  /**
   * Export data
   */
  export() {
    return JSON.stringify(this.data, null, 2);
  }

  /**
   * Clear data
   */
  clear() {
    localStorage.removeItem(this.storageKey);
    this.data = this.load();
    this.pendingCompletions.clear();
  }
}

// Global instance
window.adaptiveCompletions = new AdaptiveCompletions();

// Export
if (typeof module !== 'undefined') {
  module.exports = { AdaptiveCompletions };
}

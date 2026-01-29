/**
 * PATTERN RECOGNITION MODULE
 * Phase 2: Learn patterns from outcomes
 * 
 * Recognizes:
 * - Successful code patterns
 * - User behavior patterns
 * - Error patterns
 * - Context patterns
 */

class PatternRecognition {
  constructor() {
    this.storageKey = 'clawd_patterns';
    this.patterns = this.load();
    
    console.log('[PatternRecognition] Initialized with', Object.keys(this.patterns).length, 'pattern types');
  }

  /**
   * Load patterns
   */
  load() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) return JSON.parse(stored);
    } catch {}

    return {
      code: [],      // Successful code patterns
      behavior: [],  // User behavior patterns
      error: [],     // Error patterns to avoid
      context: [],   // Context-based patterns
      sequences: []  // Action sequences
    };
  }

  /**
   * Save patterns
   */
  save() {
    localStorage.setItem(this.storageKey, JSON.stringify(this.patterns));
  }

  /**
   * Learn a code pattern from accepted code
   */
  learnCodePattern(code, context = {}) {
    const pattern = {
      id: `cp_${Date.now()}`,
      timestamp: Date.now(),
      type: this.detectCodeType(code),
      structure: this.extractStructure(code),
      language: context.language || this.detectLanguage(code),
      length: code.length,
      lines: code.split('\n').length,
      features: this.extractFeatures(code),
      context: context,
      useCount: 1,
      successRate: 1
    };

    // Find similar existing pattern
    const similar = this.findSimilarPattern(pattern, 'code');
    
    if (similar) {
      similar.useCount++;
      similar.successRate = (similar.successRate * (similar.useCount - 1) + 1) / similar.useCount;
      similar.lastUsed = Date.now();
    } else {
      this.patterns.code.push(pattern);
    }

    this.trimPatterns('code');
    this.save();
    return pattern;
  }

  /**
   * Learn from rejected code (negative pattern)
   */
  learnRejectedPattern(code, reason = null) {
    const pattern = {
      id: `ep_${Date.now()}`,
      timestamp: Date.now(),
      type: this.detectCodeType(code),
      structure: this.extractStructure(code),
      reason: reason,
      avoidCount: 1
    };

    this.patterns.error.push(pattern);
    this.trimPatterns('error');
    this.save();
    return pattern;
  }

  /**
   * Learn user behavior pattern
   */
  learnBehavior(action, context = {}) {
    const pattern = {
      id: `bp_${Date.now()}`,
      timestamp: Date.now(),
      action: action,
      timeOfDay: new Date().getHours(),
      dayOfWeek: new Date().getDay(),
      context: context,
      occurrences: 1
    };

    // Find similar behavior
    const similar = this.patterns.behavior.find(p => 
      p.action === action && 
      Math.abs(p.timeOfDay - pattern.timeOfDay) <= 2
    );

    if (similar) {
      similar.occurrences++;
      similar.lastOccurred = Date.now();
    } else {
      this.patterns.behavior.push(pattern);
    }

    this.trimPatterns('behavior');
    this.save();
    return pattern;
  }

  /**
   * Learn action sequence
   */
  learnSequence(actions, outcome) {
    // Find similar sequence first
    const similar = this.patterns.sequences.find(p =>
      p.sequence.length === actions.length &&
      p.sequence.every((a, i) => a === actions[i])
    );

    if (similar) {
      similar.occurrences++;
      // Update outcome weight
      if (outcome.success) {
        similar.successWeight = (similar.successWeight || 0) + 1;
      } else {
        similar.failureWeight = (similar.failureWeight || 0) + 1;
      }
      this.save();
      return similar;
    } else {
      const pattern = {
        id: `seq_${Date.now()}`,
        timestamp: Date.now(),
        sequence: actions,
        length: actions.length,
        outcome: outcome,
        occurrences: 1,
        successWeight: outcome.success ? 1 : 0,
        failureWeight: outcome.success ? 0 : 1
      };
      this.patterns.sequences.push(pattern);
      this.trimPatterns('sequences');
      this.save();
      return pattern;
    }
  }

  /**
   * Detect code type
   */
  detectCodeType(code) {
    // Trim whitespace for detection
    const trimmed = code.trim();
    
    if (/^(async\s+)?function\s+\w+/m.test(trimmed)) return 'function';
    if (/^const\s+\w+\s*=\s*(async\s*)?\(/m.test(trimmed)) return 'arrow_function';
    if (/^class\s+\w+/m.test(trimmed)) return 'class';
    if (/^import\s+/m.test(trimmed)) return 'import';
    if (/^export\s+/m.test(trimmed)) return 'export';
    if (/^(const|let|var)\s+\w+\s*=/m.test(trimmed)) return 'variable';
    if (/^if\s*\(/m.test(trimmed)) return 'conditional';
    if (/^(for|while)\s*\(/m.test(trimmed)) return 'loop';
    if (/^try\s*\{/m.test(trimmed)) return 'try_catch';
    
    // Check for function anywhere in the code
    if (/(async\s+)?function\s+\w+/.test(trimmed)) return 'function';
    if (/const\s+\w+\s*=\s*(async\s*)?\(.*\)\s*=>/.test(trimmed)) return 'arrow_function';
    
    return 'other';
  }

  /**
   * Extract structural features
   */
  extractStructure(code) {
    return {
      hasAsync: /async/.test(code),
      hasAwait: /await/.test(code),
      hasArrow: /=>/.test(code),
      hasClass: /class\s+\w+/.test(code),
      hasTryCatch: /try\s*{/.test(code),
      hasPromise: /Promise|\.then\(/.test(code),
      hasCallback: /callback|cb\)/.test(code),
      hasDestructuring: /{\s*\w+.*}\s*=/.test(code) || /\[\s*\w+.*\]\s*=/.test(code),
      hasSpread: /\.\.\./.test(code),
      hasTemplate: /`.*\${/.test(code)
    };
  }

  /**
   * Extract features for matching
   */
  extractFeatures(code) {
    const features = [];
    
    // Structural features
    if (/async/.test(code)) features.push('async');
    if (/await/.test(code)) features.push('await');
    if (/class\s+/.test(code)) features.push('class');
    if (/=>/.test(code)) features.push('arrow');
    if (/\.map\(/.test(code)) features.push('map');
    if (/\.filter\(/.test(code)) features.push('filter');
    if (/\.reduce\(/.test(code)) features.push('reduce');
    if (/\.forEach\(/.test(code)) features.push('forEach');
    if (/useState|useEffect/.test(code)) features.push('hooks');
    if (/import\s+React/.test(code)) features.push('react');
    if (/express|app\./.test(code)) features.push('express');

    return features;
  }

  /**
   * Detect programming language
   */
  detectLanguage(code) {
    if (/import\s+.*from\s+['"]|export\s+(default\s+)?/.test(code)) return 'javascript';
    if (/<\w+.*>.*<\/\w+>|<\w+\s*\/>/.test(code)) return 'jsx';
    if (/:\s*(string|number|boolean|void)/.test(code)) return 'typescript';
    if (/def\s+\w+.*:/.test(code)) return 'python';
    if (/fn\s+\w+.*->/.test(code)) return 'rust';
    if (/func\s+\w+.*{/.test(code)) return 'go';
    return 'unknown';
  }

  /**
   * Find similar pattern
   */
  findSimilarPattern(newPattern, type) {
    const patterns = this.patterns[type] || [];
    
    for (const p of patterns) {
      if (p.type === newPattern.type && p.language === newPattern.language) {
        // Compare structure
        if (JSON.stringify(p.structure) === JSON.stringify(newPattern.structure)) {
          return p;
        }
        // Compare features
        const overlap = p.features?.filter(f => newPattern.features?.includes(f)) || [];
        if (overlap.length >= Math.min(p.features?.length || 0, newPattern.features?.length || 0) * 0.8) {
          return p;
        }
      }
    }
    return null;
  }

  /**
   * Get recommended patterns for context
   */
  getRecommendations(context) {
    const recommendations = [];
    
    // Get language-specific patterns
    const langPatterns = this.patterns.code.filter(p => 
      !context.language || p.language === context.language
    );

    // Sort by success rate and use count
    langPatterns.sort((a, b) => {
      const aScore = a.successRate * Math.log(a.useCount + 1);
      const bScore = b.successRate * Math.log(b.useCount + 1);
      return bScore - aScore;
    });

    // Get top patterns
    for (const pattern of langPatterns.slice(0, 10)) {
      recommendations.push({
        type: pattern.type,
        features: pattern.features,
        confidence: pattern.successRate,
        uses: pattern.useCount
      });
    }

    return recommendations;
  }

  /**
   * Check if code matches a negative pattern
   */
  checkForAntiPatterns(code) {
    const warnings = [];

    for (const pattern of this.patterns.error) {
      if (pattern.structure && this.structureMatches(code, pattern.structure)) {
        warnings.push({
          pattern: pattern.type,
          reason: pattern.reason || 'Previously rejected pattern',
          avoidCount: pattern.avoidCount
        });
      }
    }

    return warnings;
  }

  /**
   * Check if structure matches
   */
  structureMatches(code, targetStructure) {
    const codeStructure = this.extractStructure(code);
    
    let matches = 0;
    let total = 0;
    
    for (const [key, value] of Object.entries(targetStructure)) {
      if (value) {
        total++;
        if (codeStructure[key] === value) matches++;
      }
    }

    return total > 0 && matches / total >= 0.8;
  }

  /**
   * Predict likely next action based on sequences
   */
  predictNextAction(recentActions) {
    const predictions = [];

    for (const seq of this.patterns.sequences) {
      // Check if recent actions match start of sequence
      const matchLength = this.getMatchLength(recentActions, seq.sequence);
      
      if (matchLength > 0 && matchLength < seq.sequence.length) {
        const nextAction = seq.sequence[matchLength];
        const confidence = (seq.successWeight || 0) / (seq.occurrences || 1);
        
        predictions.push({
          action: nextAction,
          confidence,
          basedOn: seq.sequence.slice(0, matchLength)
        });
      }
    }

    // Sort by confidence
    predictions.sort((a, b) => b.confidence - a.confidence);
    return predictions.slice(0, 5);
  }

  /**
   * Get match length between arrays
   */
  getMatchLength(arr1, arr2) {
    let i = 0;
    while (i < arr1.length && i < arr2.length && arr1[i] === arr2[i]) {
      i++;
    }
    return i;
  }

  /**
   * Trim patterns to prevent unbounded growth
   */
  trimPatterns(type, maxSize = 200) {
    const patterns = this.patterns[type];
    if (patterns && patterns.length > maxSize) {
      // Keep highest scoring patterns
      patterns.sort((a, b) => {
        const aScore = (a.successRate || 0.5) * Math.log((a.useCount || a.occurrences || 1) + 1);
        const bScore = (b.successRate || 0.5) * Math.log((b.useCount || b.occurrences || 1) + 1);
        return bScore - aScore;
      });
      this.patterns[type] = patterns.slice(0, maxSize);
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      codePatterns: this.patterns.code.length,
      behaviorPatterns: this.patterns.behavior.length,
      errorPatterns: this.patterns.error.length,
      contextPatterns: this.patterns.context.length,
      sequences: this.patterns.sequences.length,
      avgSuccessRate: this.patterns.code.length > 0 
        ? this.patterns.code.reduce((sum, p) => sum + p.successRate, 0) / this.patterns.code.length
        : 0
    };
  }

  /**
   * Export patterns
   */
  export() {
    return JSON.stringify(this.patterns, null, 2);
  }

  /**
   * Clear patterns
   */
  clear() {
    this.patterns = this.load();
    localStorage.removeItem(this.storageKey);
  }
}

// Global instance
window.patternRecognition = new PatternRecognition();

// Export
if (typeof module !== 'undefined') {
  module.exports = { PatternRecognition };
}

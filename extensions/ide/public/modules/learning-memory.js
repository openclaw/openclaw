/**
 * LEARNING MEMORY MODULE
 * Phase 1: Persistent learning storage
 * 
 * Tracks:
 * - Successful patterns (what worked)
 * - Mistake patterns (what to avoid)
 * - User corrections ("no, I meant...")
 * - Capability map (self-assessment)
 */

class LearningMemory {
  constructor() {
    this.storageKey = 'clawd_learning_memory';
    this.memory = this.load();
    
    // Auto-save interval
    this.saveInterval = setInterval(() => this.save(), 60000);
    
    console.log('[LearningMemory] Initialized with', this.getStats());
  }

  /**
   * Load memory from localStorage
   */
  load() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch (e) {
      console.warn('[LearningMemory] Failed to load:', e);
    }

    // Default structure
    return {
      version: 1,
      created: Date.now(),
      updated: Date.now(),
      
      // Successful patterns
      successes: [],
      
      // Mistake patterns
      mistakes: [],
      
      // User corrections
      corrections: [],
      
      // Capability assessments
      capabilities: {},
      
      // Confidence calibration
      calibration: {
        predictions: [],
        score: null
      },
      
      // User preferences learned
      preferences: {},
      
      // Task outcomes
      outcomes: []
    };
  }

  /**
   * Save memory to localStorage
   */
  save() {
    try {
      this.memory.updated = Date.now();
      localStorage.setItem(this.storageKey, JSON.stringify(this.memory));
      return true;
    } catch (e) {
      console.warn('[LearningMemory] Failed to save:', e);
      return false;
    }
  }

  /**
   * Record a successful pattern
   */
  recordSuccess(pattern) {
    const entry = {
      id: this.generateId(),
      timestamp: Date.now(),
      pattern: pattern.pattern,
      context: pattern.context || null,
      category: pattern.category || 'general',
      confidence: pattern.confidence || 0.8,
      useCount: 1
    };

    // Check for similar existing pattern
    const existing = this.memory.successes.find(s => 
      this.similarity(s.pattern, entry.pattern) > 0.8
    );

    if (existing) {
      existing.useCount++;
      existing.confidence = Math.min(1, existing.confidence + 0.05);
      existing.lastUsed = Date.now();
    } else {
      this.memory.successes.push(entry);
    }

    this.save();
    return entry;
  }

  /**
   * Record a mistake pattern
   */
  recordMistake(mistake) {
    const entry = {
      id: this.generateId(),
      timestamp: Date.now(),
      pattern: mistake.pattern,
      description: mistake.description,
      category: mistake.category || 'general',
      severity: mistake.severity || 'medium',
      prevention: mistake.prevention || null,
      occurrences: 1
    };

    // Check for similar existing mistake
    const existing = this.memory.mistakes.find(m => 
      this.similarity(m.pattern, entry.pattern) > 0.8
    );

    if (existing) {
      existing.occurrences++;
      existing.lastOccurred = Date.now();
      if (existing.severity !== 'critical' && entry.severity === 'critical') {
        existing.severity = 'critical';
      }
    } else {
      this.memory.mistakes.push(entry);
    }

    this.save();
    return entry;
  }

  /**
   * Record a user correction
   */
  recordCorrection(correction) {
    const entry = {
      id: this.generateId(),
      timestamp: Date.now(),
      original: correction.original,
      corrected: correction.corrected,
      explanation: correction.explanation || null,
      category: correction.category || 'general',
      learned: false
    };

    this.memory.corrections.push(entry);

    // Extract pattern from correction
    this.extractPatternFromCorrection(entry);

    this.save();
    return entry;
  }

  /**
   * Extract learnable pattern from a correction
   */
  extractPatternFromCorrection(correction) {
    // Simple pattern extraction - look for what changed
    const original = correction.original.toLowerCase();
    const corrected = correction.corrected.toLowerCase();

    // If it's a simple substitution, learn it
    if (original.length < 100 && corrected.length < 100) {
      this.recordMistake({
        pattern: original,
        description: `User corrected to: "${corrected}"`,
        category: 'user_correction',
        severity: 'low',
        prevention: corrected
      });

      correction.learned = true;
    }
  }

  /**
   * Update capability assessment
   */
  updateCapability(capability, assessment) {
    if (!this.memory.capabilities[capability]) {
      this.memory.capabilities[capability] = {
        score: 0.5,
        samples: 0,
        lastUpdated: null,
        trend: 'new'
      };
    }

    const cap = this.memory.capabilities[capability];
    const oldScore = cap.score;

    // Weighted average with new assessment
    cap.samples++;
    cap.score = (cap.score * (cap.samples - 1) + assessment.score) / cap.samples;
    cap.lastUpdated = Date.now();

    // Calculate trend
    if (cap.samples > 5) {
      const diff = cap.score - oldScore;
      cap.trend = diff > 0.02 ? 'improving' : diff < -0.02 ? 'declining' : 'stable';
    }

    this.save();
    return cap;
  }

  /**
   * Record a prediction for calibration
   */
  recordPrediction(prediction) {
    const entry = {
      id: this.generateId(),
      timestamp: Date.now(),
      claim: prediction.claim,
      confidence: prediction.confidence,
      outcome: null,
      resolved: false
    };

    this.memory.calibration.predictions.push(entry);

    // Trim old predictions
    if (this.memory.calibration.predictions.length > 200) {
      this.memory.calibration.predictions = 
        this.memory.calibration.predictions.slice(-200);
    }

    this.save();
    return entry;
  }

  /**
   * Resolve a prediction with actual outcome
   */
  resolvePrediction(predictionId, wasCorrect) {
    const prediction = this.memory.calibration.predictions.find(p => p.id === predictionId);
    if (!prediction) return null;

    prediction.outcome = wasCorrect;
    prediction.resolved = true;
    prediction.resolvedAt = Date.now();

    // Recalculate calibration score
    this.updateCalibrationScore();

    this.save();
    return prediction;
  }

  /**
   * Update overall calibration score
   */
  updateCalibrationScore() {
    const resolved = this.memory.calibration.predictions.filter(p => p.resolved);
    if (resolved.length < 10) {
      this.memory.calibration.score = null;
      return;
    }

    // Calculate Brier score (lower is better, 0 is perfect)
    let brierSum = 0;
    for (const p of resolved) {
      const actual = p.outcome ? 1 : 0;
      brierSum += Math.pow(p.confidence - actual, 2);
    }
    const brierScore = brierSum / resolved.length;

    // Convert to 0-1 scale where 1 is well-calibrated
    this.memory.calibration.score = 1 - brierScore;
  }

  /**
   * Learn a user preference
   */
  learnPreference(key, value, context = null) {
    if (!this.memory.preferences[key]) {
      this.memory.preferences[key] = {
        value,
        confidence: 0.5,
        observations: 1,
        context: context ? [context] : []
      };
    } else {
      const pref = this.memory.preferences[key];
      
      if (pref.value === value) {
        // Reinforce
        pref.confidence = Math.min(1, pref.confidence + 0.1);
        pref.observations++;
      } else {
        // Conflict - reduce confidence or update
        if (pref.confidence < 0.5) {
          pref.value = value;
          pref.confidence = 0.5;
        } else {
          pref.confidence -= 0.1;
        }
      }

      if (context) {
        pref.context.push(context);
        pref.context = pref.context.slice(-5); // Keep last 5 contexts
      }
    }

    this.save();
    return this.memory.preferences[key];
  }

  /**
   * Record task outcome
   */
  recordOutcome(outcome) {
    const entry = {
      id: this.generateId(),
      timestamp: Date.now(),
      task: outcome.task,
      success: outcome.success,
      duration: outcome.duration || null,
      retries: outcome.retries || 0,
      category: outcome.category || 'general',
      notes: outcome.notes || null
    };

    this.memory.outcomes.push(entry);

    // Update relevant capability
    if (entry.category) {
      this.updateCapability(entry.category, {
        score: entry.success ? 1 : 0
      });
    }

    // Trim old outcomes
    if (this.memory.outcomes.length > 500) {
      this.memory.outcomes = this.memory.outcomes.slice(-500);
    }

    this.save();
    return entry;
  }

  /**
   * Get relevant patterns for a context
   */
  getRelevantPatterns(context) {
    const relevant = {
      successes: [],
      mistakes: [],
      preferences: {}
    };

    const contextStr = JSON.stringify(context).toLowerCase();

    // Find relevant successes
    for (const success of this.memory.successes) {
      if (this.isRelevant(success, contextStr)) {
        relevant.successes.push(success);
      }
    }

    // Find relevant mistakes
    for (const mistake of this.memory.mistakes) {
      if (this.isRelevant(mistake, contextStr)) {
        relevant.mistakes.push(mistake);
      }
    }

    // Include high-confidence preferences
    for (const [key, pref] of Object.entries(this.memory.preferences)) {
      if (pref.confidence >= 0.7) {
        relevant.preferences[key] = pref.value;
      }
    }

    return relevant;
  }

  /**
   * Check if a pattern is relevant to context
   */
  isRelevant(pattern, contextStr) {
    if (!pattern.category) return false;
    
    // Category match
    if (contextStr.includes(pattern.category)) return true;
    
    // Pattern text match
    if (pattern.pattern && contextStr.includes(pattern.pattern.toLowerCase().slice(0, 50))) {
      return true;
    }

    return false;
  }

  /**
   * Simple similarity check
   */
  similarity(str1, str2) {
    if (!str1 || !str2) return 0;
    
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    
    if (s1 === s2) return 1;
    
    // Jaccard similarity on words
    const words1 = new Set(s1.split(/\s+/));
    const words2 = new Set(s2.split(/\s+/));
    
    const intersection = new Set([...words1].filter(w => words2.has(w)));
    const union = new Set([...words1, ...words2]);
    
    return intersection.size / union.size;
  }

  /**
   * Generate unique ID
   */
  generateId() {
    return `lm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Get memory statistics
   */
  getStats() {
    return {
      successes: this.memory.successes.length,
      mistakes: this.memory.mistakes.length,
      corrections: this.memory.corrections.length,
      capabilities: Object.keys(this.memory.capabilities).length,
      predictions: this.memory.calibration.predictions.length,
      calibrationScore: this.memory.calibration.score,
      preferences: Object.keys(this.memory.preferences).length,
      outcomes: this.memory.outcomes.length,
      age: Date.now() - this.memory.created
    };
  }

  /**
   * Export memory for backup
   */
  export() {
    return JSON.stringify(this.memory, null, 2);
  }

  /**
   * Import memory from backup
   */
  import(data) {
    try {
      const imported = JSON.parse(data);
      if (imported.version) {
        this.memory = imported;
        this.save();
        return true;
      }
    } catch (e) {
      console.error('[LearningMemory] Import failed:', e);
    }
    return false;
  }

  /**
   * Clear all memory
   */
  clear() {
    localStorage.removeItem(this.storageKey);
    this.memory = this.load();
  }

  /**
   * Get capability summary for display
   */
  getCapabilitySummary() {
    const summary = [];
    
    for (const [name, cap] of Object.entries(this.memory.capabilities)) {
      summary.push({
        name,
        score: cap.score,
        trend: cap.trend,
        samples: cap.samples,
        level: cap.score >= 0.8 ? 'high' : cap.score >= 0.6 ? 'medium' : 'low'
      });
    }

    return summary.sort((a, b) => b.score - a.score);
  }
}

// Global instance
window.learningMemory = new LearningMemory();

// Export for modules
if (typeof module !== 'undefined') {
  module.exports = { LearningMemory };
}

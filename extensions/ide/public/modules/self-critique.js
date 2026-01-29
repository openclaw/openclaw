/**
 * SELF-CRITIQUE MODULE
 * Phase 1: Pre-response self-evaluation
 * 
 * Before sending any AI response, evaluate:
 * - Factual accuracy confidence
 * - Completeness
 * - Alignment with user intent
 * - Potential mistakes (check against known patterns)
 */

class SelfCritique {
  constructor() {
    this.enabled = true;
    this.confidenceThreshold = 0.8;
    this.critiqueHistory = [];
    this.maxHistory = 100;
    
    // Load critique patterns from localStorage
    this.patterns = this.loadPatterns();
    
    console.log('[SelfCritique] Initialized');
  }

  /**
   * Main critique method - evaluate a response before sending
   */
  async critique(response, context = {}) {
    if (!this.enabled) return { approved: true, response };

    const evaluation = {
      timestamp: Date.now(),
      originalResponse: response,
      context,
      checks: {}
    };

    // 1. Completeness check
    evaluation.checks.completeness = this.checkCompleteness(response, context);

    // 2. Known mistake patterns
    evaluation.checks.mistakePatterns = this.checkMistakePatterns(response);

    // 3. Confidence estimation
    evaluation.checks.confidence = this.estimateConfidence(response, context);

    // 4. Intent alignment (if context provided)
    if (context.userQuery) {
      evaluation.checks.intentAlignment = this.checkIntentAlignment(response, context.userQuery);
    }

    // Calculate overall score
    const scores = Object.values(evaluation.checks).map(c => c.score);
    evaluation.overallScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    evaluation.approved = evaluation.overallScore >= this.confidenceThreshold;

    // If not approved, attempt self-refinement
    if (!evaluation.approved && evaluation.overallScore > 0.5) {
      evaluation.refinementSuggestions = this.generateRefinementSuggestions(evaluation);
    }

    // Store in history
    this.addToHistory(evaluation);

    return evaluation;
  }

  /**
   * Check if response addresses all parts of the query
   */
  checkCompleteness(response, context) {
    const result = {
      name: 'completeness',
      score: 1.0,
      issues: []
    };

    // Check response length (too short might be incomplete)
    if (response.length < 50 && context.expectedLength !== 'short') {
      result.score -= 0.3;
      result.issues.push('Response may be too brief');
    }

    // Check for question marks in query that need answers
    if (context.userQuery) {
      const questionCount = (context.userQuery.match(/\?/g) || []).length;
      const answerIndicators = response.match(/\b(yes|no|because|therefore|the answer|to|by|with)\b/gi) || [];
      
      if (questionCount > 0 && answerIndicators.length < questionCount) {
        result.score -= 0.2;
        result.issues.push(`Query has ${questionCount} questions, response may not address all`);
      }
    }

    // Check for code if code was requested
    if (context.userQuery && /\b(code|function|implement|write|create)\b/i.test(context.userQuery)) {
      if (!response.includes('```') && !response.includes('function') && !response.includes('const')) {
        result.score -= 0.3;
        result.issues.push('Code was requested but response may not include code');
      }
    }

    return result;
  }

  /**
   * Check against known mistake patterns
   */
  checkMistakePatterns(response) {
    const result = {
      name: 'mistakePatterns',
      score: 1.0,
      matches: []
    };

    // Common AI mistake patterns
    const patterns = [
      {
        regex: /I don't have access|I cannot access|I'm unable to/i,
        issue: 'Claims inability when tools are available',
        deduction: 0.2
      },
      {
        regex: /as of my (knowledge|training) cutoff/i,
        issue: 'References training cutoff (may have current data)',
        deduction: 0.1
      },
      {
        regex: /I apologize|I'm sorry/i,
        issue: 'Excessive apologizing (check if warranted)',
        deduction: 0.05
      },
      {
        regex: /undefined|null|NaN/i,
        issue: 'Contains potential error values in code',
        deduction: 0.15
      },
      {
        regex: /TODO|FIXME|XXX/i,
        issue: 'Contains unfinished markers',
        deduction: 0.1
      },
      {
        regex: /\.\.\.|etc\./i,
        issue: 'Uses ellipsis/etc (may be incomplete)',
        deduction: 0.1
      }
    ];

    // Add loaded patterns
    patterns.push(...this.patterns.mistakes || []);

    for (const pattern of patterns) {
      if (pattern.regex.test(response)) {
        result.score -= pattern.deduction;
        result.matches.push(pattern.issue);
      }
    }

    result.score = Math.max(0, result.score);
    return result;
  }

  /**
   * Estimate confidence based on response characteristics
   */
  estimateConfidence(response, context) {
    const result = {
      name: 'confidence',
      score: 0.85, // Start with reasonable confidence
      factors: []
    };

    // Hedging language reduces confidence
    const hedges = response.match(/\b(might|maybe|perhaps|possibly|could be|not sure|uncertain)\b/gi) || [];
    if (hedges.length > 0) {
      result.score -= hedges.length * 0.05;
      result.factors.push(`Hedging language detected (${hedges.length} instances)`);
    }

    // Definitive language increases confidence
    const definitive = response.match(/\b(definitely|certainly|always|never|must|will)\b/gi) || [];
    if (definitive.length > 0) {
      result.factors.push(`Definitive language (${definitive.length} instances)`);
    }

    // Code with proper structure increases confidence
    if (response.includes('```')) {
      const codeBlocks = response.match(/```[\s\S]*?```/g) || [];
      if (codeBlocks.length > 0) {
        result.score += 0.05;
        result.factors.push('Contains structured code blocks');
      }
    }

    // References/citations increase confidence
    if (response.match(/according to|source:|reference:|docs:/i)) {
      result.score += 0.05;
      result.factors.push('Contains references');
    }

    result.score = Math.min(1, Math.max(0, result.score));
    return result;
  }

  /**
   * Check if response aligns with user's likely intent
   */
  checkIntentAlignment(response, query) {
    const result = {
      name: 'intentAlignment',
      score: 0.9,
      analysis: []
    };

    // Extract key terms from query
    const queryTerms = query.toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3);

    // Check how many query terms appear in response
    const responseLower = response.toLowerCase();
    let matchCount = 0;
    for (const term of queryTerms) {
      if (responseLower.includes(term)) matchCount++;
    }

    const matchRatio = queryTerms.length > 0 ? matchCount / queryTerms.length : 1;
    if (matchRatio < 0.3) {
      result.score -= 0.2;
      result.analysis.push('Response may not address query terms');
    }

    // Check for question type alignment
    if (/^(how|what|why|when|where|who)/i.test(query)) {
      const questionType = query.match(/^(how|what|why|when|where|who)/i)[1].toLowerCase();
      
      const alignmentMap = {
        'how': /\b(by|through|using|step|first|then|finally)\b/i,
        'what': /\b(is|are|means|refers|definition)\b/i,
        'why': /\b(because|reason|due to|since|therefore)\b/i,
        'when': /\b(when|time|date|during|after|before)\b/i,
        'where': /\b(in|at|location|place|directory|file)\b/i,
        'who': /\b(person|user|developer|team|author)\b/i
      };

      if (alignmentMap[questionType] && !alignmentMap[questionType].test(response)) {
        result.score -= 0.1;
        result.analysis.push(`${questionType}-question may not have ${questionType}-style answer`);
      }
    }

    return result;
  }

  /**
   * Generate suggestions for improving the response
   */
  generateRefinementSuggestions(evaluation) {
    const suggestions = [];

    for (const [checkName, check] of Object.entries(evaluation.checks)) {
      if (check.score < 0.8) {
        if (check.issues) suggestions.push(...check.issues);
        if (check.matches) suggestions.push(...check.matches);
        if (check.analysis) suggestions.push(...check.analysis);
      }
    }

    return suggestions;
  }

  /**
   * Add evaluation to history for learning
   */
  addToHistory(evaluation) {
    this.critiqueHistory.unshift({
      timestamp: evaluation.timestamp,
      overallScore: evaluation.overallScore,
      approved: evaluation.approved,
      checkScores: Object.fromEntries(
        Object.entries(evaluation.checks).map(([k, v]) => [k, v.score])
      )
    });

    // Trim history
    if (this.critiqueHistory.length > this.maxHistory) {
      this.critiqueHistory = this.critiqueHistory.slice(0, this.maxHistory);
    }

    // Persist
    this.saveHistory();
  }

  /**
   * Get calibration stats
   */
  getCalibrationStats() {
    if (this.critiqueHistory.length === 0) {
      return { count: 0, avgScore: 0, approvalRate: 0 };
    }

    const scores = this.critiqueHistory.map(h => h.overallScore);
    const approved = this.critiqueHistory.filter(h => h.approved).length;

    return {
      count: this.critiqueHistory.length,
      avgScore: scores.reduce((a, b) => a + b, 0) / scores.length,
      approvalRate: approved / this.critiqueHistory.length,
      recentTrend: this.calculateTrend()
    };
  }

  /**
   * Calculate recent score trend
   */
  calculateTrend() {
    if (this.critiqueHistory.length < 10) return 'insufficient_data';

    const recent = this.critiqueHistory.slice(0, 10).map(h => h.overallScore);
    const older = this.critiqueHistory.slice(10, 20).map(h => h.overallScore);

    if (older.length === 0) return 'insufficient_data';

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;

    const diff = recentAvg - olderAvg;
    if (diff > 0.05) return 'improving';
    if (diff < -0.05) return 'declining';
    return 'stable';
  }

  /**
   * Load patterns from localStorage
   */
  loadPatterns() {
    try {
      const stored = localStorage.getItem('clawd_critique_patterns');
      return stored ? JSON.parse(stored) : { mistakes: [], successes: [] };
    } catch {
      return { mistakes: [], successes: [] };
    }
  }

  /**
   * Save history to localStorage
   */
  saveHistory() {
    try {
      localStorage.setItem('clawd_critique_history', JSON.stringify(this.critiqueHistory));
    } catch (e) {
      console.warn('[SelfCritique] Failed to save history:', e);
    }
  }

  /**
   * Learn from user feedback
   */
  learnFromFeedback(evaluation, wasCorrect) {
    // If we approved something that was wrong, lower threshold
    // If we rejected something that was right, raise threshold
    
    if (evaluation.approved && !wasCorrect) {
      // False positive - we let through a bad response
      this.confidenceThreshold = Math.min(0.95, this.confidenceThreshold + 0.02);
      console.log('[SelfCritique] Raised threshold to', this.confidenceThreshold);
    } else if (!evaluation.approved && wasCorrect) {
      // False negative - we rejected a good response
      this.confidenceThreshold = Math.max(0.6, this.confidenceThreshold - 0.02);
      console.log('[SelfCritique] Lowered threshold to', this.confidenceThreshold);
    }

    localStorage.setItem('clawd_critique_threshold', this.confidenceThreshold.toString());
  }
}

// Global instance
window.selfCritique = new SelfCritique();

// Export for modules
if (typeof module !== 'undefined') {
  module.exports = { SelfCritique };
}

/**
 * CAPABILITY TRACKER MODULE
 * Phase 3: Self-assessment of abilities
 * 
 * Tracks performance across different task types
 * to build an accurate picture of strengths and weaknesses.
 */

class CapabilityTracker {
  constructor() {
    this.storageKey = 'clawd_capabilities';
    this.capabilities = this.load();
    
    console.log('[CapabilityTracker] Initialized with', Object.keys(this.capabilities.skills).length, 'tracked skills');
  }

  /**
   * Load capabilities
   */
  load() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) return JSON.parse(stored);
    } catch {}

    return {
      version: 1,
      lastUpdated: null,
      
      // Core skills
      skills: {
        // Programming languages
        javascript: { score: 0.5, samples: 0, trend: 'new' },
        typescript: { score: 0.5, samples: 0, trend: 'new' },
        python: { score: 0.5, samples: 0, trend: 'new' },
        react: { score: 0.5, samples: 0, trend: 'new' },
        nodejs: { score: 0.5, samples: 0, trend: 'new' },
        
        // Task types
        debugging: { score: 0.5, samples: 0, trend: 'new' },
        refactoring: { score: 0.5, samples: 0, trend: 'new' },
        testing: { score: 0.5, samples: 0, trend: 'new' },
        documentation: { score: 0.5, samples: 0, trend: 'new' },
        architecture: { score: 0.5, samples: 0, trend: 'new' },
        
        // Cognitive tasks
        explanation: { score: 0.5, samples: 0, trend: 'new' },
        planning: { score: 0.5, samples: 0, trend: 'new' },
        research: { score: 0.5, samples: 0, trend: 'new' },
        analysis: { score: 0.5, samples: 0, trend: 'new' }
      },
      
      // Task history
      history: [],
      
      // Skill gaps identified
      gaps: [],
      
      // Areas of strength
      strengths: [],
      
      // Improvement suggestions
      suggestions: []
    };
  }

  /**
   * Save capabilities
   */
  save() {
    this.capabilities.lastUpdated = Date.now();
    localStorage.setItem(this.storageKey, JSON.stringify(this.capabilities));
  }

  /**
   * Record a task outcome
   */
  recordTask(task) {
    const {
      type,
      skill,
      success,
      difficulty = 'medium',
      duration = null,
      userSatisfaction = null
    } = task;

    // Calculate score for this task
    let taskScore = success ? 1 : 0;
    
    // Adjust for difficulty
    if (success && difficulty === 'hard') taskScore = 1.2;
    if (!success && difficulty === 'easy') taskScore = -0.2;
    
    // Adjust for user satisfaction if available
    if (userSatisfaction !== null) {
      taskScore = (taskScore + userSatisfaction) / 2;
    }

    // Update skill
    const skills = Array.isArray(skill) ? skill : [skill];
    for (const s of skills) {
      this.updateSkill(s, taskScore);
    }

    // Record in history
    this.capabilities.history.push({
      timestamp: Date.now(),
      type,
      skills,
      success,
      difficulty,
      score: taskScore
    });

    // Trim history
    if (this.capabilities.history.length > 500) {
      this.capabilities.history = this.capabilities.history.slice(-500);
    }

    // Update analysis
    this.analyzeCapabilities();

    this.save();
  }

  /**
   * Update a skill score
   */
  updateSkill(skillName, taskScore) {
    // Create skill if doesn't exist
    if (!this.capabilities.skills[skillName]) {
      this.capabilities.skills[skillName] = {
        score: 0.5,
        samples: 0,
        trend: 'new'
      };
    }

    const skill = this.capabilities.skills[skillName];
    const oldScore = skill.score;

    // Weighted update (recent tasks matter more)
    const weight = Math.min(0.3, 1 / (skill.samples + 1));
    skill.score = skill.score * (1 - weight) + taskScore * weight;
    skill.score = Math.max(0, Math.min(1, skill.score));
    skill.samples++;
    skill.lastUpdated = Date.now();

    // Calculate trend
    if (skill.samples > 5) {
      const diff = skill.score - oldScore;
      skill.trend = diff > 0.02 ? 'improving' : diff < -0.02 ? 'declining' : 'stable';
    }
  }

  /**
   * Analyze capabilities to identify strengths and gaps
   */
  analyzeCapabilities() {
    const skills = Object.entries(this.capabilities.skills)
      .filter(([_, data]) => data.samples >= 3)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.score - a.score);

    // Identify strengths (top performers with good sample size)
    this.capabilities.strengths = skills
      .filter(s => s.score >= 0.7 && s.samples >= 5)
      .slice(0, 5)
      .map(s => ({
        skill: s.name,
        score: s.score,
        confidence: Math.min(1, s.samples / 20)
      }));

    // Identify gaps (low performers)
    this.capabilities.gaps = skills
      .filter(s => s.score < 0.5 && s.samples >= 3)
      .map(s => ({
        skill: s.name,
        score: s.score,
        priority: s.samples >= 10 ? 'high' : 'medium'
      }));

    // Generate suggestions
    this.generateSuggestions();
  }

  /**
   * Generate improvement suggestions
   */
  generateSuggestions() {
    const suggestions = [];

    // Suggest focusing on declining skills
    for (const [name, data] of Object.entries(this.capabilities.skills)) {
      if (data.trend === 'declining' && data.samples >= 5) {
        suggestions.push({
          type: 'declining_skill',
          skill: name,
          message: `${name} performance is declining. Consider reviewing recent ${name} tasks.`,
          priority: 'high'
        });
      }
    }

    // Suggest building weak skills
    for (const gap of this.capabilities.gaps) {
      suggestions.push({
        type: 'skill_gap',
        skill: gap.skill,
        message: `${gap.skill} needs improvement (${(gap.score * 100).toFixed(0)}% success rate).`,
        priority: gap.priority
      });
    }

    // Suggest leveraging strengths
    for (const strength of this.capabilities.strengths.slice(0, 2)) {
      suggestions.push({
        type: 'leverage_strength',
        skill: strength.skill,
        message: `Strong at ${strength.skill} (${(strength.score * 100).toFixed(0)}% success). Consider leading with this.`,
        priority: 'info'
      });
    }

    this.capabilities.suggestions = suggestions.slice(0, 10);
  }

  /**
   * Get skill level
   */
  getSkillLevel(score) {
    if (score >= 0.9) return { level: 'expert', icon: '🏆' };
    if (score >= 0.75) return { level: 'proficient', icon: '⭐' };
    if (score >= 0.6) return { level: 'competent', icon: '✓' };
    if (score >= 0.4) return { level: 'developing', icon: '📈' };
    return { level: 'learning', icon: '🌱' };
  }

  /**
   * Get capability summary
   */
  getSummary() {
    const skills = Object.entries(this.capabilities.skills)
      .filter(([_, data]) => data.samples > 0)
      .map(([name, data]) => ({
        name,
        score: data.score,
        samples: data.samples,
        trend: data.trend,
        level: this.getSkillLevel(data.score)
      }))
      .sort((a, b) => b.score - a.score);

    return {
      totalSkills: skills.length,
      averageScore: skills.length > 0 
        ? skills.reduce((sum, s) => sum + s.score, 0) / skills.length 
        : 0,
      topSkills: skills.slice(0, 5),
      weakSkills: skills.filter(s => s.score < 0.5).slice(0, 5),
      improvingSkills: skills.filter(s => s.trend === 'improving'),
      decliningSkills: skills.filter(s => s.trend === 'declining'),
      strengths: this.capabilities.strengths,
      gaps: this.capabilities.gaps,
      suggestions: this.capabilities.suggestions
    };
  }

  /**
   * Render capability chart
   */
  renderChart(container) {
    const skills = Object.entries(this.capabilities.skills)
      .filter(([_, data]) => data.samples >= 3)
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    let html = `<div class="capability-chart">`;

    for (const skill of skills) {
      const percentage = (skill.score * 100).toFixed(0);
      const level = this.getSkillLevel(skill.score);
      const trendIcon = skill.trend === 'improving' ? '↑' : skill.trend === 'declining' ? '↓' : '→';

      html += `
        <div class="capability-row">
          <div class="capability-name">${skill.name}</div>
          <div class="capability-bar-container">
            <div class="capability-bar" style="width: ${percentage}%"></div>
          </div>
          <div class="capability-score">${percentage}% ${trendIcon}</div>
          <div class="capability-level">${level.icon}</div>
        </div>
      `;
    }

    html += `</div>`;

    if (container) {
      container.innerHTML = html;
    }
    return html;
  }

  /**
   * Get confidence for a task
   */
  getConfidenceForTask(taskSkills) {
    const skills = Array.isArray(taskSkills) ? taskSkills : [taskSkills];
    let totalScore = 0;
    let count = 0;

    for (const skill of skills) {
      if (this.capabilities.skills[skill] && this.capabilities.skills[skill].samples >= 3) {
        totalScore += this.capabilities.skills[skill].score;
        count++;
      }
    }

    if (count === 0) return { confidence: 0.5, reason: 'No historical data for these skills' };

    const avgScore = totalScore / count;
    let confidence = avgScore;
    let reason = '';

    if (avgScore >= 0.8) {
      reason = 'High confidence based on past performance';
    } else if (avgScore >= 0.6) {
      reason = 'Moderate confidence based on mixed past results';
    } else {
      reason = 'Lower confidence - consider extra verification';
    }

    return { confidence, reason };
  }

  /**
   * Export data
   */
  export() {
    return JSON.stringify(this.capabilities, null, 2);
  }

  /**
   * Clear data
   */
  clear() {
    localStorage.removeItem(this.storageKey);
    this.capabilities = this.load();
  }
}

// Global instance
window.capabilityTracker = new CapabilityTracker();

// Export
if (typeof module !== 'undefined') {
  module.exports = { CapabilityTracker };
}

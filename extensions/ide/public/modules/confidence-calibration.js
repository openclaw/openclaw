/**
 * CONFIDENCE CALIBRATION MODULE
 * Phase 1: Track prediction vs outcome
 * 
 * Measures how well the AI's confidence matches actual outcomes.
 * A well-calibrated AI saying "80% confident" should be right 80% of the time.
 */

class ConfidenceCalibration {
  constructor() {
    this.storageKey = 'clawd_calibration';
    this.data = this.load();
    this.pendingPredictions = new Map();
    
    // UI element
    this.badge = null;
    
    console.log('[Calibration] Initialized, score:', this.getScore());
  }

  /**
   * Load calibration data
   */
  load() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) return JSON.parse(stored);
    } catch (e) {}
    
    return {
      predictions: [],
      buckets: {
        '0.0-0.2': { correct: 0, total: 0 },
        '0.2-0.4': { correct: 0, total: 0 },
        '0.4-0.6': { correct: 0, total: 0 },
        '0.6-0.8': { correct: 0, total: 0 },
        '0.8-1.0': { correct: 0, total: 0 }
      },
      history: [],
      lastUpdated: null
    };
  }

  /**
   * Save calibration data
   */
  save() {
    this.data.lastUpdated = Date.now();
    localStorage.setItem(this.storageKey, JSON.stringify(this.data));
  }

  /**
   * Record a prediction
   */
  predict(claim, confidence, metadata = {}) {
    const prediction = {
      id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      claim,
      confidence: Math.max(0, Math.min(1, confidence)),
      timestamp: Date.now(),
      metadata,
      resolved: false
    };

    this.data.predictions.push(prediction);
    this.pendingPredictions.set(prediction.id, prediction);
    
    // Trim old predictions
    if (this.data.predictions.length > 500) {
      this.data.predictions = this.data.predictions.slice(-500);
    }

    this.save();
    return prediction.id;
  }

  /**
   * Resolve a prediction with actual outcome
   */
  resolve(predictionId, wasCorrect) {
    const prediction = this.data.predictions.find(p => p.id === predictionId);
    if (!prediction || prediction.resolved) return null;

    prediction.resolved = true;
    prediction.outcome = wasCorrect;
    prediction.resolvedAt = Date.now();

    // Update bucket
    const bucket = this.getBucket(prediction.confidence);
    this.data.buckets[bucket].total++;
    if (wasCorrect) {
      this.data.buckets[bucket].correct++;
    }

    // Add to history
    this.data.history.push({
      timestamp: Date.now(),
      confidence: prediction.confidence,
      correct: wasCorrect
    });

    // Trim history
    if (this.data.history.length > 1000) {
      this.data.history = this.data.history.slice(-1000);
    }

    this.pendingPredictions.delete(predictionId);
    this.save();
    this.updateUI();

    return prediction;
  }

  /**
   * Get bucket key for confidence value
   */
  getBucket(confidence) {
    if (confidence < 0.2) return '0.0-0.2';
    if (confidence < 0.4) return '0.2-0.4';
    if (confidence < 0.6) return '0.4-0.6';
    if (confidence < 0.8) return '0.6-0.8';
    return '0.8-1.0';
  }

  /**
   * Calculate calibration score (0-1, higher is better)
   */
  getScore() {
    let totalError = 0;
    let totalSamples = 0;

    for (const [range, bucket] of Object.entries(this.data.buckets)) {
      if (bucket.total < 5) continue; // Need minimum samples

      const [min, max] = range.split('-').map(Number);
      const expectedRate = (min + max) / 2;
      const actualRate = bucket.correct / bucket.total;
      
      totalError += Math.pow(expectedRate - actualRate, 2) * bucket.total;
      totalSamples += bucket.total;
    }

    if (totalSamples < 20) return null; // Not enough data

    // Return 1 - RMSE (so higher is better)
    const rmse = Math.sqrt(totalError / totalSamples);
    return Math.max(0, 1 - rmse);
  }

  /**
   * Get calibration breakdown by bucket
   */
  getBreakdown() {
    const breakdown = [];

    for (const [range, bucket] of Object.entries(this.data.buckets)) {
      const [min, max] = range.split('-').map(Number);
      const expected = (min + max) / 2;
      const actual = bucket.total > 0 ? bucket.correct / bucket.total : null;

      breakdown.push({
        range,
        expected,
        actual,
        total: bucket.total,
        correct: bucket.correct,
        calibration: actual !== null ? 1 - Math.abs(expected - actual) : null
      });
    }

    return breakdown;
  }

  /**
   * Get recent trend
   */
  getTrend(windowSize = 50) {
    if (this.data.history.length < windowSize * 2) return null;

    const recent = this.data.history.slice(-windowSize);
    const older = this.data.history.slice(-windowSize * 2, -windowSize);

    const recentAccuracy = recent.filter(h => h.correct).length / recent.length;
    const olderAccuracy = older.filter(h => h.correct).length / older.length;

    const diff = recentAccuracy - olderAccuracy;
    return {
      recent: recentAccuracy,
      older: olderAccuracy,
      diff,
      trend: diff > 0.05 ? 'improving' : diff < -0.05 ? 'declining' : 'stable'
    };
  }

  /**
   * Get overconfidence/underconfidence analysis
   */
  getConfidenceAnalysis() {
    const breakdown = this.getBreakdown();
    const issues = [];

    for (const bucket of breakdown) {
      if (bucket.total < 10) continue;

      const diff = bucket.expected - bucket.actual;
      
      if (diff > 0.15) {
        issues.push({
          type: 'overconfident',
          range: bucket.range,
          expected: bucket.expected,
          actual: bucket.actual,
          message: `Overconfident in ${bucket.range} range: expected ${(bucket.expected*100).toFixed(0)}% accuracy, got ${(bucket.actual*100).toFixed(0)}%`
        });
      } else if (diff < -0.15) {
        issues.push({
          type: 'underconfident',
          range: bucket.range,
          expected: bucket.expected,
          actual: bucket.actual,
          message: `Underconfident in ${bucket.range} range: expected ${(bucket.expected*100).toFixed(0)}% accuracy, got ${(bucket.actual*100).toFixed(0)}%`
        });
      }
    }

    return issues;
  }

  /**
   * Suggest confidence adjustment
   */
  suggestAdjustment(rawConfidence) {
    const bucket = this.getBucket(rawConfidence);
    const bucketData = this.data.buckets[bucket];

    if (bucketData.total < 10) return rawConfidence;

    const [min, max] = bucket.split('-').map(Number);
    const expected = (min + max) / 2;
    const actual = bucketData.correct / bucketData.total;

    // Adjust confidence based on historical accuracy
    const adjustment = (actual - expected) * 0.5; // Conservative adjustment
    return Math.max(0.1, Math.min(0.99, rawConfidence + adjustment));
  }

  /**
   * Create/update UI badge
   */
  updateUI() {
    const score = this.getScore();
    if (score === null) return;

    if (!this.badge) {
      this.badge = document.getElementById('calibrationBadge');
    }

    if (this.badge) {
      const percentage = Math.round(score * 100);
      this.badge.textContent = `${percentage}%`;
      this.badge.title = `Calibration Score: ${percentage}% (based on ${this.data.history.length} predictions)`;
      
      // Color based on score
      this.badge.classList.remove('good', 'medium', 'poor');
      if (score >= 0.85) this.badge.classList.add('good');
      else if (score >= 0.7) this.badge.classList.add('medium');
      else this.badge.classList.add('poor');
    }
  }

  /**
   * Render calibration chart
   */
  renderChart(container) {
    const breakdown = this.getBreakdown();
    
    let html = `
      <div class="calibration-chart">
        <div class="chart-title">Calibration: Confidence vs Accuracy</div>
        <div class="chart-bars">
    `;

    for (const bucket of breakdown) {
      const expectedHeight = bucket.expected * 100;
      const actualHeight = bucket.actual !== null ? bucket.actual * 100 : 0;
      const hasData = bucket.total > 0;

      html += `
        <div class="chart-bucket" data-range="${bucket.range}">
          <div class="bucket-bars">
            <div class="bar expected" style="height: ${expectedHeight}%;" title="Expected: ${(bucket.expected*100).toFixed(0)}%"></div>
            <div class="bar actual ${hasData ? '' : 'no-data'}" style="height: ${actualHeight}%;" title="Actual: ${hasData ? (bucket.actual*100).toFixed(0) + '%' : 'No data'}"></div>
          </div>
          <div class="bucket-label">${bucket.range}</div>
          <div class="bucket-count">${bucket.total} samples</div>
        </div>
      `;
    }

    html += `
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-color expected"></span> Expected</span>
          <span class="legend-item"><span class="legend-color actual"></span> Actual</span>
        </div>
      </div>
    `;

    if (container) {
      container.innerHTML = html;
    }
    return html;
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
    this.pendingPredictions.clear();
  }
}

// Global instance
window.confidenceCalibration = new ConfidenceCalibration();

// Export
if (typeof module !== 'undefined') {
  module.exports = { ConfidenceCalibration };
}

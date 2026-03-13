/**
 * Trace Standard
 * 
 * Standardized tracing for all agent flows.
 * Links: request → routing → execution → outcome
 * Provides observability and feedback loop for improvements.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TRACE_DIR = path.join(__dirname, '..', 'memory', 'traces');

// Ensure directory exists
if (!fs.existsSync(TRACE_DIR)) {
  fs.mkdirSync(TRACE_DIR, { recursive: true });
}

/**
 * Create a new trace
 * @param {Object} request - Initial request data
 * @returns {Object} Trace instance
 */
function createTrace(request) {
  const traceId = `trace-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  
  const trace = {
    id: traceId,
    startedAt: new Date().toISOString(),
    request: {
      text: request,
      timestamp: new Date().toISOString()
    },
    routing: null,
    steps: [],
    outcome: null,
    feedback: null,
    metrics: {
      totalTokens: 0,
      totalLatency: 0,
      toolCalls: 0
    }
  };
  
  return {
    id: traceId,
    data: trace,
    
    // Record routing decision
    logRouting(routing) {
      trace.routing = {
        level: routing.level,
        justification: routing.justification,
        confidence: routing.confidence,
        timestamp: new Date().toISOString()
      };
      return this;
    },
    
    // Record execution step
    logStep(step) {
      trace.steps.push({
        id: `step-${trace.steps.length}`,
        tool: step.tool,
        input: step.input,
        output: step.output,
        latency: step.latency,
        tokens: step.tokens || 0,
        timestamp: new Date().toISOString(),
        success: step.success !== false
      });
      
      // Update metrics
      trace.metrics.totalTokens += step.tokens || 0;
      trace.metrics.totalLatency += step.latency || 0;
      trace.metrics.toolCalls++;
      
      return this;
    },
    
    // Record outcome
    logOutcome(outcome) {
      trace.outcome = {
        success: outcome.success,
        result: outcome.result,
        error: outcome.error,
        timestamp: new Date().toISOString()
      };
      trace.completedAt = new Date().toISOString();
      
      // Calculate duration
      const start = new Date(trace.startedAt).getTime();
      const end = new Date(trace.completedAt).getTime();
      trace.duration = end - start;
      
      // Save trace
      this.save();
      
      return this;
    },
    
    // Record user feedback
    logFeedback(feedback) {
      trace.feedback = {
        rating: feedback.rating, // 1-5 or 👍/👎
        comment: feedback.comment,
        timestamp: new Date().toISOString()
      };
      this.save();
      return this;
    },
    
    // Save trace to disk
    save() {
      const filePath = path.join(TRACE_DIR, `${trace.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(trace, null, 2));
      return this;
    }
  };
}

/**
 * Load traces for analysis
 * @param {Object} filters
 * @returns {Array} Matching traces
 */
function loadTraces(filters = {}) {
  const files = fs.readdirSync(TRACE_DIR).filter(f => f.endsWith('.json'));
  const traces = [];
  
  for (const file of files) {
    try {
      const trace = JSON.parse(fs.readFileSync(path.join(TRACE_DIR, file), 'utf8'));
      
      // Apply filters
      if (filters.level && trace.routing?.level !== filters.level) continue;
      if (filters.success !== undefined && trace.outcome?.success !== filters.success) continue;
      if (filters.since && new Date(trace.startedAt) < new Date(filters.since)) continue;
      
      traces.push(trace);
    } catch (e) {
      // Skip corrupted traces
    }
  }
  
  return traces.sort((a, b) => 
    new Date(b.startedAt) - new Date(a.startedAt)
  );
}

/**
 * Analyze traces for improvement opportunities
 * @returns {Object} Analysis results
 */
function analyzeTraces() {
  const traces = loadTraces();
  
  const analysis = {
    total: traces.length,
    byLevel: {},
    byOutcome: { success: 0, failure: 0 },
    avgDuration: 0,
    avgTokens: 0,
    commonFailures: [],
    feedback: { positive: 0, negative: 0 }
  };
  
  let totalDuration = 0;
  let totalTokens = 0;
  const failurePatterns = {};
  
  for (const trace of traces) {
    // By level
    const level = trace.routing?.level || 'unknown';
    analysis.byLevel[level] = (analysis.byLevel[level] || 0) + 1;
    
    // By outcome
    if (trace.outcome?.success) {
      analysis.byOutcome.success++;
    } else {
      analysis.byOutcome.failure++;
      
      // Track failure patterns
      const error = trace.outcome?.error || 'unknown';
      failurePatterns[error] = (failurePatterns[error] || 0) + 1;
    }
    
    // Metrics
    totalDuration += trace.duration || 0;
    totalTokens += trace.metrics?.totalTokens || 0;
    
    // Feedback
    if (trace.feedback) {
      if (trace.feedback.rating === '👍' || trace.feedback.rating >= 4) {
        analysis.feedback.positive++;
      } else {
        analysis.feedback.negative++;
      }
    }
  }
  
  analysis.avgDuration = totalDuration / traces.length;
  analysis.avgTokens = totalTokens / traces.length;
  
  // Top failure patterns
  analysis.commonFailures = Object.entries(failurePatterns)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([error, count]) => ({ error, count }));
  
  return analysis;
}

/**
 * Generate improvement recommendations based on traces
 * @returns {Array} Recommendations
 */
function generateRecommendations() {
  const analysis = analyzeTraces();
  const recommendations = [];
  
  // Check for routing inefficiencies
  const agentCount = analysis.byLevel.agent || 0;
  const total = analysis.total;
  const agentRatio = agentCount / total;
  
  if (agentRatio > 0.7) {
    recommendations.push({
      type: 'routing',
      issue: 'High agent usage',
      detail: `${(agentRatio * 100).toFixed(0)}% of requests use full agent mode`,
      action: 'Review RAG and Workflow patterns to catch more requests at lower levels'
    });
  }
  
  // Check for common failures
  for (const failure of analysis.commonFailures) {
    recommendations.push({
      type: 'failure',
      issue: failure.error,
      detail: `Occurred ${failure.count} times`,
      action: 'Add error handling or retry logic for this failure mode'
    });
  }
  
  // Check for negative feedback patterns
  if (analysis.feedback.negative > analysis.feedback.positive) {
    recommendations.push({
      type: 'quality',
      issue: 'Negative feedback trend',
      detail: `${analysis.feedback.negative} negative vs ${analysis.feedback.positive} positive`,
      action: 'Review recent failures and adjust prompts or routing'
    });
  }
  
  return recommendations;
}

module.exports = {
  createTrace,
  loadTraces,
  analyzeTraces,
  generateRecommendations,
  TRACE_DIR
};

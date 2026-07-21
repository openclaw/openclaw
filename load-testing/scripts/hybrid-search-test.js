/**
 * Mythos Hybrid Search Load Test
 * 
 * Load testing for combined vector + text search
 * Tests: BM25 + cosine similarity fusion, result merging, ranking
 * 
 * Usage:
 *   k6 run hybrid-search-test.js
 *   k6 run --vus 75 --duration 15m hybrid-search-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// Custom metrics
const hybridSearchDuration = new Trend('hybrid_search_duration', true);
const hybridSearchErrors = new Rate('hybrid_search_errors');
const hybridSearchRequests = new Counter('hybrid_search_requests');

// Configuration
const MYTHOS_URL = __ENV.MYTHOS_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = __ENV.GATEWAY_TOKEN || 'test-token';

// Load test configuration
export const options = {
  scenarios: {
    // Steady state load
    steady_state: {
      executor: 'constant-vus',
      vus: 50,
      duration: '10m',
      gracefulStop: '10s',
    },
    // Spike test for fusion performance
    spike_fusion: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '1m', target: 75 },
        { duration: '3m', target: 75 },
        { duration: '1m', target: 10 },
      ],
      startTime: '11m', // Run after steady state
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    'hybrid_search_duration': [
      'p(50)<150',  // 50% < 150ms (fusion adds overhead)
      'p(90)<300',  // 90% < 300ms
      'p(95)<500',  // 95% < 500ms
      'p(99)<1000', // 99% < 1s
    ],
    'hybrid_search_errors': ['rate<0.01'],
  },
};

// Test queries optimized for hybrid search
const hybridQueries = [
  {
    query: 'implement OAuth2 authentication in Node.js',
    vector_weight: 0.7,
    text_weight: 0.3,
  },
  {
    query: 'database query optimization techniques',
    vector_weight: 0.6,
    text_weight: 0.4,
  },
  {
    query: 'REST API best practices security',
    vector_weight: 0.7,
    text_weight: 0.3,
  },
  {
    query: 'microservices architecture patterns',
    vector_weight: 0.8,
    text_weight: 0.2,
  },
  {
    query: 'error handling strategies production',
    vector_weight: 0.6,
    text_weight: 0.4,
  },
  {
    query: 'performance monitoring metrics dashboard',
    vector_weight: 0.7,
    text_weight: 0.3,
  },
  {
    query: 'caching strategies Redis Memcached',
    vector_weight: 0.7,
    text_weight: 0.3,
  },
  {
    query: 'container orchestration Kubernetes deployment',
    vector_weight: 0.8,
    text_weight: 0.2,
  },
  {
    query: 'GraphQL schema design queries mutations',
    vector_weight: 0.7,
    text_weight: 0.3,
  },
  {
    query: 'machine learning model deployment pipeline',
    vector_weight: 0.7,
    text_weight: 0.3,
  },
];

// Test function
export default function () {
  // Select query with pre-configured weights
  const queryConfig = randomItem(hybridQueries);
  
  // Add some randomization to weights
  const vectorWeight = Math.max(0.5, Math.min(0.9, queryConfig.vector_weight + (Math.random() - 0.5) * 0.2));
  const textWeight = 1 - vectorWeight;
  
  const limit = randomIntBetween(10, 30);
  const minScore = randomIntBetween(50, 80) / 100;

  group('Hybrid Search', function () {
    const payload = JSON.stringify({
      query: queryConfig.query,
      limit: limit,
      min_score: minScore,
      vector_weight: vectorWeight,
      text_weight: textWeight,
      fusion_method: 'weighted_sum', // or 'rrf' for reciprocal rank fusion
    });

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    };

    const startTime = new Date();
    const res = http.post(
      `${MYTHOS_URL}/api/v1/memory/search/hybrid`,
      payload,
      { headers, tags: { name: 'hybrid_search' } }
    );
    const duration = new Date() - startTime;

    // Record metrics
    hybridSearchDuration.add(duration);
    hybridSearchRequests.add(1);

    // Validate response
    const success = check(res, {
      'status is 200': (r) => r.status === 200,
      'response has results': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.results) && body.results.length > 0;
        } catch (e) {
          return false;
        }
      },
      'results have hybrid scores': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.results.every(result => 
            result.hybrid_score !== undefined &&
            result.vector_score !== undefined &&
            result.text_score !== undefined
          );
        } catch (e) {
          return false;
        }
      },
      'response time < 1s': () => duration < 1000,
    });

    hybridSearchErrors.add(!success);

    if (!success) {
      console.error(`Hybrid search failed: status=${res.status}, query="${queryConfig.query}"`);
      console.error(`Weights: vector=${vectorWeight.toFixed(2)}, text=${textWeight.toFixed(2)}`);
    }
  });

  // Think time
  sleep(randomIntBetween(1, 3));
}

// Setup
export function setup() {
  const healthCheck = http.get(`${MYTHOS_URL}/health`);
  check(healthCheck, {
    'Mythos is healthy': (r) => r.status === 200,
  });

  if (healthCheck.status !== 200) {
    throw new Error('Mythos health check failed');
  }
}

// Summary
export function handleSummary(data) {
  const metrics = data.metrics;
  
  let output = '\n=== Mythos Hybrid Search Load Test Results ===\n\n';
  
  output += 'Performance:\n';
  output += `  Requests: ${metrics.hybrid_search_requests?.values.count || 0}\n`;
  output += `  Errors: ${(metrics.hybrid_search_errors?.values.rate * 100).toFixed(2)}%\n`;
  output += `  Avg Duration: ${metrics.hybrid_search_duration?.values.avg.toFixed(2)}ms\n`;
  output += `  P50: ${metrics.hybrid_search_duration?.values['p(50)'].toFixed(2)}ms\n`;
  output += `  P90: ${metrics.hybrid_search_duration?.values['p(90)'].toFixed(2)}ms\n`;
  output += `  P95: ${metrics.hybrid_search_duration?.values['p(95)'].toFixed(2)}ms\n`;
  output += `  P99: ${metrics.hybrid_search_duration?.values['p(99)'].toFixed(2)}ms\n`;
  
  output += '\nNote: Hybrid search includes overhead from:\n';
  output += '  - Vector search execution\n';
  output += '  - Text search execution\n';
  output += '  - Score fusion and ranking\n';
  
  output += '\n==============================================\n';
  
  return {
    'stdout': output,
    'hybrid-search-summary.json': JSON.stringify(data, null, 2),
  };
}

/**
 * Mythos Text Search Load Test
 * 
 * Load testing for full-text search with Tantivy
 * Tests: BM25 ranking, tokenization, filtering performance
 * 
 * Usage:
 *   k6 run text-search-test.js
 *   k6 run --vus 100 --duration 10m text-search-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// Custom metrics
const textSearchDuration = new Trend('text_search_duration', true);
const textSearchErrors = new Rate('text_search_errors');
const textSearchRequests = new Counter('text_search_requests');

// Configuration
const MYTHOS_URL = __ENV.MYTHOS_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = __ENV.GATEWAY_TOKEN || 'test-token';

// Load test configuration
export const options = {
  scenarios: {
    // Ramp up test
    ramp_up: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 20 },
        { duration: '5m', target: 50 },
        { duration: '3m', target: 100 },
        { duration: '2m', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    'text_search_duration': [
      'p(50)<50',   // 50% < 50ms
      'p(90)<100',  // 90% < 100ms
      'p(95)<200',  // 95% < 200ms
      'p(99)<500',  // 99% < 500ms
    ],
    'text_search_errors': ['rate<0.01'],
    'http_req_duration': ['p(95)<500'],
  },
};

// Test queries with varying complexity
const simpleQueries = [
  'authentication',
  'database',
  'performance',
  'security',
  'monitoring',
];

const complexQueries = [
  'user authentication OAuth2 JWT',
  'database connection pool optimization',
  'API rate limiting best practices',
  'memory leak detection strategies',
  'distributed tracing implementation',
  'circuit breaker pattern microservices',
  'event sourcing CQRS architecture',
  'GraphQL subscription WebSocket',
  'container orchestration Kubernetes',
  'infrastructure as code Terraform',
];

const phraseQueries = [
  '"error handling" best practices',
  '"performance optimization" techniques',
  '"security vulnerability" assessment',
  '"code review" guidelines',
  '"deployment strategy" planning',
];

// Test function
export default function () {
  // Randomly select query type
  const queryType = randomItem(['simple', 'complex', 'phrase']);
  let query;
  
  switch (queryType) {
    case 'simple':
      query = randomItem(simpleQueries);
      break;
    case 'complex':
      query = randomItem(complexQueries);
      break;
    case 'phrase':
      query = randomItem(phraseQueries);
      break;
  }

  // Random parameters
  const limit = randomIntBetween(10, 50);
  const offset = randomIntBetween(0, 100);
  const highlight = Math.random() > 0.5;
  const includeMetadata = Math.random() > 0.3;

  group('Text Search', function () {
    const payload = JSON.stringify({
      query: query,
      limit: limit,
      offset: offset,
      highlight: highlight,
      include_metadata: includeMetadata,
    });

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    };

    const startTime = new Date();
    const res = http.post(
      `${MYTHOS_URL}/api/v1/memory/search/text`,
      payload,
      { headers, tags: { name: 'text_search' } }
    );
    const duration = new Date() - startTime;

    // Record metrics
    textSearchDuration.add(duration);
    textSearchRequests.add(1);

    // Validate response
    const success = check(res, {
      'status is 200': (r) => r.status === 200,
      'response has results': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.results);
        } catch (e) {
          return false;
        }
      },
      'response time < 500ms': () => duration < 500,
    });

    textSearchErrors.add(!success);

    if (!success) {
      console.error(`Text search failed: status=${res.status}, query="${query}"`);
    }
  });

  // Think time
  sleep(randomIntBetween(1, 2));
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

// Summary report
export function handleSummary(data) {
  const metrics = data.metrics;
  
  return {
    'stdout': textSummary(data),
    'text-search-summary.json': JSON.stringify(data, null, 2),
  };
}

function textSummary(data) {
  const metrics = data.metrics;
  
  let output = '\n=== Mythos Text Search Load Test Results ===\n\n';
  
  output += 'Performance:\n';
  output += `  Requests: ${metrics.text_search_requests?.values.count || 0}\n`;
  output += `  Errors: ${(metrics.text_search_errors?.values.rate * 100).toFixed(2)}%\n`;
  output += `  Avg Duration: ${metrics.text_search_duration?.values.avg.toFixed(2)}ms\n`;
  output += `  P50: ${metrics.text_search_duration?.values['p(50)'].toFixed(2)}ms\n`;
  output += `  P90: ${metrics.text_search_duration?.values['p(90)'].toFixed(2)}ms\n`;
  output += `  P95: ${metrics.text_search_duration?.values['p(95)'].toFixed(2)}ms\n`;
  output += `  P99: ${metrics.text_search_duration?.values['p(99)'].toFixed(2)}ms\n`;
  
  output += '\n===========================================\n';
  
  return output;
}

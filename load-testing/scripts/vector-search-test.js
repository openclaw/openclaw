/**
 * Mythos Vector Search Load Test
 * 
 * Comprehensive load testing for vector search performance
 * Tests: latency, throughput, error rates under various loads
 * 
 * Usage:
 *   k6 run vector-search-test.js
 *   k6 run --vus 50 --duration 5m vector-search-test.js
 *   k6 run --env MYTHOS_URL=http://localhost:18789 vector-search-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// Custom metrics
const vectorSearchDuration = new Trend('vector_search_duration', true);
const vectorSearchErrors = new Rate('vector_search_errors');
const vectorSearchRequests = new Counter('vector_search_requests');

// Configuration
const MYTHOS_URL = __ENV.MYTHOS_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = __ENV.GATEWAY_TOKEN || 'test-token';

// Load test stages
export const options = {
  scenarios: {
    // Warm-up phase
    warmup: {
      executor: 'constant-vus',
      vus: 5,
      duration: '30s',
      gracefulStop: '5s',
    },
    // Ramp up to moderate load
    moderate_load: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '1m', target: 20 },
        { duration: '3m', target: 20 },
        { duration: '1m', target: 5 },
      ],
      gracefulRampDown: '10s',
    },
    // Heavy load test
    heavy_load: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '5m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
    // Spike test
    spike: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 10 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Performance thresholds
    'vector_search_duration': [
      'p(50)<100',  // 50% of requests < 100ms
      'p(90)<200',  // 90% of requests < 200ms
      'p(95)<500',  // 95% of requests < 500ms
      'p(99)<1000', // 99% of requests < 1s
    ],
    'vector_search_errors': ['rate<0.01'], // Error rate < 1%
    'http_req_duration': ['p(95)<1000'],    // Overall HTTP duration
    'http_req_failed': ['rate<0.01'],       // HTTP failure rate
  },
};

// Sample query vectors (384 dimensions for all-MiniLM-L6-v2)
const sampleQueries = [
  'user interface preferences',
  'API documentation authentication',
  'database performance optimization',
  'security best practices',
  'code review guidelines',
  'deployment strategies',
  'monitoring and alerting',
  'testing methodologies',
  'architecture patterns',
  'error handling approaches',
];

// Setup function - run once per VU
export function setup() {
  // Verify Mythos is accessible
  const healthCheck = http.get(`${MYTHOS_URL}/health`);
  check(healthCheck, {
    'Mythos is healthy': (r) => r.status === 200,
  });

  if (healthCheck.status !== 200) {
    throw new Error(`Mythos health check failed: ${healthCheck.status}`);
  }

  return {
    startTime: new Date().toISOString(),
    mythosUrl: MYTHOS_URL,
  };
}

// Main test function
export default function (data) {
  // Random query selection for realistic load
  const query = sampleQueries[randomIntBetween(0, sampleQueries.length - 1)];
  const topK = randomIntBetween(5, 20);
  const minSimilarity = (randomIntBetween(50, 90) / 100).toFixed(2);

  // Vector search request
  group('Vector Search', function () {
    const payload = JSON.stringify({
      query: query,
      top_k: topK,
      min_similarity: minSimilarity,
      include_metadata: true,
    });

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    };

    const startTime = new Date();
    const res = http.post(
      `${MYTHOS_URL}/api/v1/memory/search/vector`,
      payload,
      { headers, tags: { name: 'vector_search' } }
    );
    const duration = new Date() - startTime;

    // Record custom metrics
    vectorSearchDuration.add(duration);
    vectorSearchRequests.add(1);

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
      'response time < 1s': () => duration < 1000,
    });

    vectorSearchErrors.add(!success);

    // Log failed requests for debugging
    if (!success) {
      console.error(`Vector search failed: status=${res.status}, duration=${duration}ms`);
      console.error(`Query: ${query}`);
    }
  });

  // Think time between requests
  sleep(randomIntBetween(1, 3));
}

// Teardown function - run once after test
export function teardown(data) {
  console.log(`\n=== Test Summary ===`);
  console.log(`Start time: ${data.startTime}`);
  console.log(`End time: ${new Date().toISOString()}`);
  console.log(`Mythos URL: ${data.mythosUrl}`);
  console.log(`===================\n`);
}

// Handle test iterations
export function handleSummary(data) {
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
    'summary.json': JSON.stringify(data, null, 2),
    'summary.html': htmlReport(data),
  };
}

// Text summary formatter
function textSummary(data, options = {}) {
  const metrics = data.metrics;
  const indent = options.indent || '  ';
  
  let output = '\n=== Mythos Vector Search Load Test Results ===\n\n';
  
  // Vector search metrics
  output += 'Vector Search Performance:\n';
  output += `${indent}Requests: ${metrics.vector_search_requests?.values.count || 0}\n`;
  output += `${indent}Errors: ${(metrics.vector_search_errors?.values.rate * 100).toFixed(2)}%\n`;
  output += `${indent}Avg Duration: ${metrics.vector_search_duration?.values.avg.toFixed(2)}ms\n`;
  output += `${indent}P50 Duration: ${metrics.vector_search_duration?.values['p(50)'].toFixed(2)}ms\n`;
  output += `${indent}P90 Duration: ${metrics.vector_search_duration?.values['p(90)'].toFixed(2)}ms\n`;
  output += `${indent}P95 Duration: ${metrics.vector_search_duration?.values['p(95)'].toFixed(2)}ms\n`;
  output += `${indent}P99 Duration: ${metrics.vector_search_duration?.values['p(99)'].toFixed(2)}ms\n`;
  
  // HTTP metrics
  output += '\nHTTP Performance:\n';
  output += `${indent}Requests: ${metrics.http_reqs?.values.count || 0}\n`;
  output += `${indent}Failed: ${(metrics.http_req_failed?.values.rate * 100).toFixed(2)}%\n`;
  output += `${indent}Avg Duration: ${metrics.http_req_duration?.values.avg.toFixed(2)}ms\n`;
  output += `${indent}P95 Duration: ${metrics.http_req_duration?.values['p(95)'].toFixed(2)}ms\n`;
  
  // Iterations
  output += '\nTest Execution:\n';
  output += `${indent}Iterations: ${metrics.iterations?.values.count || 0}\n`;
  output += `${indent}Duration: ${metrics.iterations?.values.duration.toFixed(2)}s\n`;
  
  output += '\n==============================================\n';
  
  return output;
}

// HTML report generator
function htmlReport(data) {
  const metrics = data.metrics;
  
  return `
<!DOCTYPE html>
<html>
<head>
  <title>Mythos Vector Search Load Test Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h1 { color: #ff6600; border-bottom: 3px solid #ff6600; padding-bottom: 10px; }
    h2 { color: #333; margin-top: 30px; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin: 20px 0; }
    .metric-card { background: #f9f9f9; padding: 20px; border-radius: 6px; border-left: 4px solid #ff6600; }
    .metric-label { font-size: 14px; color: #666; margin-bottom: 5px; }
    .metric-value { font-size: 24px; font-weight: bold; color: #333; }
    .metric-unit { font-size: 14px; color: #999; }
    table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #f5f5f5; font-weight: bold; }
    .success { color: #28a745; }
    .warning { color: #ffc107; }
    .error { color: #dc3545; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🦞 Mythos Vector Search Load Test Report</h1>
    
    <h2>📊 Test Summary</h2>
    <div class="metric-grid">
      <div class="metric-card">
        <div class="metric-label">Total Requests</div>
        <div class="metric-value">${metrics.vector_search_requests?.values.count || 0}</div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Error Rate</div>
        <div class="metric-value ${(metrics.vector_search_errors?.values.rate * 100) < 1 ? 'success' : 'error'}">
          ${(metrics.vector_search_errors?.values.rate * 100).toFixed(2)}%
        </div>
      </div>
      <div class="metric-card">
        <div class="metric-label">Avg Duration</div>
        <div class="metric-value">${metrics.vector_search_duration?.values.avg.toFixed(2)}<span class="metric-unit">ms</span></div>
      </div>
      <div class="metric-card">
        <div class="metric-label">P95 Duration</div>
        <div class="metric-value">${metrics.vector_search_duration?.values['p(95)'].toFixed(2)}<span class="metric-unit">ms</span></div>
      </div>
    </div>
    
    <h2>📈 Performance Percentiles</h2>
    <table>
      <thead>
        <tr>
          <th>Percentile</th>
          <th>Duration (ms)</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>P50 (Median)</td>
          <td>${metrics.vector_search_duration?.values['p(50)'].toFixed(2)}</td>
          <td class="${metrics.vector_search_duration?.values['p(50)'] < 100 ? 'success' : 'warning'}">
            ${metrics.vector_search_duration?.values['p(50)'] < 100 ? '✓ Excellent' : '⚠ Needs optimization'}
          </td>
        </tr>
        <tr>
          <td>P90</td>
          <td>${metrics.vector_search_duration?.values['p(90)'].toFixed(2)}</td>
          <td class="${metrics.vector_search_duration?.values['p(90)'] < 200 ? 'success' : 'warning'}">
            ${metrics.vector_search_duration?.values['p(90)'] < 200 ? '✓ Good' : '⚠ Acceptable'}
          </td>
        </tr>
        <tr>
          <td>P95</td>
          <td>${metrics.vector_search_duration?.values['p(95)'].toFixed(2)}</td>
          <td class="${metrics.vector_search_duration?.values['p(95)'] < 500 ? 'success' : 'error'}">
            ${metrics.vector_search_duration?.values['p(95)'] < 500 ? '✓ Acceptable' : '✗ Too slow'}
          </td>
        </tr>
        <tr>
          <td>P99</td>
          <td>${metrics.vector_search_duration?.values['p(99)'].toFixed(2)}</td>
          <td class="${metrics.vector_search_duration?.values['p(99)'] < 1000 ? 'success' : 'error'}">
            ${metrics.vector_search_duration?.values['p(99)'] < 1000 ? '✓ Acceptable' : '✗ Critical'}
          </td>
        </tr>
      </tbody>
    </table>
    
    <h2>🔍 HTTP Metrics</h2>
    <table>
      <thead>
        <tr>
          <th>Metric</th>
          <th>Value</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Total HTTP Requests</td>
          <td>${metrics.http_reqs?.values.count || 0}</td>
        </tr>
        <tr>
          <td>Failed Requests</td>
          <td class="${metrics.http_req_failed?.values.rate < 0.01 ? 'success' : 'error'}">
            ${(metrics.http_req_failed?.values.rate * 100).toFixed(2)}%
          </td>
        </tr>
        <tr>
          <td>Avg HTTP Duration</td>
          <td>${metrics.http_req_duration?.values.avg.toFixed(2)}ms</td>
        </tr>
        <tr>
          <td>Test Duration</td>
          <td>${(metrics.iterations?.values.duration / 1000).toFixed(2)}s</td>
        </tr>
      </tbody>
    </table>
    
    <h2>✅ Threshold Results</h2>
    <table>
      <thead>
        <tr>
          <th>Threshold</th>
          <th>Expected</th>
          <th>Actual</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>P50 < 100ms</td>
          <td>&lt; 100ms</td>
          <td>${metrics.vector_search_duration?.values['p(50)'].toFixed(2)}ms</td>
          <td class="${metrics.vector_search_duration?.values['p(50)'] < 100 ? 'success' : 'error'}">
            ${metrics.vector_search_duration?.values['p(50)'] < 100 ? '✓ Pass' : '✗ Fail'}
          </td>
        </tr>
        <tr>
          <td>P90 < 200ms</td>
          <td>&lt; 200ms</td>
          <td>${metrics.vector_search_duration?.values['p(90)'].toFixed(2)}ms</td>
          <td class="${metrics.vector_search_duration?.values['p(90)'] < 200 ? 'success' : 'error'}">
            ${metrics.vector_search_duration?.values['p(90)'] < 200 ? '✓ Pass' : '✗ Fail'}
          </td>
        </tr>
        <tr>
          <td>P95 < 500ms</td>
          <td>&lt; 500ms</td>
          <td>${metrics.vector_search_duration?.values['p(95)'].toFixed(2)}ms</td>
          <td class="${metrics.vector_search_duration?.values['p(95)'] < 500 ? 'success' : 'error'}">
            ${metrics.vector_search_duration?.values['p(95)'] < 500 ? '✓ Pass' : '✗ Fail'}
          </td>
        </tr>
        <tr>
          <td>P99 < 1000ms</td>
          <td>&lt; 1000ms</td>
          <td>${metrics.vector_search_duration?.values['p(99)'].toFixed(2)}ms</td>
          <td class="${metrics.vector_search_duration?.values['p(99)'] < 1000 ? 'success' : 'error'}">
            ${metrics.vector_search_duration?.values['p(99)'] < 1000 ? '✓ Pass' : '✗ Fail'}
          </td>
        </tr>
        <tr>
          <td>Error Rate < 1%</td>
          <td>&lt; 1%</td>
          <td>${(metrics.vector_search_errors?.values.rate * 100).toFixed(2)}%</td>
          <td class="${metrics.vector_search_errors?.values.rate < 0.01 ? 'success' : 'error'}">
            ${metrics.vector_search_errors?.values.rate < 0.01 ? '✓ Pass' : '✗ Fail'}
          </td>
        </tr>
      </tbody>
    </table>
    
    <div style="margin-top: 40px; padding: 20px; background: #f0f0f0; border-radius: 6px;">
      <p><strong>Generated:</strong> ${new Date().toISOString()}</p>
      <p><strong>Test Framework:</strong> k6 v1.0.0</p>
      <p><strong>Mythos Version:</strong> 2026.5.10</p>
    </div>
  </div>
</body>
</html>
  `;
}

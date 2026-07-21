/**
 * Mythos Mixed Workload Load Test
 * 
 * Realistic load testing simulating production usage patterns
 * Mixes: vector search, text search, hybrid search, agent delegation
 * 
 * Usage:
 *   k6 run mixed-workload-test.js
 *   k6 run --vus 100 --duration 30m mixed-workload-test.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';
import { randomIntBetween, randomItem } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';

// Custom metrics per operation type
const vectorSearchDuration = new Trend('vector_search_duration', true);
const vectorSearchRequests = new Counter('vector_search_requests');
const vectorSearchErrors = new Rate('vector_search_errors');

const textSearchDuration = new Trend('text_search_duration', true);
const textSearchRequests = new Counter('text_search_requests');
const textSearchErrors = new Rate('text_search_errors');

const hybridSearchDuration = new Trend('hybrid_search_duration', true);
const hybridSearchRequests = new Counter('hybrid_search_requests');
const hybridSearchErrors = new Rate('hybrid_search_errors');

const agentDelegationDuration = new Trend('agent_delegation_duration', true);
const agentDelegationRequests = new Counter('agent_delegation_requests');
const agentDelegationErrors = new Rate('agent_delegation_errors');

// Configuration
const MYTHOS_URL = __ENV.MYTHOS_URL || 'http://localhost:18789';
const GATEWAY_TOKEN = __ENV.GATEWAY_TOKEN || 'test-token';

// Workload distribution (should sum to 1.0)
const WORKLOAD_MIX = {
  vector: 0.40,      // 40% vector search
  text: 0.25,        // 25% text search
  hybrid: 0.20,      // 20% hybrid search
  delegation: 0.15,  // 15% agent delegation
};

// Load test configuration
export const options = {
  scenarios: {
    // Realistic user simulation
    realistic_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '2m', target: 20 },    // Morning ramp-up
        { duration: '5m', target: 50 },    // Mid-morning peak
        { duration: '3m', target: 40 },    // Lunch dip
        { duration: '5m', target: 75 },    // Afternoon peak
        { duration: '3m', target: 60 },    // Late afternoon
        { duration: '2m', target: 20 },    // Evening wind-down
        { duration: '1m', target: 0 },     // End of day
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // Vector search thresholds
    'vector_search_duration': [
      'p(50)<100',
      'p(90)<200',
      'p(95)<500',
    ],
    'vector_search_errors': ['rate<0.01'],
    
    // Text search thresholds
    'text_search_duration': [
      'p(50)<50',
      'p(90)<100',
      'p(95)<200',
    ],
    'text_search_errors': ['rate<0.01'],
    
    // Hybrid search thresholds
    'hybrid_search_duration': [
      'p(50)<150',
      'p(90)<300',
      'p(95)<500',
    ],
    'hybrid_search_errors': ['rate<0.01'],
    
    // Agent delegation thresholds
    'agent_delegation_duration': [
      'p(50)<500',
      'p(90)<1000',
      'p(95)<2000',
    ],
    'agent_delegation_errors': ['rate<0.02'],
    
    // Overall HTTP metrics
    'http_req_duration': ['p(95)<1000'],
    'http_req_failed': ['rate<0.01'],
  },
};

// Query pools for different operation types
const vectorQueries = [
  'user interface preferences',
  'authentication implementation',
  'performance optimization',
  'security best practices',
  'database optimization',
];

const textQueries = [
  'API documentation',
  'error handling',
  'deployment strategies',
  'testing guidelines',
  'monitoring setup',
];

const hybridQueries = [
  'implement OAuth2 in Node.js',
  'database query optimization techniques',
  'REST API security best practices',
];

const agentTasks = [
  'Analyze code for security vulnerabilities',
  'Review database schema for optimization opportunities',
  'Generate unit tests for authentication module',
  'Refactor error handling in API endpoints',
  'Optimize database queries for performance',
];

// Select operation based on workload distribution
function selectOperation() {
  const rand = Math.random();
  let cumulative = 0;
  
  for (const [operation, weight] of Object.entries(WORKLOAD_MIX)) {
    cumulative += weight;
    if (rand < cumulative) {
      return operation;
    }
  }
  
  return 'vector'; // fallback
}

// Operation handlers
function executeVectorSearch() {
  group('Vector Search', function () {
    const query = randomItem(vectorQueries);
    const topK = randomIntBetween(5, 20);
    
    const payload = JSON.stringify({
      query: query,
      top_k: topK,
      min_similarity: 0.7,
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

    vectorSearchDuration.add(duration);
    vectorSearchRequests.add(1);

    const success = check(res, {
      'vector: status 200': (r) => r.status === 200,
      'vector: has results': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.results);
        } catch (e) {
          return false;
        }
      },
    });

    vectorSearchErrors.add(!success);
  });
}

function executeTextSearch() {
  group('Text Search', function () {
    const query = randomItem(textQueries);
    const limit = randomIntBetween(10, 30);
    
    const payload = JSON.stringify({
      query: query,
      limit: limit,
      highlight: true,
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

    textSearchDuration.add(duration);
    textSearchRequests.add(1);

    const success = check(res, {
      'text: status 200': (r) => r.status === 200,
      'text: has results': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.results);
        } catch (e) {
          return false;
        }
      },
    });

    textSearchErrors.add(!success);
  });
}

function executeHybridSearch() {
  group('Hybrid Search', function () {
    const queryConfig = randomItem(hybridQueries);
    
    const payload = JSON.stringify({
      query: queryConfig,
      limit: 20,
      vector_weight: 0.7,
      text_weight: 0.3,
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

    hybridSearchDuration.add(duration);
    hybridSearchRequests.add(1);

    const success = check(res, {
      'hybrid: status 200': (r) => r.status === 200,
      'hybrid: has results': (r) => {
        try {
          const body = JSON.parse(r.body);
          return Array.isArray(body.results);
        } catch (e) {
          return false;
        }
      },
    });

    hybridSearchErrors.add(!success);
  });
}

function executeAgentDelegation() {
  group('Agent Delegation', function () {
    const task = randomItem(agentTasks);
    const agent = randomItem(['CODE', 'RESEARCH', 'OPS']);
    
    const payload = JSON.stringify({
      task: task,
      agent: agent,
      timeout: 5000,
    });

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GATEWAY_TOKEN}`,
    };

    const startTime = new Date();
    const res = http.post(
      `${MYTHOS_URL}/api/v1/agents/delegate`,
      payload,
      { headers, tags: { name: 'agent_delegation' } }
    );
    const duration = new Date() - startTime;

    agentDelegationDuration.add(duration);
    agentDelegationRequests.add(1);

    const success = check(res, {
      'delegation: status 200': (r) => r.status === 200,
      'delegation: has result': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.result !== undefined;
        } catch (e) {
          return false;
        }
      },
    });

    agentDelegationErrors.add(!success);
  });
}

// Main test function
export default function () {
  const operation = selectOperation();
  
  switch (operation) {
    case 'vector':
      executeVectorSearch();
      break;
    case 'text':
      executeTextSearch();
      break;
    case 'hybrid':
      executeHybridSearch();
      break;
    case 'delegation':
      executeAgentDelegation();
      break;
  }
  
  // Variable think time
  sleep(randomIntBetween(1, 5));
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
  
  return {
    startTime: new Date().toISOString(),
    workloadMix: WORKLOAD_MIX,
  };
}

// Comprehensive summary
export function handleSummary(data) {
  const metrics = data.metrics;
  
  let output = '\n=== Mythos Mixed Workload Load Test Results ===\n\n';
  
  output += 'Workload Distribution:\n';
  output += `  Vector Search: ${(WORKLOAD_MIX.vector * 100).toFixed(0)}%\n`;
  output += `  Text Search: ${(WORKLOAD_MIX.text * 100).toFixed(0)}%\n`;
  output += `  Hybrid Search: ${(WORKLOAD_MIX.hybrid * 100).toFixed(0)}%\n`;
  output += `  Agent Delegation: ${(WORKLOAD_MIX.delegation * 100).toFixed(0)}%\n`;
  
  output += '\nVector Search:\n';
  output += `  Requests: ${metrics.vector_search_requests?.values.count || 0}\n`;
  output += `  Errors: ${(metrics.vector_search_errors?.values.rate * 100).toFixed(2)}%\n`;
  output += `  Avg: ${metrics.vector_search_duration?.values.avg.toFixed(2)}ms\n`;
  output += `  P95: ${metrics.vector_search_duration?.values['p(95)'].toFixed(2)}ms\n`;
  
  output += '\nText Search:\n';
  output += `  Requests: ${metrics.text_search_requests?.values.count || 0}\n`;
  output += `  Errors: ${(metrics.text_search_errors?.values.rate * 100).toFixed(2)}%\n`;
  output += `  Avg: ${metrics.text_search_duration?.values.avg.toFixed(2)}ms\n`;
  output += `  P95: ${metrics.text_search_duration?.values['p(95)'].toFixed(2)}ms\n`;
  
  output += '\nHybrid Search:\n';
  output += `  Requests: ${metrics.hybrid_search_requests?.values.count || 0}\n`;
  output += `  Errors: ${(metrics.hybrid_search_errors?.values.rate * 100).toFixed(2)}%\n`;
  output += `  Avg: ${metrics.hybrid_search_duration?.values.avg.toFixed(2)}ms\n`;
  output += `  P95: ${metrics.hybrid_search_duration?.values['p(95)'].toFixed(2)}ms\n`;
  
  output += '\nAgent Delegation:\n';
  output += `  Requests: ${metrics.agent_delegation_requests?.values.count || 0}\n`;
  output += `  Errors: ${(metrics.agent_delegation_errors?.values.rate * 100).toFixed(2)}%\n`;
  output += `  Avg: ${metrics.agent_delegation_duration?.values.avg.toFixed(2)}ms\n`;
  output += `  P95: ${metrics.agent_delegation_duration?.values['p(95)'].toFixed(2)}ms\n`;
  
  output += '\n===============================================\n';
  
  return {
    'stdout': output,
    'mixed-workload-summary.json': JSON.stringify(data, null, 2),
  };
}

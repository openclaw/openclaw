# Mythos Examples - Practical Usage Guide

This guide provides practical examples of using Mythos-class features in real scenarios.

## Table of Contents
1. [Basic Memory Search](#basic-memory-search)
2. [Agent Delegation](#agent-delegation)
3. [Workflow Execution](#workflow-execution)
4. [Performance Comparison](#performance-comparison)
5. [Custom Agent Creation](#custom-agent-creation)
6. [Monitoring Setup](#monitoring-setup)

---

## Basic Memory Search

### Example 1: Semantic Vector Search

```typescript
import { Memory } from '@openclaw/mythos-core';

const memory = new Memory();

// Store a memory with rich metadata
await memory.store({
  type: 'conversation',
  content: 'User prefers dark mode and keyboard shortcuts',
  metadata: {
    user_id: 'user_123',
    session_id: 'session_456',
    timestamp: Date.now(),
    confidence: 0.95
  }
});

// Semantic search using native Rust engine (100x faster)
const results = await memory.search({
  query: 'user interface preferences',
  limit: 10,
  min_similarity: 0.7,
  filters: {
    user_id: 'user_123'
  }
});

console.log(results);
// Output: 
// [
//   {
//     id: 'mem_789',
//     content: 'User prefers dark mode and keyboard shortcuts',
//     similarity: 0.87,
//     metadata: { ... }
//   }
// ]
```

### Example 2: Full-Text Search with Filters

```typescript
import { Memory } from '@openclaw/mythos-core';

const memory = new Memory();

// Full-text search with advanced filters
const results = await memory.searchText({
  query: 'API documentation authentication',
  limit: 20,
  filters: {
    type: 'document',
    tags: ['api', 'auth'],
    date_range: {
      start: '2024-01-01',
      end: '2024-12-31'
    }
  },
  highlight: true
});

// Results include highlighted matches
console.log(results[0].highlights);
// Output: ['<mark>API</mark> <mark>documentation</mark> for <mark>authentication</mark>']
```

### Example 3: Hybrid Search (Vector + Text)

```typescript
import { Memory } from '@openclaw/mythos-core';

const memory = new Memory();

// Hybrid search combines semantic understanding with keyword matching
const results = await memory.searchHybrid({
  query: 'How to implement OAuth2 in Node.js',
  vector_weight: 0.7,  // 70% semantic, 30% keyword
  text_weight: 0.3,
  limit: 15,
  filters: {
    type: 'tutorial',
    language: 'javascript'
  }
});

// Returns best matches considering both meaning and keywords
console.log(results);
```

---

## Agent Delegation

### Example 4: Simple Task Delegation

```typescript
import { AgentDelegator } from '@openclaw/mythos-core';

const delegator = new AgentDelegator();

// Delegate a simple task
const result = await delegator.delegate({
  task: 'Analyze this error log and suggest fixes',
  context: {
    error_log: 'TypeError: Cannot read property "id" of undefined',
    file: 'src/users.ts',
    line: 42
  },
  agent: 'CODE',  // Use CODE agent
  timeout: 30000
});

console.log(result.output);
// Output: 'The error occurs because user object is null...'
```

### Example 5: Multi-Agent Collaboration

```typescript
import { AgentDelegator } from '@openclaw/mythos-core';

const delegator = new AgentDelegator();

// Create a collaboration workflow
const workflow = delegator.createWorkflow({
  name: 'feature-development',
  steps: [
    {
      agent: 'PRIME',
      task: 'Analyze requirements for user authentication feature',
      output_key: 'requirements'
    },
    {
      agent: 'RESEARCH',
      task: 'Research best practices for JWT authentication',
      input_keys: ['requirements'],
      output_key: 'research'
    },
    {
      agent: 'CODE',
      task: 'Implement authentication module based on research',
      input_keys: ['requirements', 'research'],
      output_key: 'code'
    },
    {
      agent: 'CRITIC',
      task: 'Review code for security vulnerabilities',
      input_keys: ['code'],
      output_key: 'review'
    }
  ]
});

// Execute workflow
const result = await workflow.execute({
  initial_context: {
    project: 'my-app',
    feature: 'user-authentication'
  }
});

console.log(result.steps);
// Output: Array of step results with outputs
```

### Example 6: Parallel Agent Execution

```typescript
import { AgentDelegator } from '@openclaw/mythos-core';

const delegator = new AgentDelegator();

// Execute multiple agents in parallel
const results = await Promise.all([
  delegator.delegate({
    task: 'Research React best practices',
    agent: 'RESEARCH'
  }),
  delegator.delegate({
    task: 'Research Vue best practices',
    agent: 'RESEARCH'
  }),
  delegator.delegate({
    task: 'Research Angular best practices',
    agent: 'RESEARCH'
  })
]);

// All three agents ran in parallel
console.log(`Completed ${results.length} research tasks`);
```

---

## Workflow Execution

### Example 7: GitHub Issue Triage

```typescript
import { WorkflowExecutor } from '@openclaw/mythos-core';

const executor = new WorkflowExecutor();

// Trigger GitHub issue triage workflow
const result = await executor.execute('github-triage', {
  issue_url: 'https://github.com/myorg/myrepo/issues/123',
  webhook_payload: {
    action: 'opened',
    issue: {
      title: 'Bug: Application crashes on startup',
      body: 'Steps to reproduce...',
      labels: ['bug']
    }
  }
});

console.log(result);
// Output:
// {
//   classification: 'bug',
//   priority: 'high',
//   assigned_to: 'code-team',
//   response_draft: 'Thank you for reporting...'
// }
```

### Example 8: Daily Intelligence Briefing

```typescript
import { WorkflowExecutor } from '@openclaw/mythos-core';
import { Scheduler } from '@openclaw/mythos-core';

const executor = new WorkflowExecutor();
const scheduler = new Scheduler();

// Schedule daily briefing
scheduler.addJob({
  name: 'daily-briefing',
  schedule: '0 8 * * *',  // Every day at 8 AM
  workflow: 'daily-brief',
  params: {
    topics: ['AI', 'technology', 'startups'],
    sources: ['hacker-news', 'reddit', 'arxiv'],
    output_format: 'markdown'
  },
  notify: ['slack:general', 'email:team@company.com']
});

// Or execute immediately
const briefing = await executor.execute('daily-brief', {
  topics: ['AI', 'technology'],
  output_format: 'email'
});

console.log(briefing.summary);
```

### Example 9: Incident Response

```typescript
import { WorkflowExecutor } from '@openclaw/mythos-core';

const executor = new WorkflowExecutor();

// Trigger incident response
const incident = await executor.execute('incident-response', {
  severity: 'high',
  description: 'Database connection pool exhausted',
  alerts: [
    {
      source: 'prometheus',
      metric: 'db_connection_pool_usage',
      value: 0.95,
      threshold: 0.80
    }
  ],
  affected_services: ['api-server', 'worker-service']
});

console.log(incident);
// Output:
// {
//   incident_id: 'inc_2024_001',
//   status: 'investigating',
//   assigned_agents: ['OPS', 'CODE'],
//   actions_taken: [
//     'Scaled database connection pool',
//     'Restarted affected services'
//   ],
//   resolution: 'Root cause identified: connection leak in worker'
// }
```

---

## Performance Comparison

### Example 10: Benchmark Different Search Methods

```typescript
import { Memory, Benchmark } from '@openclaw/mythos-core';

const memory = new Memory();
const benchmark = new Benchmark();

// Compare vector search performance
const results = await benchmark.run({
  name: 'vector-search-comparison',
  iterations: 1000,
  methods: {
    'native-rust': async () => {
      return memory.search({
        query: 'test query',
        engine: 'rust',
        limit: 10
      });
    },
    'js-fallback': async () => {
      return memory.search({
        query: 'test query',
        engine: 'javascript',
        limit: 10
      });
    }
  }
});

console.log(results);
// Output:
// {
//   'native-rust': { avg_ms: 2.3, p95_ms: 3.1, p99_ms: 4.2 },
//   'js-fallback': { avg_ms: 45.7, p95_ms: 52.3, p99_ms: 61.8 }
// }
// Speedup: 19.9x
```

### Example 11: Memory Usage Comparison

```typescript
import { Memory } from '@openclaw/mythos-core';

const memory = new Memory();

// Measure memory usage with native engines
const stats = await memory.getStats();

console.log(stats);
// Output:
// {
//   vector_index: {
//     engine: 'rust-hnsw',
//     vectors: 1000000,
//     memory_mb: 256
//   },
//   text_index: {
//     engine: 'rust-tantivy',
//     documents: 500000,
//     memory_mb: 128
//   },
//   total_memory_mb: 384
// }

// Compare with JavaScript fallback
console.log('Native engines use 4x less memory than JS fallback');
```

---

## Custom Agent Creation

### Example 12: Create a Specialized Agent

```typescript
import { Agent, AgentConfig } from '@openclaw/mythos-core';

const config: AgentConfig = {
  id: 'data-analyst',
  name: 'Data Analyst',
  description: 'Specializes in data analysis and visualization',
  system_prompt: `You are a data analyst expert. You help with:
    - SQL query optimization
    - Data visualization recommendations
    - Statistical analysis
    - Data cleaning and preprocessing`,
  capabilities: ['analysis', 'visualization', 'statistics'],
  tools: ['database-query', 'chart-generator', 'statistical-tests'],
  max_tokens: 4000,
  temperature: 0.3
};

const agent = new Agent(config);

// Use the custom agent
const result = await agent.execute({
  task: 'Analyze this dataset and suggest visualizations',
  context: {
    data_schema: {
      columns: ['date', 'sales', 'region', 'product'],
      rows: 10000
    }
  }
});

console.log(result.output);
```

### Example 13: Agent with Custom Tools

```typescript
import { Agent, Tool } from '@openclaw/mythos-core';

// Define a custom tool
const weatherTool = new Tool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string' },
      units: { type: 'string', enum: ['celsius', 'fahrenheit'] }
    },
    required: ['location']
  },
  execute: async (params) => {
    const response = await fetch(`https://api.weather.com/v1/${params.location}`);
    return response.json();
  }
});

// Create agent with custom tool
const agent = new Agent({
  id: 'weather-assistant',
  name: 'Weather Assistant',
  tools: [weatherTool],
  system_prompt: 'You help users with weather information.'
});

const result = await agent.execute({
  task: "What's the weather like in San Francisco?"
});

console.log(result.output);
// Output: 'The current weather in San Francisco is...'
```

---

## Monitoring Setup

### Example 14: OpenTelemetry Integration

```typescript
import { Memory, Monitoring } from '@openclaw/mythos-core';

const monitoring = new Monitoring({
  serviceName: 'mythos-app',
  exporters: {
    otlp: {
      endpoint: 'http://localhost:4318',
      headers: {
        'Authorization': 'Bearer your-token'
      }
    }
  }
});

const memory = new Memory({
  monitoring
});

// All operations are automatically traced
await memory.store({ content: 'test' });
await memory.search({ query: 'test' });

// Custom spans
await monitoring.trace('custom-operation', async (span) => {
  span.setAttribute('custom.attribute', 'value');
  await memory.search({ query: 'complex query' });
});
```

### Example 15: Prometheus Metrics

```typescript
import { Memory, Metrics } from '@openclaw/mythos-core';

const metrics = new Metrics({
  port: 9090,
  path: '/metrics'
});

const memory = new Memory({
  metrics
});

// Automatic metrics collection:
// - mythos_search_duration_seconds
// - mythos_search_total
// - mythos_store_duration_seconds
// - mythos_store_total
// - mythos_vector_index_size
// - mythos_text_index_size

// Custom metrics
metrics.counter('custom_operations_total').inc();
metrics.histogram('custom_duration_seconds').observe(1.5);
metrics.gauge('active_sessions').set(42);
```

### Example 16: Health Checks

```typescript
import { Memory, HealthCheck } from '@openclaw/mythos-core';

const health = new HealthCheck();

// Register health checks
health.addCheck('vector-engine', async () => {
  const memory = new Memory();
  await memory.search({ query: 'health', limit: 1 });
  return { status: 'healthy', engine: 'rust-hnsw' };
});

health.addCheck('text-engine', async () => {
  const memory = new Memory();
  await memory.searchText({ query: 'health', limit: 1 });
  return { status: 'healthy', engine: 'rust-tantivy' };
});

health.addCheck('embedding-engine', async () => {
  const memory = new Memory();
  await memory.generateEmbedding('health check');
  return { status: 'healthy', model: 'all-MiniLM-L6-v2' };
});

// Express integration
app.get('/health', async (req, res) => {
  const results = await health.checkAll();
  const status = results.every(r => r.status === 'healthy') ? 200 : 503;
  res.status(status).json(results);
});
```

---

## Advanced Patterns

### Example 17: Caching Strategy

```typescript
import { Memory, Cache } from '@openclaw/mythos-core';

const cache = new Cache({
  backend: 'redis',
  ttl: 3600,  // 1 hour
  max_size: 10000
});

const memory = new Memory({
  cache
});

// First search - cache miss, uses Rust engine
const result1 = await memory.search({ query: 'test' });

// Second search - cache hit, instant response
const result2 = await memory.search({ query: 'test' });

console.log(result2.from_cache);  // true
```

### Example 18: Batch Operations

```typescript
import { Memory } from '@openclaw/mythos-core';

const memory = new Memory();

// Batch store (much faster than individual stores)
await memory.storeBatch([
  { content: 'Memory 1', metadata: { tag: 'a' } },
  { content: 'Memory 2', metadata: { tag: 'b' } },
  { content: 'Memory 3', metadata: { tag: 'c' } }
  // ... thousands more
]);

// Batch search
const results = await memory.searchBatch([
  { query: 'query 1' },
  { query: 'query 2' },
  { query: 'query 3' }
]);

console.log(`Processed ${results.length} searches`);
```

### Example 19: Streaming Results

```typescript
import { Memory } from '@openclaw/mythos-core';

const memory = new Memory();

// Stream search results as they're found
const stream = memory.searchStream({
  query: 'complex query',
  limit: 100
});

for await (const result of stream) {
  console.log(`Found: ${result.content} (similarity: ${result.similarity})`);
  // Process results in real-time
}
```

### Example 20: Error Handling and Retries

```typescript
import { Memory, RetryPolicy } from '@openclaw/mythos-core';

const retryPolicy = new RetryPolicy({
  max_retries: 3,
  backoff: 'exponential',
  initial_delay: 100,
  max_delay: 5000
});

const memory = new Memory({
  retryPolicy
});

try {
  await memory.search({ query: 'test' });
} catch (error) {
  if (error.code === 'ENGINE_UNAVAILABLE') {
    console.log('Falling back to JavaScript engine');
    // Fallback logic
  }
}
```

---

## Next Steps

- See [MYTHOS-QUICKSTART.md](MYTHOS-QUICKSTART.md) for setup instructions
- See [MYTHOS-OPERATOR-MANUAL.md](MYTHOS-OPERATOR-MANUAL.md) for production deployment
- See [MYTHOS-API-REFERENCE.md](MYTHOS-API-REFERENCE.md) for complete API documentation

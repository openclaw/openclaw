# Mythos Load Testing Suite

Comprehensive performance testing for Mythos-class AI agent system using k6.

## 🎯 Overview

This load testing suite validates the performance, scalability, and reliability of Mythos under realistic production workloads. It includes:

- **Vector Search Tests**: Validate HNSW index performance
- **Text Search Tests**: Validate Tantivy BM25 search performance  
- **Hybrid Search Tests**: Validate fusion of vector + text search
- **Mixed Workload Tests**: Simulate realistic production usage patterns

## 📊 Test Scripts

### 1. Vector Search Test (`vector-search-test.js`)

**Purpose**: Test vector similarity search performance under various load patterns

**What it tests**:
- Latency percentiles (p50, p90, p95, p99)
- Throughput under sustained load
- Error rates during peak traffic
- System stability during spike tests

**Load scenarios**:
- Warm-up (5 VUs, 30s)
- Moderate load (ramp to 20 VUs, 3m)
- Heavy load (ramp to 50 VUs, 5m)
- Spike test (100 VUs, 1m)

**Expected results** (Mythos-class):
- p50 < 100ms
- p95 < 500ms
- p99 < 1s
- Error rate < 1%

**Run it**:
```bash
# Basic test
k6 run scripts/vector-search-test.js

# Custom load
k6 run --vus 100 --duration 10m scripts/vector-search-test.js

# With environment variables
k6 run --env MYTHOS_URL=http://localhost:18789 \
       --env GATEWAY_TOKEN=your-token \
       scripts/vector-search-test.js
```

### 2. Text Search Test (`text-search-test.js`)

**Purpose**: Test full-text search performance with varying query complexity

**What it tests**:
- BM25 ranking performance
- Tokenization overhead
- Highlight generation
- Filtering and pagination

**Query types**:
- Simple queries (single terms)
- Complex queries (multiple terms)
- Phrase queries (quoted phrases)

**Load scenarios**:
- Ramp-up test (0→100 VUs over 12m)

**Expected results**:
- p50 < 50ms
- p90 < 100ms
- p95 < 200ms
- Error rate < 1%

**Run it**:
```bash
k6 run scripts/text-search-test.js

# With higher load
k6 run --vus 150 --duration 15m scripts/text-search-test.js
```

### 3. Hybrid Search Test (`hybrid-search-test.js`)

**Purpose**: Test combined vector + text search with score fusion

**What it tests**:
- Dual-index query execution
- Score fusion algorithms (weighted sum, RRF)
- Result merging overhead
- Varying weight configurations

**Load scenarios**:
- Steady state (50 VUs, 10m)
- Spike fusion (75 VUs, 5m)

**Expected results**:
- p50 < 150ms (fusion adds overhead)
- p90 < 300ms
- p95 < 500ms
- Error rate < 1%

**Run it**:
```bash
k6 run scripts/hybrid-search-test.js

# Extended test
k6 run --vus 75 --duration 20m scripts/hybrid-search-test.js
```

### 4. Mixed Workload Test (`mixed-workload-test.js`)

**Purpose**: Simulate realistic production usage with diverse operations

**What it tests**:
- System behavior under mixed operation types
- Resource allocation across different search types
- Overall system stability
- Performance isolation between operations

**Workload distribution**:
- 40% Vector search
- 25% Text search
- 20% Hybrid search
- 15% Agent delegation

**Load scenarios**:
- Realistic daily pattern (ramp up/down over 21m)
  - Morning ramp-up (2m)
  - Mid-morning peak (5m)
  - Lunch dip (3m)
  - Afternoon peak (5m)
  - Evening wind-down (3m)

**Expected results**:
- Vector: p95 < 500ms
- Text: p95 < 200ms
- Hybrid: p95 < 500ms
- Delegation: p95 < 2s
- Overall error rate < 1%

**Run it**:
```bash
k6 run scripts/mixed-workload-test.js

# Extended production simulation
k6 run --vus 100 --duration 30m scripts/mixed-workload-test.js
```

## 🚀 Quick Start

### Prerequisites

1. **Install k6**:
   ```bash
   # macOS
   brew install k6
   
   # Linux (Debian/Ubuntu)
   sudo gpg -k
   sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
     --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E343513569D14A5A0D3F7B39B5D761
   echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
     | sudo tee /etc/apt/sources.list.d/k6.list
   sudo apt-get update && sudo apt-get install k6
   
   # Docker
   docker pull grafana/k6
   ```

2. **Start Mythos**:
   ```bash
   # Ensure Mythos is running and accessible
   curl http://localhost:18789/health
   ```

3. **Generate test data** (if needed):
   ```bash
   # Populate memory with test documents
   node scripts/generate-test-data.js
   ```

### Run All Tests

```bash
# Run all tests sequentially
for script in scripts/*-test.js; do
  echo "Running $script..."
  k6 run "$script"
  echo ""
done

# Or use the test runner
node run-all-tests.js
```

### Run Specific Test

```bash
# Vector search
k6 run scripts/vector-search-test.js

# Text search
k6 run scripts/text-search-test.js

# Hybrid search
k6 run scripts/hybrid-search-test.js

# Mixed workload
k6 run scripts/mixed-workload-test.js
```

## 📈 Interpreting Results

### k6 Output

k6 provides real-time metrics during execution:

```
     vector_search_duration...........: avg=45.23ms  min=12.45ms med=42.10ms max=234.56ms p(90)=89.34ms p(95)=156.78ms
     vector_search_errors.............: 0.50%  ✓ 1990 ✗ 10
     vector_search_requests...........: 2000   66.666667/s
     http_req_duration................: avg=46.12ms  min=13.23ms med=43.01ms max=245.67ms p(90)=90.12ms p(95)=158.90ms
```

### Key Metrics

| Metric | Description | Target (Mythos) |
|--------|-------------|-----------------|
| **p50** | Median latency | < 50% of SLA |
| **p90** | 90th percentile | < 80% of SLA |
| **p95** | 95th percentile | < SLA threshold |
| **p99** | 99th percentile | < 2x SLA |
| **Error Rate** | Failed requests | < 1% |
| **Throughput** | Requests/second | Monitor for bottlenecks |

### Threshold Results

k6 validates thresholds and reports pass/fail:

```
     ✓ http_req_duration..............: p(95)=156.78ms  (threshold: <500ms)
     ✓ vector_search_errors...........: 0.50%           (threshold: <1%)
     ✗ vector_search_duration.........: p(95)=523.45ms  (threshold: <500ms) ⚠️
```

## 🎨 Visual Reports

### Generate HTML Report

k6 generates JSON summaries by default. For HTML reports:

```bash
# Using k6-reporter (install globally)
npm install -g k6-reporter

# Generate HTML from JSON
k6 run --out json=results.json scripts/vector-search-test.js
k6-reporter results.json -o report.html
```

### Custom Dashboards

All test scripts generate:
- `*-summary.json`: Full metrics in JSON format
- Console output: Real-time metrics
- HTML reports (when configured)

Import JSON into:
- **Grafana**: Use Prometheus data source
- **Datadog**: Upload JSON metrics
- **Custom dashboards**: Parse with any visualization tool

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MYTHOS_URL` | Mythos Gateway URL | `http://localhost:18789` |
| `GATEWAY_TOKEN` | Authentication token | `test-token` |
| `TEST_DURATION` | Test duration (override) | Script-defined |
| `VUS` | Virtual users (override) | Script-defined |

### Custom Load Profiles

Modify test scripts to create custom scenarios:

```javascript
export const options = {
  scenarios: {
    custom_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '5m', target: 100 },
        { duration: '10m', target: 100 },
        { duration: '5m', target: 0 },
      ],
    },
  },
};
```

### Adjust Thresholds

Update thresholds based on your SLA:

```javascript
thresholds: {
  'vector_search_duration': [
    'p(95)<1000',  // Your SLA: 95% under 1s
  ],
  'vector_search_errors': ['rate<0.05'],  // 5% error tolerance
},
```

## 📊 Performance Benchmarks

### Mythos-Class Targets

Based on Rust-native engines (vs JavaScript baseline):

| Operation | Baseline (JS) | Mythos (Rust) | Improvement |
|-----------|---------------|---------------|-------------|
| Vector Search p50 | 10s | 100ms | **100x** |
| Text Search p50 | 5s | 500ms | **10x** |
| Embedding Gen | 52ms | 1ms | **50x** |
| Protocol Parse | 1μs | 0.2μs | **5x** |
| Sandbox Exec | 105ms | 1ms | **100x** |

### Acceptance Criteria

For production deployment, verify:

- ✅ Vector search p95 < 500ms
- ✅ Text search p95 < 200ms
- ✅ Hybrid search p95 < 500ms
- ✅ Agent delegation p95 < 2s
- ✅ Error rate < 1% across all operations
- ✅ System stable under 100 VUs for 10+ minutes
- ✅ No memory leaks during extended tests

## 🐛 Troubleshooting

### High Latency

**Symptoms**: p95/p99 significantly above targets

**Check**:
1. Mythos is using Rust engines (not JS fallback):
   ```bash
   curl http://localhost:18789/api/v1/status
   # Should show: "vector_engine": "rust-hnsw"
   ```

2. System resources:
   ```bash
   # CPU usage
   top -l 1 | grep "CPU usage"
   
   # Memory usage
   vm_stat
   
   # Disk I/O
   iostat -w 1
   ```

3. Network latency (if remote):
   ```bash
   curl -o /dev/null -s -w "%{time_total}\n" http://localhost:18789/health
   ```

### High Error Rate

**Symptoms**: Error rate > 1%

**Check**:
1. Mythos logs for errors:
   ```bash
   # Docker
   docker logs mythos-gateway
   
   # Local
   tail -f ~/.openclaw/logs/gateway.log
   ```

2. Rate limiting:
   ```bash
   curl -I http://localhost:18789/api/v1/memory/search/vector
   # Should not return 429 Too Many Requests
   ```

3. Authentication:
   ```bash
   curl -H "Authorization: Bearer your-token" \
        http://localhost:18789/api/v1/status
   ```

### k6 Connection Errors

**Symptoms**: k6 can't connect to Mythos

**Fix**:
1. Verify Mythos is running:
   ```bash
   curl http://localhost:18789/health
   ```

2. Check CORS settings:
   ```bash
   curl -X OPTIONS http://localhost:18789/api/v1/memory/search/vector
   ```

3. Update MYTHOS_URL:
   ```bash
   export MYTHOS_URL=http://your-host:18789
   k6 run scripts/vector-search-test.js
   ```

### Test Data Issues

**Symptoms**: Tests fail due to missing data

**Fix**:
```bash
# Generate test data
node scripts/generate-test-data.js

# Or use existing data
k6 run --env USE_EXISTING_DATA=true scripts/vector-search-test.js
```

## 📚 Related Documentation

- **[Mythos Architecture](../MYTHOS-CLASS-ARCHITECTURE-SPEC.md)**: System design and components
- **[Performance Benchmarks](../MYTHOS-BENCHMARK-RESULTS.md)**: Baseline performance data
- **[Monitoring Stack](../monitoring/README.md)**: Production monitoring setup
- **[Deployment Guide](../deploy/README.md)**: Production deployment

## 🎓 Best Practices

### 1. Start Small, Scale Up

Begin with low VU counts to validate setup, then increase:

```bash
# Smoke test
k6 run --vus 5 --duration 30s scripts/vector-search-test.js

# Moderate load
k6 run --vus 50 --duration 5m scripts/vector-search-test.js

# Peak load
k6 run --vus 100 --duration 15m scripts/vector-search-test.js
```

### 2. Run Tests Regularly

Schedule load tests in CI/CD:

```yaml
# .github/workflows/load-test.yml
name: Load Test
on:
  schedule:
    - cron: '0 2 * * 1'  # Weekly at 2 AM Monday
jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: grafana/k6-action@v0.3.0
        with:
          filename: scripts/vector-search-test.js
          flags: --out json=results.json
```

### 3. Compare Against Baselines

Store results and compare across releases:

```bash
# Save baseline
k6 run --out json=baseline.json scripts/vector-search-test.js

# Compare new release
k6 run --out json=current.json scripts/vector-search-test.js

# Analyze differences
node scripts/compare-results.js baseline.json current.json
```

### 4. Monitor During Tests

Watch system metrics while tests run:

```bash
# Terminal 1: Run load test
k6 run scripts/mixed-workload-test.js

# Terminal 2: Monitor Mythos
watch -n 1 'curl -s http://localhost:18789/api/v1/status | jq .'

# Terminal 3: Monitor system
htop
```

### 5. Document Results

Maintain a performance log:

```markdown
## Load Test Results - 2026-07-21

**Test**: Mixed Workload (100 VUs, 30m)  
**Mythos Version**: 2026.5.10  
**Environment**: Production (8 CPU, 16GB RAM)

**Results**:
- Vector search p95: 123ms ✅
- Text search p95: 45ms ✅
- Hybrid search p95: 198ms ✅
- Error rate: 0.3% ✅

**Notes**: All metrics within SLA. System stable throughout test.
```

## 🦞 About

This load testing suite is part of the Mythos-class implementation for OpenClaw, ensuring production-ready performance for Rust-powered multi-agent AI deployments.

**The lobster has titanium claws.** 🦞⚡

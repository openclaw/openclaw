# Mythos Troubleshooting Guide

Comprehensive troubleshooting guide for common issues in Mythos deployments.

## Quick Diagnostics

### Health Check Script

Run the automated diagnostics:

```bash
./automation/mythos-automation.sh health-check
```

### Manual Health Check

```bash
# Gateway health
curl http://localhost:18789/health

# Detailed status
curl http://localhost:18789/api/v1/status

# Prometheus metrics
curl http://localhost:18789/metrics | grep mythos
```

---

## Common Issues

### Issue: Gateway Won't Start

**Symptoms:**
- Gateway container exits immediately
- No logs or error messages
- Port 18789 not bound

**Diagnosis:**

```bash
# Check container status
docker ps -a | grep mythos-gateway

# Check logs
docker logs mythos-gateway --tail 100

# Check port availability
netstat -tuln | grep 18789

# Verify configuration
cat ~/.openclaw/openclaw.json | jq .
```

**Solutions:**

1. **Missing API Keys:**
   ```bash
   # Check environment variables
   env | grep -E "ANTHROPIC|OPENAI|GEMINI"
   
   # Update .env file
   echo "ANTHROPIC_API_KEY=sk-ant-..." >> .env
   ```

2. **Port Conflict:**
   ```bash
   # Find process using port
   lsof -i :18789
   
   # Kill or change port
   kill -9 <PID>
   # Or update openclaw.json
   ```

3. **Invalid Configuration:**
   ```bash
   # Validate JSON
   jq empty ~/.openclaw/openclaw.json
   
   # Reset to defaults
   rm ~/.openclaw/openclaw.json
   ```

4. **Insufficient Resources:**
   ```bash
   # Check system resources
   free -h
   df -h
   
   # Increase Docker resources
   # Docker Desktop → Settings → Resources
   ```

---

### Issue: High Latency

**Symptoms:**
- Requests take > 5 seconds
- Timeouts occur
- Users report slow performance

**Diagnosis:**

```bash
# Check resource usage
docker stats mythos-gateway

# Check Prometheus metrics
curl http://localhost:18789/metrics | grep mythos_request_duration

# Check database performance
psql -U mythos -d mythos -c "SELECT count(*) FROM pg_stat_activity;"
```

**Solutions:**

1. **CPU/Memory Bottleneck:**
   ```bash
   # Increase resources
   # Docker Compose:
   gateway:
     deploy:
       resources:
         limits:
           cpus: '4'
           memory: 8G
   
   # Kubernetes:
   kubectl scale deployment/mythos-gateway --replicas=5
   ```

2. **Database Slow Queries:**
   ```sql
   -- Find slow queries
   SELECT query, calls, total_time, mean_time
   FROM pg_stat_statements
   ORDER BY mean_time DESC
   LIMIT 10;
   
   -- Add indexes
   CREATE INDEX idx_memory_timestamp ON memory(timestamp);
   ```

3. **Network Issues:**
   ```bash
   # Check network latency
   ping localhost
   
   # Test API response time
   time curl http://localhost:18789/health
   ```

4. **JavaScript Engine Fallback:**
   ```bash
   # Check if Rust engines are loaded
   curl http://localhost:18789/api/v1/status | jq .rust_engines
   
   # Rebuild Rust engines
   pnpm build:rust
   ```

---

### Issue: Memory Leaks

**Symptoms:**
- Memory usage grows continuously
- Container gets OOM killed
- Performance degrades over time

**Diagnosis:**

```bash
# Monitor memory usage
watch -n 5 'docker stats --no-stream mythos-gateway'

# Check Node.js heap
docker exec mythos-gateway node -e "console.log(process.memoryUsage())"

# Generate heap snapshot
docker exec mythos-gateway node --inspect=0.0.0.0:9229 dist/index.js
```

**Solutions:**

1. **Increase Heap Size:**
   ```bash
   # Set Node.js options
   export NODE_OPTIONS="--max-old-space-size=4096"
   ```

2. **Fix Memory Leaks:**
   ```javascript
   // Common causes:
   // 1. Event listeners not removed
   emitter.removeListener('event', handler);
   
   // 2. Closures holding references
   function handler() {
     const data = heavyObject;
     return () => {
       // data is still referenced
     };
   }
   
   // 3. Global variables
   global.cache = new Map(); // Never cleared
   ```

3. **Enable Garbage Collection:**
   ```bash
   # Run with GC logging
   node --expose-gc --gc-interval=100 dist/index.js
   ```

4. **Restart Periodically:**
   ```bash
   # Cron job to restart daily
   0 4 * * * docker restart mythos-gateway
   ```

---

### Issue: Vector Search Fails

**Symptoms:**
- "Vector dimension mismatch" errors
- Search returns no results
- HNSW index not created

**Diagnosis:**

```bash
# Check index status
curl http://localhost:18789/api/v1/vector/stats

# Check logs for errors
docker logs mythos-gateway | grep -i vector

# Verify Rust engine
curl http://localhost:18789/api/v1/status | jq .vector_engine
```

**Solutions:**

1. **Dimension Mismatch:**
   ```typescript
   // Ensure consistent dimensions
   const dimensions = 1536; // OpenAI embeddings
   const index = new VectorIndex(dimensions, 'cosine');
   ```

2. **Index Corruption:**
   ```bash
   # Rebuild index
   curl -X POST http://localhost:18789/api/v1/vector/rebuild
   
   # Or manually
   rm -rf ~/.openclaw/memory/vectors/
   # Restart gateway to recreate
   ```

3. **Rust Engine Not Loaded:**
   ```bash
   # Check native modules
   ls -la node_modules/@openclaw/mythos-*/
   
   # Rebuild Rust engines
   pnpm build:rust
   ```

---

### Issue: Text Search Returns Wrong Results

**Symptoms:**
- Irrelevant documents returned
- Low BM25 scores
- Tokenization issues

**Diagnosis:**

```bash
# Check tokenizer
curl http://localhost:18789/api/v1/search/tokenize -d '{"text":"test"}'

# Check index status
curl http://localhost:18789/api/v1/search/stats

# Test query
curl http://localhost:18789/api/v1/search/query -d '{"query":"test","top_k":10}'
```

**Solutions:**

1. **Wrong Tokenizer:**
   ```typescript
   // Use correct tokenizer for language
   const index = new SearchIndex(path, 'unicode61'); // English
   const index = new SearchIndex(path, 'trigram'); // CJK
   ```

2. **Index Not Updated:**
   ```bash
   # Reindex documents
   curl -X POST http://localhost:18789/api/v1/search/reindex
   ```

3. **Query Syntax Error:**
   ```typescript
   // Use correct query syntax
   const results = await searchIndex.query({
     query: 'rust AND programming',
     type: 'boolean'
   });
   ```

---

### Issue: Agent Communication Fails

**Symptoms:**
- Messages not delivered
- "Agent not found" errors
- Task coordination fails

**Diagnosis:**

```bash
# Check agent registry
curl http://localhost:18789/api/v1/agents

# Check message queue
curl http://localhost:18789/api/v1/agents/:id/inbox

# Check logs
docker logs mythos-gateway | grep -i agent
```

**Solutions:**

1. **Agent Not Registered:**
   ```typescript
   // Register agent
   await agentRegistry.register({
     id: 'agent_1',
     name: 'Research Agent',
     capabilities: ['search']
   });
   ```

2. **Message Queue Full:**
   ```bash
   # Clear old messages
   curl -X DELETE http://localhost:18789/api/v1/agents/:id/inbox?older_than=1h
   ```

3. **Network Partition:**
   ```bash
   # Check connectivity
   kubectl exec -it pod/mythos-gateway-xyz -- ping other-pod
   ```

---

### Issue: Database Connection Fails

**Symptoms:**
- "Connection refused" errors
- Timeouts on database queries
- PostgreSQL not responding

**Diagnosis:**

```bash
# Check PostgreSQL status
docker ps | grep postgres
docker logs mythos-postgres --tail 50

# Test connection
psql -h localhost -U mythos -d mythos -c "SELECT 1;"

# Check connection pool
curl http://localhost:18789/metrics | grep pg_connection
```

**Solutions:**

1. **PostgreSQL Not Running:**
   ```bash
   # Start PostgreSQL
   docker start mythos-postgres
   
   # Check logs for errors
   docker logs mythos-postgres
   ```

2. **Connection Limit Reached:**
   ```sql
   -- Check active connections
   SELECT count(*) FROM pg_stat_activity;
   
   -- Increase max connections
   ALTER SYSTEM SET max_connections = 200;
   SELECT pg_reload_conf();
   ```

3. **Wrong Credentials:**
   ```bash
   # Check environment variables
   echo $POSTGRES_USER
   echo $POSTGRES_PASSWORD
   
   # Update .env file
   echo "POSTGRES_PASSWORD=correct-password" >> .env
   ```

---

### Issue: Redis Connection Fails

**Symptoms:**
- Cache misses
- "Connection refused" errors
- Rate limiting not working

**Diagnosis:**

```bash
# Check Redis status
docker ps | grep redis
docker logs mythos-redis --tail 50

# Test connection
redis-cli -h localhost ping

# Check memory usage
redis-cli info memory
```

**Solutions:**

1. **Redis Not Running:**
   ```bash
   # Start Redis
   docker start mythos-redis
   ```

2. **Memory Limit Reached:**
   ```bash
   # Check memory
   redis-cli info memory | grep used_memory_human
   
   # Increase limit
   redis-cli config set maxmemory 4gb
   ```

3. **Eviction Policy:**
   ```bash
   # Check current policy
   redis-cli config get maxmemory-policy
   
   # Set appropriate policy
   redis-cli config set maxmemory-policy allkeys-lru
   ```

---

### Issue: Monitoring Not Working

**Symptoms:**
- Prometheus can't scrape metrics
- Grafana dashboards empty
- Alerts not firing

**Diagnosis:**

```bash
# Check Prometheus targets
curl http://localhost:9090/api/v1/targets

# Check metrics endpoint
curl http://localhost:18789/metrics | head -20

# Check Grafana data sources
curl -H "Authorization: Bearer $GRAFANA_TOKEN" \
  http://localhost:3000/api/datasources
```

**Solutions:**

1. **Metrics Endpoint Disabled:**
   ```bash
   # Enable metrics in config
   echo '{"monitoring":{"enabled":true}}' >> ~/.openclaw/openclaw.json
   ```

2. **Prometheus Target Missing:**
   ```yaml
   # Update prometheus.yml
   scrape_configs:
     - job_name: 'mythos'
       static_configs:
         - targets: ['mythos-gateway:18789']
       metrics_path: '/metrics'
   ```

3. **Grafana Data Source Wrong:**
   ```bash
   # Update data source
   curl -X PUT -H "Authorization: Bearer $GRAFANA_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"url":"http://prometheus:9090"}' \
     http://localhost:3000/api/datasources/1
   ```

---

## Advanced Diagnostics

### Heap Profiling

```bash
# Generate heap snapshot
docker exec mythos-gateway node --inspect=0.0.0.0:9229 dist/index.js

# In Chrome DevTools:
# chrome://inspect → Configure → Add localhost:9229
# Memory → Take heap snapshot
```

### CPU Profiling

```bash
# Enable profiling
docker exec mythos-gateway node --prof dist/index.js

# Generate report
node --prof-process isolate-*.log > profile.txt
```

### Network Tracing

```bash
# Capture network traffic
tcpdump -i any -w mythos.pcap port 18789

# Analyze with Wireshark
wireshark mythos.pcap
```

### Database Profiling

```sql
-- Enable query logging
ALTER SYSTEM SET log_statement = 'all';
SELECT pg_reload_conf();

-- Check slow queries
SELECT query, calls, total_time, mean_time
FROM pg_stat_statements
WHERE mean_time > 1000
ORDER BY mean_time DESC;
```

---

## Debugging Tools

### Interactive Debugging

```bash
# Enter gateway container
docker exec -it mythos-gateway /bin/bash

# Check Node.js version
node --version

# Check environment
env | grep OPENCLAW

# Test API manually
curl http://localhost:18789/health
```

### Log Analysis

```bash
# Filter logs by level
docker logs mythos-gateway 2>&1 | grep -i error

# Follow logs in real-time
docker logs -f mythos-gateway

# Search for specific patterns
docker logs mythos-gateway | grep -E "ERROR|WARN|FATAL"
```

### Performance Profiling

```bash
# Run load test
node benchmarks/run-all.js

# Check bottlenecks
docker stats mythos-gateway mythos-postgres mythos-redis
```

---

## Support Resources

### Documentation

- **API Reference:** `docs/api/README.md`
- **Deployment Guide:** `docs/deployment/README.md`
- **Security Guide:** `docs/security/README.md`

### Community

- **GitHub Issues:** https://github.com/openclaw/openclaw/issues
- **Discord:** https://discord.gg/openclaw
- **Documentation:** https://docs.openclaw.ai

### Commercial Support

For enterprise support, contact:
- **Email:** support@openclaw.ai
- **Website:** https://openclaw.ai/support

---

## Checklist

When reporting an issue:

- [ ] Mythos version
- [ ] Node.js version
- [ ] Rust version
- [ ] Operating system
- [ ] Deployment method (Docker/Kubernetes/Bare metal)
- [ ] Error messages (full text)
- [ ] Log output (last 100 lines)
- [ ] Configuration (sanitized)
- [ ] Steps to reproduce
- [ ] Expected vs actual behavior

---

## License

MIT License - See LICENSE for details.

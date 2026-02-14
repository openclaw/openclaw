# 📊 AUDITORIA: Monitoramento & Health Checks

**Área:** Metrics, alerts, dashboards, SLOs, observability  
**Data:** 2026-02-13

---

## ❌ GAPS IDENTIFICADOS

1. **Métricas não coletadas** - CPU/memory/latency não tracked
2. **Alertas inexistentes** - Problemas descobertos por usuários
3. **Dashboards ausentes** - Visibilidade zero do sistema
4. **SLOs não definidos** - Sem objetivos claros de performance
5. **Health checks superficiais** - Apenas "server up", não validam dependencies

---

## ✅ CORREÇÕES

### 10.1: Prometheus Metrics

```typescript
// src/infra/metrics.ts
import { Counter, Histogram, Gauge, register } from "prom-client";

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
});

export const httpRequestTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status"],
});

export const activeConnections = new Gauge({
  name: "active_connections",
  help: "Number of active connections",
});

// Middleware
export function metricsMiddleware(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    const duration = (Date.now() - start) / 1000;

    httpRequestDuration.observe(
      { method: req.method, route: req.route?.path || "unknown", status: res.statusCode },
      duration,
    );

    httpRequestTotal.inc({
      method: req.method,
      route: req.route?.path || "unknown",
      status: res.statusCode,
    });
  });

  next();
}

// Expose /metrics endpoint
app.get("/metrics", async (req, res) => {
  res.set("Content-Type", register.contentType);
  res.end(await register.metrics());
});
```

### 10.2: Health Check Hierarchy

```typescript
// src/infra/health.ts

interface HealthCheck {
  name: string;
  check: () => Promise<{ status: "pass" | "fail"; message?: string }>;
  critical: boolean;
}

const checks: HealthCheck[] = [
  // Critical: App can't function without these
  {
    name: "database",
    critical: true,
    check: async () => {
      try {
        await db.raw("SELECT 1");
        return { status: "pass" };
      } catch (error) {
        return { status: "fail", message: error.message };
      }
    },
  },
  {
    name: "redis",
    critical: true,
    check: async () => {
      try {
        await redis.ping();
        return { status: "pass" };
      } catch (error) {
        return { status: "fail", message: error.message };
      }
    },
  },
  // Non-critical: App degrades but still works
  {
    name: "stripe",
    critical: false,
    check: async () => {
      try {
        await stripe.balance.retrieve();
        return { status: "pass" };
      } catch (error) {
        return { status: "fail", message: error.message };
      }
    },
  },
];

app.get("/health", async (req, res) => {
  const results = await Promise.all(
    checks.map(async (check) => ({
      name: check.name,
      critical: check.critical,
      ...(await check.check()),
    })),
  );

  const allCriticalPass = results.filter((r) => r.critical).every((r) => r.status === "pass");

  res.status(allCriticalPass ? 200 : 503).json({
    status: allCriticalPass ? "healthy" : "unhealthy",
    checks: results,
  });
});
```

### 10.3: Alerting Rules

```yaml
# prometheus/alerts.yml

groups:
  - name: api_alerts
    interval: 30s
    rules:
      # High error rate
      - alert: HighErrorRate
        expr: |
          rate(http_requests_total{status=~"5.."}[5m]) / rate(http_requests_total[5m]) > 0.05
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "High error rate detected"
          description: "{{ $value }}% of requests are failing"

      # Slow responses
      - alert: SlowResponses
        expr: |
          histogram_quantile(0.99, http_request_duration_seconds_bucket) > 1
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "API responses are slow"
          description: "p99 latency is {{ $value }}s (threshold: 1s)"

      # High memory usage
      - alert: HighMemoryUsage
        expr: |
          process_resident_memory_bytes / 1024 / 1024 / 1024 > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High memory usage"
          description: "Process using {{ $value }}GB of memory"

      # Database connection pool exhausted
      - alert: DatabasePoolExhausted
        expr: |
          db_pool_active_connections / db_pool_max_connections > 0.9
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Database connection pool near exhaustion"
          description: "{{ $value }}% of connections in use"
```

### 10.4: Grafana Dashboard

```json
// grafana/dashboards/api-dashboard.json (simplified)
{
  "dashboard": {
    "title": "API Monitoring",
    "panels": [
      {
        "title": "Request Rate",
        "targets": [
          {
            "expr": "rate(http_requests_total[5m])"
          }
        ]
      },
      {
        "title": "Error Rate",
        "targets": [
          {
            "expr": "rate(http_requests_total{status=~\"5..\"}[5m]) / rate(http_requests_total[5m])"
          }
        ]
      },
      {
        "title": "p50/p99 Latency",
        "targets": [
          {
            "expr": "histogram_quantile(0.50, http_request_duration_seconds_bucket)",
            "legendFormat": "p50"
          },
          {
            "expr": "histogram_quantile(0.99, http_request_duration_seconds_bucket)",
            "legendFormat": "p99"
          }
        ]
      }
    ]
  }
}
```

### 10.5: SLOs (Service Level Objectives)

```markdown
# SLO_DEFINITIONS.md

## API Availability SLO

**Target:** 99.9% (three nines)  
**Error Budget:** 43 minutes/month  
**Measurement:** Percentage of successful requests (status < 500)

**Alert when:**

- Error budget consumed > 50% in 1 day
- Error budget consumed > 90% in 1 week

## API Latency SLO

**Target:** p99 < 500ms  
**Error Budget:** 1% of requests can exceed 500ms  
**Measurement:** 99th percentile response time

**Alert when:**

- p99 > 500ms for 10 minutes
- p99 > 1s for 5 minutes

## Database Query Performance

**Target:** p99 < 100ms  
**Measurement:** Database query duration

**Alert when:**

- p99 > 100ms for 15 minutes

## Uptime

**Target:** 99.95% uptime  
**Error Budget:** 21 minutes/month

**Measurement:** Health check success rate

**Alert when:**

- Health check fails for 2 consecutive minutes
```

---

## 📊 MÉTRICAS DE SUCESSO

- [ ] 100% de critical paths têm metrics
- [ ] Zero incidents descobertos por usuários (alerts proativos)
- [ ] < 5min para detectar problems (MTTD)
- [ ] Dashboard atualizado em real-time

---

**FIM DO DOCUMENTO**

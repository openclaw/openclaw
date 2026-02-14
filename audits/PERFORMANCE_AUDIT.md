# ⚡ AUDITORIA: Performance & Otimização

**Área:** Profiling, optimization, caching, database tuning  
**Data:** 2026-02-13

---

## ❌ GAPS IDENTIFICADOS

1. **N+1 queries** - Loops com queries individuais
2. **Missing indexes** - Full table scans em queries frequentes
3. **No caching** - Mesmos dados buscados repetidamente
4. **Large payloads** - Retornando dados desnecessários
5. **Synchronous operations** - Operações que poderiam ser paralelas

---

## ✅ CORREÇÕES

### 14.1: Database Optimization

```typescript
// ❌ BAD: N+1 query problem
const orders = await db.orders.findMany();
for (const order of orders) {
  order.user = await db.users.findUnique({ where: { id: order.userId } });
}
// 1 query + N queries = 1 + 100 = 101 queries

// ✅ GOOD: Single query with join
const orders = await db.orders.findMany({
  include: { user: true },
});
// 1 query total

// ✅ BETTER: DataLoader (batching + caching)
const loader = new DataLoader(async (userIds) => {
  const users = await db.users.findMany({ where: { id: { in: userIds } } });
  return userIds.map((id) => users.find((u) => u.id === id));
});

const orders = await db.orders.findMany();
for (const order of orders) {
  order.user = await loader.load(order.userId); // Batched + cached
}
```

### 14.2: Caching Strategy

```typescript
// Redis caching for expensive operations
import { Redis } from "ioredis";
const redis = new Redis();

async function getUserOrders(userId: string) {
  const cacheKey = `user:${userId}:orders`;

  // Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss: Query database
  const orders = await db.orders.findMany({
    where: { userId },
    include: { items: true },
  });

  // Cache for 5 minutes
  await redis.setex(cacheKey, 300, JSON.stringify(orders));

  return orders;
}

// Invalidate cache on write
async function createOrder(data) {
  const order = await db.orders.create({ data });

  // Invalidate user's order cache
  await redis.del(`user:${data.userId}:orders`);

  return order;
}
```

### 14.3: Query Optimization

```sql
-- ❌ BAD: No indexes
SELECT * FROM orders WHERE user_id = 'user-123' ORDER BY created_at DESC LIMIT 20;
-- Full table scan on 1M rows → 2.5s

-- ✅ GOOD: Composite index
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at DESC);
-- Index seek → 15ms

-- ❌ BAD: SELECT *
SELECT * FROM orders WHERE user_id = 'user-123';
-- Returns 50+ columns, 100KB payload

-- ✅ GOOD: Select only needed fields
SELECT id, total, status, created_at FROM orders WHERE user_id = 'user-123';
-- Returns 4 columns, 5KB payload (20x smaller)
```

### 14.4: Pagination

```typescript
// ❌ BAD: OFFSET pagination (slow for large offsets)
const orders = await db.orders.findMany({
  where: { userId },
  skip: 10000, // Skip 10k rows (slow!)
  take: 20,
});

// ✅ GOOD: Cursor pagination (fast for any position)
const orders = await db.orders.findMany({
  where: {
    userId,
    createdAt: { lt: cursor }, // Start after cursor
  },
  take: 20,
  orderBy: { createdAt: "desc" },
});
```

### 14.5: Parallel Operations

```typescript
// ❌ BAD: Sequential
const user = await fetchUser(userId);
const orders = await fetchOrders(userId);
const payments = await fetchPayments(userId);
// Total time: 300ms + 200ms + 150ms = 650ms

// ✅ GOOD: Parallel
const [user, orders, payments] = await Promise.all([
  fetchUser(userId),
  fetchOrders(userId),
  fetchPayments(userId),
]);
// Total time: max(300ms, 200ms, 150ms) = 300ms (2x faster)
```

### 14.6: Profiling

```typescript
// Add performance markers
import { performance } from "perf_hooks";

async function slowFunction() {
  performance.mark("start-slow-function");

  // Do work...
  await someOperation();

  performance.mark("end-slow-function");
  performance.measure("slow-function", "start-slow-function", "end-slow-function");

  const measure = performance.getEntriesByName("slow-function")[0];
  if (measure.duration > 1000) {
    console.warn(`slow-function took ${measure.duration}ms (expected < 1000ms)`);
  }
}
```

---

## 📊 TARGETS

- [ ] p99 API latency < 500ms
- [ ] p99 database query < 100ms
- [ ] Cache hit rate > 80% for hot data
- [ ] Zero N+1 queries
- [ ] All tables have indexes on foreign keys

---

**FIM DO DOCUMENTO**

# 🔥 Coding Rules — Long-Term Rulebook

**Source:** HH's Coding Rules Pack
**Added:** 2026-01-31
**Full docs:** `/home/i/clawd/docs/coding-rules/`

---

## Quick Reference — The 90 Golden Rules

### Category 1: TypeScript Standards

- TS-001: `strict: true` required
- TS-002: No `any` — use `unknown` with type guards
- TS-003: Explicit return types on exports
- TS-004: Let inference work for locals
- TS-005: `interface` for objects, `type` for unions
- TS-006: Use `readonly` for immutable data
- TS-007: Discriminated unions for state
- TS-008: Avoid enums → use `as const` objects
- TS-009: Use template literal types
- TS-010: Branded types for type safety

### Category 2: Code Quality

- CQ-001: Single responsibility (max 20 lines/function)
- CQ-002: Descriptive names (no `d`, `calc`, single letters)
- CQ-003: No magic numbers → use constants
- CQ-004: Early returns to reduce nesting
- CQ-005: No nested ternaries
- CQ-006: Prefer `const` over `let`
- CQ-007: No side effects in pure functions
- CQ-008: Consistent error handling (Result types)
- CQ-009: No console.log in production
- CQ-010: Max file length 300 lines

### Category 3: Testing Standards

- TEST-001: `.test.ts` (unit), `.spec.ts` (integration), `.e2e.ts`
- TEST-002: AAA pattern (Arrange, Act, Assert)
- TEST-003: One logical assertion per test
- TEST-004: Descriptive test names
- TEST-005: Use fixtures
- TEST-006: Mock external dependencies
- TEST-007: Test edge cases (null, empty, boundaries)
- TEST-008: No test interdependence
- TEST-009: MSW for API mocking
- TEST-010: 80% coverage minimum

### Category 4: API Design

- API-001: RESTful nouns (`/users` not `/getUsers`)
- API-002: Consistent response format `{ data, meta, error }`
- API-003: Correct HTTP status codes
- API-004: Validate all input (Zod)
- API-005: Rate limiting required
- API-006: Pagination required on lists
- API-007: Version APIs (`/api/v1/`)
- API-008: OpenAPI documentation
- API-009: Idempotency keys for POST/PUT
- API-010: Explicit CORS config

### Category 5: Security

- SEC-001: Principle of least privilege
- SEC-002: Parameterized queries (no SQL injection)
- SEC-003: Output encoding (no XSS)
- SEC-004: Authentication on non-public endpoints
- SEC-005: Authorization checks per resource
- SEC-006: bcrypt with cost ≥12
- SEC-007: HTTPS only
- SEC-008: Security headers (helmet)
- SEC-009: Rate limit auth endpoints
- SEC-010: Audit logging

### Category 6: Performance

- PERF-001: Database indexes on FKs and query columns
- PERF-002: Prevent N+1 queries (eager loading)
- PERF-003: gzip/brotli compression
- PERF-004: Caching at appropriate layers
- PERF-005: Lazy load non-critical
- PERF-006: Connection pooling
- PERF-007: Never block event loop
- PERF-008: Bundle limits (JS <250KB, CSS <50KB gzipped)
- PERF-009: Image optimization (WebP preferred)
- PERF-010: Monitor slow queries (>100ms)

### Category 7: Containers (Podman)

- POD-001: Multi-stage builds
- POD-002: Non-root user
- POD-003: Health checks required
- POD-004: Environment variables for config
- POD-005: Volume mounts for dev
- POD-006: Network isolation
- POD-007: Resource limits
- POD-008: .containerignore required
- POD-009: Pin image versions
- POD-010: Log to stdout/stderr

### Category 8: Observability

- OBS-001: Structured JSON logging
- OBS-002: Appropriate log levels
- OBS-003: Request logging with timing
- OBS-004: Error logging with stack + context
- OBS-005: Prometheus metrics at `/metrics`
- OBS-006: OpenTelemetry tracing
- OBS-007: Correlation ID propagation
- OBS-008: `/health` and `/ready` endpoints
- OBS-009: Alert on error rate >1%
- OBS-010: Grafana dashboards

### Category 9: Database

- DB-001: Use Prisma/Drizzle ORM
- DB-002: Migration naming: `YYYYMMDDHHMMSS_name.sql`
- DB-003: Soft deletes (`deletedAt`)
- DB-004: `createdAt`/`updatedAt` required
- DB-005: UUID/CUID primary keys
- DB-006: Define ON DELETE behavior
- DB-007: Index naming: `idx_{table}_{columns}`
- DB-008: No raw queries without review
- DB-009: Connection pooling in prod
- DB-010: Lint migrations before commit

---

## 2026 Tech Stack

| Category       | Choice              | Status   |
| -------------- | ------------------- | -------- |
| Frontend       | React 19 / Svelte 5 | Standard |
| Meta-Framework | Next.js 15+ / Astro | Standard |
| CSS            | Tailwind v4         | Dominant |
| Components     | shadcn/ui           | Standard |
| Runtime        | Node 24 LTS / Bun   | Standard |
| ORM            | Drizzle / Prisma    | Standard |
| State          | TanStack Query      | Standard |
| Build          | Vite                | Standard |
| Linting        | Biome               | Trending |

---

## Anti-Patterns (AVOID)

### UX

- ❌ Scroll-jacking
- ❌ Lazy-loaded hero images
- ❌ Carousels/sliders
- ❌ Hamburger menu on desktop
- ❌ Infinite scroll without load-more
- ❌ Corporate Memphis illustrations
- ❌ Hover-only menus
- ❌ Full-screen modals on entry

### Tech

- ❌ Create React App (dead)
- ❌ Manual Webpack config
- ❌ Redux for simple apps
- ❌ Class components
- ❌ Manual CSS files
- ❌ JPG/PNG (use WebP)
- ❌ Icon fonts (use SVG)
- ❌ GIFs (use Lottie/video)

---

## HTML/CSS Rules

1. **Strict separation:** HTML=structure, CSS=appearance, JS=behavior
2. **Semantic HTML:** `<article>`, `<nav>`, `<aside>` not div soup
3. **BEM or CSS Modules** for scoping
4. **Mobile-first** media queries (`min-width`)
5. **CSS variables** for colors, spacing, fonts
6. **Max 3 levels** nesting depth
7. **Reset/normalize** as first import
8. **Utility classes** for layout only
9. **A11y:** Never `display:none` for screen readers
10. **Relative units:** `rem`, `%`, `vw/vh` not `px`

---

## Microservices Rules

1. **Shared nothing** — each service owns its data
2. **Black box interfaces** — API contracts only
3. **Single responsibility** — one thing per service/file/function
4. **200/30 rule** — files <200 lines, functions <30 lines
5. **Stateless** — state in Redis/DB, not memory
6. **Fail fast** — circuit breakers, bulkheads
7. **Event-driven** — prefer async over sync
8. **Independent CI/CD** — deploy without waiting
9. **Correlation IDs** — trace across services
10. **Containerized** — Docker/Podman images

---

## Resilience Rules

1. **Error boundaries** — isolate UI crashes
2. **Graceful degradation** — reduced functionality > error
3. **Exponential backoff** — 1s, 2s, 4s, 8s retries
4. **Input validation** at every border
5. **User-friendly errors** — no stack traces to users
6. **Transaction rollbacks** — atomic operations
7. **Timeouts** on all network calls (5s default)
8. **Dead letter queues** for failed jobs
9. **Circuit breakers** for external services
10. **Global exception handlers** — log + alert

---

_Reference this file before any development work._

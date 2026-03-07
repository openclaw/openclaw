# CUTMV Post-Merge TODO

Priority: P0 = security/critical, P1 = should fix soon, P2 = nice to have

## P0 — Security

- [ ] **Remove unauthenticated debug endpoints** — `/api/debug/jobs/:userEmail`, `/api/r2-test`, `/api/test/promo-processing` have no auth checks. File: `server/routes.ts` lines ~203-285
- [ ] **Set URL_ENCRYPTION_SECRET** — Hardcoded fallback key `cutmv-url-security-key-2025` in `server/url-security.ts`. Must set env var in production.
- [ ] **Scope 10GB body parser** — `express.json({ limit: '10gb' })` applies to ALL routes. Should only apply to upload endpoints. File: `server/index.ts`
- [ ] **Remove `test-route-12345`** — Debug endpoint left in production. File: `server/index.ts`

## P1 — Code Quality

- [ ] **Split routes.ts** — 2,749 lines. Should be split into: upload-routes.ts, processing-routes.ts, download-routes.ts, debug-routes.ts (or remove debug)
- [ ] **Fix ~100+ lint errors** — `no-explicit-any`, unused vars, unused imports. Run `pnpm lint` to see full list
- [ ] **Remove Replit Vite plugin reference** — `vite.config.ts` still imports `@replit/vite-plugin-cartographer`
- [ ] **Hash session tokens** — Session tokens stored as plaintext in `sessions` table. Should be hashed like magic link tokens.
- [ ] **Add rate limiting** — No rate limiting on auth endpoints (magic link requests, code verification)
- [ ] **Fix CORS for production** — Allows `replit.app` and `localhost` origins in production mode
- [ ] **Fix expired STAFF25 promo code** — Expired 2025-12-31. Either update or remove.
- [ ] **Persist promo codes** — Currently in-memory only, lost on server restart.

## P2 — Architecture

- [ ] **Add structured logging** — Replace emoji `console.log` throughout with a logging library (pino, winston)
- [ ] **Evaluate screenshot PNGs** — 100+ screenshot files in `client/public/`. Consider CDN or gitignore.
- [ ] **Deduplicate AuthService instantiation** — Instantiated independently in auth-middleware.ts, auth-routes.ts, and routes.ts
- [ ] **Update tsconfig path aliases** — `@/*`, `@shared/*`, `@assets/*` may need adjustment for monorepo paths
- [ ] **Consider shared auth with OpenClaw** — Could share session/auth infrastructure via gateway
- [ ] **Evaluate Remotion integration** — `@openclaw/remotion-engine` is a sibling package. Could use for video preview generation.
- [ ] **Fix setTimeout 32-bit overflow** — Auto-deletion of 29-day exports uses setTimeout which overflows at ~24.8 days. Consider cron or database expiry instead.
- [ ] **CSP hardening** — Remove `unsafe-inline` and `unsafe-eval` from Content-Security-Policy

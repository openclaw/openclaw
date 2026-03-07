# CUTMV Monorepo Merge Audit

**Source**: `/Users/da/cutmv` (standalone repo)
**Destination**: `/Users/da/openclaw/packages/cutmv-app/`
**Date**: 2026-03-07

---

## Product Summary

CUTMV is a music-video-focused SaaS tool for generating cutdowns, short clips, GIF packs, thumbnail packs, and Spotify Canvas loops from uploaded music video source material. Users upload a video, specify timestamps and export types, and receive a processed ZIP via email download link.

- **Domain**: cutmv.fulldigitalll.com
- **Owner**: Full Digital LLC
- **License**: Proprietary
- **Deployment**: Railway (Nixpacks with Node 20 + FFmpeg)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript (strict, ESM) |
| Frontend | React 18 SPA (Vite, Wouter, TanStack Query) |
| UI | Radix UI / shadcn/ui, Tailwind CSS, Framer Motion |
| Backend | Express.js 4 |
| Database | PostgreSQL (Neon Serverless), Drizzle ORM |
| Auth | Magic link email + Google OAuth + Microsoft OAuth (Passport.js) |
| Payments | Stripe (subscriptions + credit purchases) |
| Storage | Cloudflare R2 (S3-compatible, no local disk) |
| Video | FFmpeg (fluent-ffmpeg + raw spawn) |
| Email | Resend API |
| Real-time | WebSocket (ws) for FFmpeg progress |
| AI | OpenAI (metadata suggestions) |
| Analytics | PostHog, Sentry |

## Dependency Conflicts with OpenClaw Root

| Package | CUTMV | OpenClaw Root | Risk |
|---------|-------|---------------|------|
| express | ^4.21.2 | ^5.2.1 | **None** — CUTMV keeps its own package.json |
| zod | ^3.24.2 | ^4.3.6 | **None** — isolated in workspace package |
| typescript | ^5.6.3 | ^5.9.3 | Compatible (minor) |
| ws | ^8.18.0 | ^8.19.0 | Compatible (patch) |

pnpm workspace isolation means each package manages its own dependencies. No root conflicts.

## Environment Variables Required

### Critical (app will not start without these)
- `DATABASE_URL` — Neon PostgreSQL connection string
- `SESSION_SECRET` — Session encryption key

### Payments
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
- `STRIPE_STARTER_PRICE_ID`, `STRIPE_PRO_PRICE_ID`, `STRIPE_ENTERPRISE_PRICE_ID`

### Storage
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ENDPOINT`, `R2_BUCKET_NAME`

### Email
- `RESEND_API_KEY`

### OAuth
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL`
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID` (optional)

### Analytics/Monitoring
- `POSTHOG_API_KEY`, `SENTRY_DSN`

### Security
- `URL_ENCRYPTION_SECRET` — **MUST be set; fallback is a hardcoded key**

## Security Concerns

### Critical
1. **Hardcoded encryption key fallback** in `server/url-security.ts` — if `URL_ENCRYPTION_SECRET` is unset, magic link URLs use `cutmv-url-security-key-2025`
2. **Unauthenticated debug endpoints** — `/api/debug/jobs/:userEmail`, `/api/r2-test`, `/api/test/promo-processing` have no auth
3. **Session tokens stored in plaintext** in database
4. **10GB body parser on all JSON routes** — memory exhaustion risk

### Moderate
5. Missing admin authorization on referral admin routes
6. Overly permissive R2 access validation
7. CORS allows `replit.app` and `localhost` in production
8. CSP uses `unsafe-inline` and `unsafe-eval`
9. No rate limiting on auth endpoints

## Database Schema (11 tables)

`users`, `sessions`, `magic_links`, `videos`, `clips`, `exports`, `background_jobs`, `email_deliveries`, `credit_transactions`, `referral_events`, `referral_tracking`

Plus `download_tokens` created via raw SQL.

## Technical Debt

- `server/routes.ts` is 2,749 lines — needs splitting
- ~30 loose debug/migration scripts at repo root — needs organization
- Promo code `STAFF25` expired (2025-12-31)
- Promo codes stored in-memory only (lost on restart)
- Console.log emoji logging throughout (no structured logging)
- 100+ screenshot PNGs in `client/public/`
- Duplicate AuthService instantiation across modules

## Core IP (Unique Business Logic)

1. **Video processing pipeline** — FFmpeg orchestration with letterbox detection, Spotify Canvas loops, adaptive timeouts, real-time WebSocket progress
2. **Credit/pricing system** — Dual-credit model (purchased vs subscription), subscriber discounts
3. **Background job manager** — Full lifecycle with email notifications, stall detection, progress monitoring
4. **R2-only architecture** — Memory-to-R2 pipeline with multipart uploads, per-user folders
5. **Timestamp parser** — Flexible user-provided timestamp format handling

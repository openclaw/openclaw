# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development Commands

```bash
# Development
npm run dev                  # Start dev server with hot reload (tsx + vite)

# Production build
npm run build               # Build client (vite) + server (esbuild)
npm run start               # Run production server

# Type checking
npm run check               # TypeScript type check

# Database (Drizzle ORM + Neon PostgreSQL)
npm run db:push             # Push schema changes to database
npm run db:generate         # Generate migrations
npm run db:migrate          # Run migrations
npm run db:studio           # Open Drizzle Studio
```

## Architecture Overview

This is a full-stack TypeScript video processing application (CUTMV) with:
- **Frontend**: React 18 SPA with Vite, Tailwind CSS, Radix UI (shadcn/ui), Wouter routing
- **Backend**: Express.js server with WebSocket support
- **Database**: PostgreSQL via Neon serverless + Drizzle ORM
- **Storage**: Cloudflare R2 for video/export files
- **Payments**: Stripe (subscriptions + credits)
- **Email**: Resend API for magic link auth and notifications

### Directory Structure

```
client/src/          # React frontend
  pages/             # Route pages (landing, app, dashboard, profile, etc.)
  components/        # UI components (AuthGuard, DashboardLayout, ui/)
  hooks/             # Custom hooks (useAuth, useWebSocketProgress, etc.)
  lib/               # Utilities (queryClient, sentry, posthog)

server/              # Express backend
  index.ts           # App entry, middleware setup
  routes.ts          # Main routes, video upload/processing, WebSocket
  auth-routes.ts     # Magic link authentication
  auth-service.ts    # Auth logic, session management
  auth-middleware.ts # requireAuth, optionalAuth middleware
  user-routes.ts     # User profile, exports
  credit-routes.ts   # Credit system
  subscription-routes.ts  # Stripe subscriptions
  referral-routes.ts      # Referral program
  stripe-webhook.ts       # Stripe webhooks
  db.ts              # Database connection
  services/          # Business logic (credit, referral, subscription)
  r2-storage.ts      # Cloudflare R2 integration
  email-service.ts   # Resend email integration

shared/              # Shared TypeScript modules
  schema.ts          # Drizzle schema + Zod validation (users, videos, exports, etc.)
```

### Key Patterns

**Path Aliases** (configured in tsconfig.json):
- `@/*` → `client/src/*`
- `@shared/*` → `shared/*`
- `@assets/*` → `attached_assets/*`

**Authentication**: Magic link email-only auth. Sessions stored in PostgreSQL with 30-day expiration. Cookie name: `cutmv-session`.

**Middleware Order** (critical in server/index.ts):
1. Stripe webhook route (needs raw body, before parsers)
2. Body parsers (10GB limit for video uploads)
3. Cookie parser
4. Canonical domain redirect
5. CORS + CSP headers
6. API routes (must be before static files)
7. Vite dev server OR static file serving

**Real-time Progress**: WebSocket server at `/ws` for video processing progress updates. Client hook: `useWebSocketProgress`.

**Credit System**: Users have `creditsPurchased` + `creditsSubscription`. Check affordability via `/api/credits/can-afford/:cost`.

### Database Schema (shared/schema.ts)

Core tables: `users`, `sessions`, `magicLinks`, `videos`, `backgroundJobs`, `exports`, `emailDeliveries`, `creditTransactions`, `referralEvents`

Videos and exports have R2 storage keys. Exports expire after 29 days.

### API Route Prefixes

- `/api/auth/*` - Authentication (signin, verify-code, logout, me)
- `/api/user/*` - User data (uploads, exports, profile)
- `/api/credits/*` - Credit balance and purchases
- `/api/subscription/*` - Stripe subscription management
- `/api/referral/*` - Referral program
- `/api/stripe` - Stripe webhooks
- `/api/upload`, `/api/process` - Video upload and processing

### Environment Variables

Required: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `R2_*` credentials, `RESEND_API_KEY`

Optional: `SENTRY_DSN`, `POSTHOG_API_KEY`, `OPENAI_API_KEY`

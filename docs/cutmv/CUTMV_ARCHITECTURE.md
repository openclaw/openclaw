# CUTMV Architecture

## System Overview

```
[Browser]  ──HTTP──>  [Express.js Server]  ──SQL──>  [Neon PostgreSQL]
    │                       │
    │ WebSocket             │ S3 SDK
    │ (progress)            │
    └───────────────────>   ├──────────>  [Cloudflare R2]
                            │
                            ├──────────>  [FFmpeg]
                            │              (video processing)
                            ├──────────>  [Stripe]
                            │              (payments)
                            ├──────────>  [Resend]
                            │              (email)
                            └──────────>  [OpenAI]
                                           (AI metadata)
```

## Client / Server / Shared Boundaries

### Client (`client/`)

- **Framework**: React 18 SPA (NOT SSR/SSG)
- **Router**: Wouter (client-side only)
- **Build**: Vite → `dist/public/`
- **State**: TanStack React Query (server state), local React state
- **UI**: Radix UI / shadcn/ui primitives, Tailwind CSS, Framer Motion
- **Entry**: `client/index.html` → `client/src/main.tsx` → `client/src/App.tsx`

### Server (`server/`)

- **Framework**: Express.js 4 (NOT Express 5)
- **Build**: esbuild → `dist/index.js`
- **Entry**: `server/index.ts`
- **Database**: Drizzle ORM → Neon PostgreSQL
- **Auth**: Passport.js (magic link, Google, Microsoft)

### Shared (`shared/`)

- **Schema**: Drizzle table definitions + Zod validation schemas
- **Time estimation**: Processing time calculator
- **Blog/feedback/support schemas**: Zod types shared between client and server

## Express Middleware Chain (order matters)

```
1. Stripe webhook          ← raw body, BEFORE parsers
2. JSON/URL body parsers   ← 10GB limit
3. Cookie parser
4. Passport initialization ← OAuth session support
5. Canonical domain redirect ← enforces cutmv.fulldigitalll.com
6. CORS + CSP headers
7. Request logging
8. API routes (auth, user, referral, credit, subscription)
9. Main routes (upload, processing, download, WebSocket)
10. API 404 handler
11. Static file serving / Vite dev server
12. Global error handler
```

## Key Server Modules

| Module           | File                                | Purpose                             |
| ---------------- | ----------------------------------- | ----------------------------------- |
| Main routes      | `routes.ts` (2,749 lines)           | Upload, processing, download, debug |
| Auth             | `auth-service.ts`, `auth-routes.ts` | Magic link + OAuth                  |
| Video processing | `enhanced-process.ts`               | FFmpeg orchestration                |
| FFmpeg progress  | `ffmpeg-progress.ts`                | Real-time progress via WebSocket    |
| Job manager      | `background-job-manager.ts`         | Job lifecycle + email notifications |
| Storage          | `r2-storage.ts`                     | Cloudflare R2 operations            |
| Database         | `storage.ts`                        | CRUD operations via Drizzle         |
| Email            | `email-service.ts`                  | Resend templates                    |
| Stripe           | `stripe-webhook.ts`                 | Webhook handler                     |
| Credits          | `services/credit-service.ts`        | Credit wallet logic                 |
| Subscriptions    | `services/subscription-service.ts`  | Stripe subscription management      |
| Referrals        | `services/referral-service.ts`      | Referral program                    |
| Download tokens  | `download-tokens.ts`                | Secure download links               |
| URL security     | `url-security.ts`                   | AES-256-CBC URL encryption          |
| Timeouts         | `timeout-config.ts`                 | Adaptive deadline system            |

## Data Flow: Video Processing

```
1. User uploads video via browser
   → Multer (memory buffer, up to 10GB)
   → R2 upload: user-{hash}/uploads/{timestamp}-{id}-{name}.mp4

2. User configures export options (cutdowns, GIFs, thumbnails, canvas)
   → Credit check (sufficient credits for selected exports)
   → Background job created in DB

3. Processing starts
   → Video downloaded from R2 to /tmp/ (FFmpeg needs local file)
   → Operations executed sequentially:
     - Each operation spawns FFmpeg child process
     - Progress file monitored every 200ms
     - WebSocket broadcasts progress to client

4. All outputs packaged
   → In-memory ZIP created via adm-zip
   → ZIP uploaded to R2: user-{hash}/exports/{name}.zip
   → Temp files cleaned up from /tmp/

5. Completion
   → Job status updated to "completed"
   → "Download ready" email sent via Resend
   → Secure download token generated (24h expiry)
   → Credits deducted from user wallet
```

## Database Entity Relationships

```
users ──1:N──> sessions
users ──1:N──> videos ──1:N──> clips
users ──1:N──> exports
users ──1:N──> background_jobs
users ──1:N──> email_deliveries
users ──1:N──> credit_transactions
users ──1:N──> referral_events (as referrer)
users ──1:N──> referral_events (as referred)
```

## Relationship to OpenClaw Cluster

CUTMV lives inside the OpenClaw monorepo at `packages/cutmv-app/`. This
enables the cluster to interact with CUTMV as a product to be improved,
marketed, and sold — but the cluster does NOT serve as CUTMV's compute
layer.

### What the cluster does for CUTMV

- **Code changes**: edit source, ship features, fix bugs, optimize UX
- **Marketing**: generate ad copy, build landing pages, test offers
- **Growth**: improve onboarding, optimize pricing, refine conversion
- **Ops**: monitor site health, patch issues, deploy changes
- **Analysis**: track metrics, analyze campaigns, measure retention

### What stays internal to CUTMV's own runtime

- Video upload handling and R2 storage
- FFmpeg processing (cutdowns, GIFs, thumbnails, Canvas loops)
- Background job execution and progress tracking
- ZIP packaging and download serving
- WebSocket progress broadcasting

These are product-level concerns. They run on CUTMV's own deployment
infrastructure (currently Railway), not on the OpenClaw cluster nodes.

The cluster may help _build and improve_ this processing code. It does
not _become_ the processing infrastructure.

See `fd/workspace/CLUSTER_PHILOSOPHY.md` for the full philosophy.

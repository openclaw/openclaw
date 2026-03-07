# CUTMV Feature Inventory

> Complete mapping of every user-facing feature to its implementation files.
> Package location: `packages/cutmv-app/`

---

## 1. Client Pages

| Page | Route | Purpose | File |
|------|-------|---------|------|
| Landing | `/` | Public marketing page, FAQ, CTA | `client/src/pages/landing.tsx` |
| App | `/app` | Main processing dashboard | `client/src/pages/app.tsx` |
| Dashboard | `/dashboard` | Export history, account overview | `client/src/pages/dashboard.tsx` |
| Login | `/login` | Magic link / code authentication | `client/src/pages/login.tsx` |
| Subscription | `/subscription` | Plan selection and management | `client/src/pages/subscription.tsx` |
| Profile | `/profile` | Account settings, payment methods | `client/src/pages/profile.tsx` |
| Referrals | `/referrals` | Referral dashboard and stats | `client/src/pages/referrals.tsx` |
| Referral Landing | `/referral/:code` | Public referral signup page | `client/src/pages/ReferralPage.tsx` |
| Support | `/support` | Contact form | `client/src/pages/SupportPage.tsx` |
| Blog Index | `/blog` | Article listing | `client/src/pages/BlogIndex.tsx` |
| Blog Post | `/blog/:slug` | Individual article | `client/src/pages/BlogPost.tsx` |
| Thank You | `/thank-you` | Payment confirmation | `client/src/pages/thank-you.tsx` |
| Legal | `/legal` | Legal information | `client/src/pages/legal.tsx` |
| Privacy | `/privacy` | Privacy policy | `client/src/pages/privacy.tsx` |
| Terms | `/terms` | Terms of service | `client/src/pages/terms.tsx` |
| Add Payment | `/add-payment-method` | Stripe card entry | `client/src/pages/add-payment-method.tsx` |
| 404 | `/*` | Not found fallback | `client/src/pages/not-found.tsx` |

---

## 2. Core Components

### Video Processing
| Component | Purpose | File |
|-----------|---------|------|
| VideoUpload | File upload with progress, resumable multipart, direct-to-R2 | `client/src/components/VideoUpload.tsx` |
| ProcessingControls | Aspect ratio, fade effects, export type toggles | `client/src/components/ProcessingControls.tsx` |
| TimestampInput | Manual timestamp entry with validation | `client/src/components/TimestampInput.tsx` |
| TimestampPreview | Visual timestamp range preview | `client/src/components/TimestampPreview.tsx` |
| ExportPreview | Export thumbnail/preview display | `client/src/components/ExportPreview.tsx` |
| TimeEstimationDisplay | Real-time processing time estimates | `client/src/components/TimeEstimationDisplay.tsx` |

### Payment & Billing
| Component | Purpose | File |
|-----------|---------|------|
| PricingCalculator | Dynamic pricing, promo codes, checkout initiation | `client/src/components/PricingCalculator.tsx` |
| CreditPurchase | Credit package selection | `client/src/components/CreditPurchase.tsx` |
| PaymentSuccess | Post-payment status and download links | `client/src/components/PaymentSuccess.tsx` |
| CreditBalance | User credit balance display | `client/src/components/referral/CreditBalance.tsx` |

### Referral System
| Component | Purpose | File |
|-----------|---------|------|
| ReferralDashboard | Referral management UI, stats, sharing | `client/src/components/referral/ReferralDashboard.tsx` |
| ReferralTracker | Tracks referral signup with context | `client/src/components/referral/ReferralTracker.tsx` |

### Layout & Navigation
| Component | Purpose | File |
|-----------|---------|------|
| DashboardLayout | Authenticated wrapper with sidebar/header | `client/src/components/DashboardLayout.tsx` |
| Header | Top nav bar with logo, menu, user dropdown | `client/src/components/Header.tsx` |
| Footer | Footer with links and copyright | `client/src/components/Footer.tsx` |
| ScrollToTop | Auto scroll-to-top on route change | `client/src/components/ScrollToTop.tsx` |
| BackToToolButton | Navigation helper | `client/src/components/BackToToolButton.tsx` |
| ProgressSteps | Multi-step progress indicator | `client/src/components/ProgressSteps.tsx` |

### Auth & User
| Component | Purpose | File |
|-----------|---------|------|
| AuthGuard | Authentication wrapper, login redirect | `client/src/components/AuthGuard.tsx` |
| OnboardingModal | First-time user setup (name, consent) | `client/src/components/OnboardingModal.tsx` |
| EmailCapture | Email collection for notifications | `client/src/components/EmailCapture.tsx` |

### Feedback & Engagement
| Component | Purpose | File |
|-----------|---------|------|
| FeedbackButton | Feedback submission button | `client/src/components/FeedbackButton.tsx` |
| FloatingFeedback | Floating feedback widget | `client/src/components/FloatingFeedback.tsx` |
| SocialProofBanner | Testimonial/social proof display | `client/src/components/SocialProofBanner.tsx` |

### Utility
| Component | Purpose | File |
|-----------|---------|------|
| ErrorBoundary | React error boundary for crash handling | `client/src/components/ErrorBoundary.tsx` |
| FaviconProvider | Dynamic favicon/page title | `client/src/components/FaviconProvider.tsx` |
| CookieConsent | Cookie consent banner | `client/src/components/CookieConsent.tsx` |

### UI Library (shadcn/ui)
47 base components in `client/src/components/ui/`: Button, Input, Card, Tabs, Badge, Alert, Dialog, Dropdown, Form, Label, Select, Textarea, Checkbox, Avatar, Breadcrumb, Calendar, Carousel, Chart, Collapsible, Context Menu, Drawer, Progress, Popover, Scroll Area, Sheet, Slider, Toggle, Tooltip, etc.

---

## 3. Custom Hooks

| Hook | Purpose | File |
|------|---------|------|
| useAuth | Auth state, session validation, logout | `client/src/hooks/useAuth.ts` |
| useAuthCheck | Silent auth monitoring on mount | `client/src/hooks/useAuthCheck.tsx` |
| useWebSocketProgress | Real-time WebSocket progress tracking | `client/src/hooks/useWebSocketProgress.ts` |
| useTimeEstimation | Processing time estimate calculation | `client/src/hooks/useTimeEstimation.ts` |
| useEmailVerification | Email validation (disposable/risky checks) | `client/src/hooks/useEmailVerification.ts` |
| useEmailDelivery | Background job management, welcome email | `client/src/hooks/useEmailDelivery.ts` |
| useOnboarding | First-time user setup modal | `client/src/hooks/useOnboarding.ts` |
| useToast | Toast notification system | `client/src/hooks/use-toast.ts` |
| useMobile | Responsive breakpoint detection | `client/src/hooks/use-mobile.tsx` |

---

## 4. Server API Endpoints

### Authentication (13 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| POST | `/api/auth/signin` | Request magic link | No | `server/auth-routes.ts` |
| GET | `/api/auth/verify` | Verify magic link token | No | `server/auth-routes.ts` |
| POST | `/api/auth/verify-code` | Verify 6-digit code | No | `server/auth-routes.ts` |
| POST | `/api/auth/logout` | Logout | Yes | `server/auth-routes.ts` |
| GET | `/api/auth/me` | Get current user | Yes | `server/auth-routes.ts` |
| POST | `/api/auth/complete-onboarding` | Complete setup | Yes | `server/auth-routes.ts` |
| GET | `/api/auth/callback` | OAuth callback | No | `server/auth-routes.ts` |

### Video Upload (8 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| POST | `/api/initiate-multipart-upload` | Start multipart upload | Yes | `server/routes.ts` |
| POST | `/api/complete-multipart-upload` | Finalize multipart upload | Yes | `server/routes.ts` |
| POST | `/api/abort-multipart-upload` | Cancel multipart upload | Yes | `server/routes.ts` |
| POST | `/api/initiate-upload` | Start chunked upload (legacy) | Yes | `server/routes.ts` |
| POST | `/api/upload-chunk` | Upload single chunk (legacy) | Yes | `server/routes.ts` |
| POST | `/api/finalize-upload` | Complete chunked upload (legacy) | Yes | `server/routes.ts` |
| POST | `/api/upload` | Single-file upload (legacy) | Yes | `server/routes.ts` |
| GET | `/api/videos/:id/preview` | Get video metadata | Yes | `server/routes.ts` |

### Video Processing (5 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| POST | `/api/process-with-realtime` | Start processing + WebSocket | Yes | `server/routes.ts` |
| POST | `/api/create-payment-session` | Credit check + start job | Yes | `server/routes.ts` |
| GET | `/api/processing-status/:videoId` | Poll processing status | Yes | `server/routes.ts` |
| POST | `/api/estimate-processing-time` | Get time estimate | Yes | `server/routes.ts` |
| POST | `/api/parse-timestamps` | Validate timestamp format | Yes | `server/routes.ts` |

### Downloads (4 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| GET | `/api/download/:filename` | Download single export | Yes | `server/routes.ts` |
| GET | `/api/secure-download/:token` | Time-limited download | No | `server/routes.ts` |
| GET | `/api/bulk-download/:sessionId` | Download all as ZIP | Yes | `server/routes.ts` |
| GET | `/api/can-bulk-download` | Check bulk permission | Yes | `server/routes.ts` |

### Payment & Billing (5 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| GET | `/api/pricing` | Get current pricing | Optional | `server/routes.ts` |
| POST | `/api/calculate-price` | Calculate total cost | Yes | `server/routes.ts` |
| GET | `/api/billing/payment-methods` | List payment methods | Yes | `server/routes.ts` |
| POST | `/api/billing/setup-intent` | Create Stripe setup intent | Yes | `server/routes.ts` |
| POST | `/api/webhooks/stripe` | Stripe webhook handler | No | `server/stripe-webhook.ts` |

### Credits (8 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| GET | `/api/credits/balance` | Get credit balance | Yes | `server/credit-routes.ts` |
| GET | `/api/credits/history` | Transaction history | Yes | `server/credit-routes.ts` |
| GET | `/api/credits/can-afford/:cost` | Affordability check | Yes | `server/credit-routes.ts` |
| POST | `/api/credits/pay-for-export` | Deduct credits | Yes | `server/credit-routes.ts` |
| POST | `/api/credits/first-export-bonus` | Grant first export bonus | Yes | `server/credit-routes.ts` |
| POST | `/api/credits/calculate-cost` | Cost with subscription | Yes | `server/credit-routes.ts` |
| POST | `/api/credits/purchase` | Stripe checkout for credits | Yes | `server/credit-routes.ts` |
| GET | `/api/credits/packages` | List credit packages | Yes | `server/credit-routes.ts` |

### Subscriptions (5 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| GET | `/api/subscription/plans` | List plans | No | `server/subscription-routes.ts` |
| GET | `/api/subscription/status` | User subscription | Yes | `server/subscription-routes.ts` |
| POST | `/api/subscription/create-checkout` | Create checkout | Yes | `server/subscription-routes.ts` |
| POST | `/api/subscription/cancel` | Cancel subscription | Yes | `server/subscription-routes.ts` |
| POST | `/api/subscription/reactivate` | Reactivate subscription | Yes | `server/subscription-routes.ts` |

### Background Jobs (4 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| GET | `/api/background-job/:sessionId` | Get job status | No | `server/routes.ts` |
| POST | `/api/background-job/:sessionId/cancel` | Cancel job | No | `server/routes.ts` |
| GET | `/api/job-status/:sessionId` | Get job progress | No | `server/routes.ts` |
| GET | `/api/session-status/:sessionId` | Get session status | No | `server/routes.ts` |

### Email & Notifications (5 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| POST | `/api/process-with-email` | Process with email delivery | Yes | `server/routes.ts` |
| POST | `/api/send-welcome-email` | Welcome email | Yes | `server/routes.ts` |
| POST | `/api/send-failure-notification` | Error notification | No | `server/routes.ts` |
| POST | `/api/send-manual-failure-email` | Manual failure email | No | `server/routes.ts` |
| POST | `/api/email/test` | Test email service | No | `server/routes.ts` |

### Debug & Diagnostics (11 endpoints) -- SECURITY CONCERN: most are unauthenticated
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| GET | `/api/test` | Health check | No | `server/routes.ts` |
| GET | `/api/health` | Comprehensive health | No | `server/routes.ts` |
| POST | `/api/upload-diagnostics` | Upload diagnostics | Yes | `server/routes.ts` |
| GET | `/api/upload-test` | Upload status | Yes | `server/routes.ts` |
| POST | `/api/r2-test` | R2 diagnostic | No | `server/routes.ts` |
| GET | `/api/r2-diagnostics/:sessionId` | R2 upload diag | Yes | `server/routes.ts` |
| GET | `/api/debug/jobs/:userEmail` | User jobs debug | No | `server/routes.ts` |
| GET | `/api/dashboard-debug` | Dashboard data debug | Yes | `server/routes.ts` |
| POST | `/api/test/promo-processing` | Test promo processing | No | `server/routes.ts` |
| POST | `/api/manual-trigger` | Manual job trigger | No | `server/routes.ts` |
| GET | `/api/job-monitor/status` | Job monitor status | No | `server/routes.ts` |

### Utilities (5 endpoints)
| Method | Path | Purpose | Auth | File |
|--------|------|---------|------|------|
| POST | `/api/suggest-metadata` | AI metadata suggestions | Yes | `server/routes.ts` |
| POST | `/api/validate-promo-code` | Verify promo code | No | `server/routes.ts` |
| POST | `/api/decrypt-session` | Decrypt session token | No | `server/routes.ts` |
| POST | `/api/generate-reuse-token` | Create reuse token | Yes | `server/routes.ts` |
| POST | `/api/decrypt-reuse-token` | Decrypt reuse token | No | `server/routes.ts` |

---

## 5. Server Modules

| Module | File | Purpose |
|--------|------|---------|
| Main routes | `server/routes.ts` (2,749 lines) | Upload, processing, download, debug |
| Auth service | `server/auth-service.ts` | Magic link + OAuth via Passport.js |
| Auth routes | `server/auth-routes.ts` | Auth API endpoints |
| Video processing | `server/enhanced-process.ts` | FFmpeg orchestration |
| FFmpeg progress | `server/ffmpeg-progress.ts` | Real-time FFmpeg progress + WebSocket |
| Accurate progress | `server/accurate-progress.ts` | Progress calculation methodology |
| Job manager | `server/background-job-manager.ts` | Job lifecycle + email notifications |
| Job failure monitor | `server/job-failure-monitor.ts` | Stalled/failed job detection |
| R2 storage | `server/r2-storage.ts` | Cloudflare R2 operations |
| Database CRUD | `server/storage.ts` | Drizzle ORM operations |
| Email service | `server/email-service.ts` | Resend email templates |
| Email verification | `server/email-verification.ts` | Disposable/risky email checks |
| Stripe webhook | `server/stripe-webhook.ts` | Stripe event handler |
| Credit service | `server/services/credit-service.ts` | Credit wallet logic |
| Subscription service | `server/services/subscription-service.ts` | Stripe subscription management |
| Referral service | `server/services/referral-service.ts` | Referral program |
| Promo codes | `server/services/promoCodeService.ts` | Promo code validation |
| Download tokens | `server/download-tokens.ts` | Secure download links (24h expiry) |
| URL security | `server/url-security.ts` | AES-256-CBC URL encryption |
| Timeout config | `server/timeout-config.ts` | Adaptive deadline system |
| Cloudflare queue | `server/cloudflare-queue.ts` | Queue processing integration |
| Blog service | `server/blog-service.ts` | Blog content management |

---

## 6. Shared Modules

| Module | File | Purpose |
|--------|------|---------|
| Schema | `shared/schema.ts` | Drizzle table definitions + Zod types |
| Time estimation | `shared/time-estimation.ts` | Processing time calculator |
| Feedback schema | `shared/feedback-schema.ts` | Feedback validation types |
| Support schema | `shared/support-schema.ts` | Support ticket types |
| Blog schema | `shared/blog-schema.ts` | Blog content types |

---

## 7. Database Tables

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `users` | User accounts | email, name, credits, subscriptionCredits, stripeCustomerId, referralCode |
| `sessions` | Login sessions | userId, token, expiresAt |
| `magicLinks` | Magic link tokens | email, token, code, expiresAt |
| `videos` | Uploaded videos | filename, r2Key, r2Url, size, duration, userEmail |
| `clips` | Video segments | videoId, startTime, endTime |
| `exports` | Generated exports | userId, videoName, exportType, filePath, status |
| `backgroundJobs` | Async processing | sessionId, videoId, status, progress, downloadPath |
| `emailDeliveries` | Email tracking | userEmail, emailType, status |
| `creditTransactions` | Credit ledger | userId, amount, type, description, expiresAt |
| `referralEvents` | Referral interactions | referrerId, referredId, eventType |
| `referralTracking` | Visit tracking | referralCode, visitorIp, sessionId |

---

## 8. Third-Party Integrations

| Integration | Purpose | Config |
|-------------|---------|--------|
| Stripe | Payments, subscriptions | `STRIPE_SECRET_KEY`, price IDs |
| Cloudflare R2 | Object storage | `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME` |
| Cloudflare Workers | Queue processing (optional) | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` |
| Neon PostgreSQL | Database | `DATABASE_URL` |
| Resend | Email delivery | `RESEND_API_KEY` |
| OpenAI | AI metadata suggestions | `OPENAI_API_KEY` |
| PostHog | Analytics | `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST` |
| Sentry | Error tracking | `SENTRY_DSN` |
| Google OAuth | Social login | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| Microsoft OAuth | Social login | `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` |

---

## 9. Feature Statistics

| Category | Count |
|----------|-------|
| Client pages | 17 |
| Core components | 28 |
| UI library components | 47 |
| Custom hooks | 9 |
| API endpoints | 64+ |
| Server modules | 22 |
| Shared modules | 5 |
| Database tables | 11 |
| Third-party integrations | 10 |
| WebSocket message types | 6 |

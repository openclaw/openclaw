---
name: nextjs-saas
description: Next.js SaaS template principles. Auth, payments, email.
---

# Next.js SaaS Template

## Tech Stack

| Component | Technology |
|-----------|------------|
| Framework | Next.js 14 (App Router) |
| Auth | NextAuth.js v5 |
| Payments | Stripe |
| Database | PostgreSQL + Prisma |
| Email | Resend |
| UI | Tailwind (ASK USER: shadcn/Headless UI/Custom?) |

---

## Directory Structure

```
project-name/
├── prisma/
├── src/
│   ├── app/
│   │   ├── (auth)/      # Login, register
│   │   ├── (dashboard)/ # Protected routes
│   │   ├── (marketing)/ # Landing, pricing
│   │   └── api/
│   │       ├── auth/[...nextauth]/
│   │       └── webhooks/stripe/
│   ├── components/
│   │   ├── auth/
│   │   ├── billing/
│   │   └── dashboard/
│   ├── lib/
│   │   ├── auth.ts      # NextAuth config
│   │   ├── stripe.ts    # Stripe client
│   │   └── email.ts     # Resend client
│   └── config/
│       └── subscriptions.ts
└── package.json
```

---

## SaaS Features

| Feature | Implementation |
|---------|---------------|
| Auth | NextAuth + OAuth |
| Subscriptions | Stripe Checkout |
| Billing Portal | Stripe Portal |
| Webhooks | Stripe events |
| Email | Transactional via Resend |

---

## Database Schema

| Model | Fields |
|-------|--------|
| User | id, email, stripeCustomerId, subscriptionId |
| Account | OAuth provider data |
| Session | User sessions |

---

## Environment Variables

| Variable | Purpose |
|----------|---------|
| DATABASE_URL | Prisma |
| NEXTAUTH_SECRET | Auth |
| STRIPE_SECRET_KEY | Payments |
| STRIPE_WEBHOOK_SECRET | Webhooks |
| RESEND_API_KEY | Email |

---

## Setup Steps

1. `npx create-next-app {{name}} --typescript --tailwind --app`
2. Install: `npm install next-auth @auth/prisma-adapter stripe resend`
3. Setup Stripe products/prices
4. Configure environment
5. `npm run db:push`
6. `npm run stripe:listen` (webhooks)
7. `npm run dev`

---

## Best Practices

- Route groups for layout separation
- Stripe webhooks for subscription sync
- NextAuth with Prisma adapter
- Email templates with React Email

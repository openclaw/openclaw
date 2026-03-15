# Radar Meseriași Context

## Product summary

Radar Meseriași is a marketplace for homeowners and craftsmen. The platform coordinates job creation, bid review, messaging, verification, and future payment flows inside a trust-sensitive local services product.

## Roles

- Homeowner
- Craftsman
- Admin
- Support operator
- External system integration

## Core flows

- homeowner creates and manages a job
- craftsmen discover nearby jobs and submit bids
- owners and craftsmen exchange messages tied to a relationship or job
- profiles and reviews build trust and reputation
- OTP-based signup and verification establish account trust
- webhooks and provider integrations synchronize external events

## Architecture summary

- Next.js App Router
- React + Tailwind UI
- Supabase Auth
- PostgreSQL
- Row Level Security
- Twilio SMS OTP
- Vercel
- planned or partial Stripe workflows

## Known security priorities

1. Auth bypass
2. Authorization / IDOR
3. RLS policy gaps
4. Admin privilege escalation
5. OTP abuse / replay / enumeration
6. Webhook verification issues
7. XSS / unsafe rendering
8. Sensitive data exposure
9. Rate limiting gaps
10. Input validation issues

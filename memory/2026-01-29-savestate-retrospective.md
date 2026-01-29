# SaveState Cloud Storage Gate — Retrospective

**Date:** January 29, 2026
**Issue:** Cloud storage (S3/R2/B2) was accessible to free users despite being a Pro feature
**Resolution:** v0.4.0 released with server-mediated cloud storage

---

## What Happened

The SaveState pricing page clearly stated:
- **Free**: Local storage only
- **Pro ($9/mo)**: Cloud storage (10GB)

But the CLI code allowed anyone to configure their own S3/R2 credentials directly:
```bash
savestate config --set storage.type=s3
savestate config --set storage.options.bucket=my-bucket
```

This was a **pricing enforcement gap** — the feature existed in code but wasn't gated.

---

## Root Cause Analysis

### 1. Speed Over Process
SaveState was built in ~12 hours (Jan 27). The rush to ship meant:
- Features were built without checking pricing alignment
- No checklist for "is this feature gated correctly?"
- README documented S3/R2 as available to everyone

### 2. "Build First, Gate Later" Mentality  
The S3 storage backend was built as a technical feature, not a business feature. The thinking was:
- "Let's build the capability"
- "We'll add subscription checks later"
- "Later" never came until David noticed

### 3. No Pricing/Feature Matrix
There was no single document mapping:
- Free features ↔ code paths (no gates)
- Pro features ↔ code paths (subscription check required)

This made it easy to miss enforcement.

### 4. Client-Side Trust
Original implementation trusted the client:
- User provides their own S3 credentials
- CLI connects directly to their bucket
- No server verification = no enforcement

---

## How We Fixed It

**Option A (implemented):** Server-mediated cloud storage
- Removed direct S3/R2/B2 from `resolveStorage()`
- New `savestate cloud push/pull/list` commands
- Commands call SaveState API which verifies subscription
- API issues presigned URLs only for Pro/Team users
- User never has direct bucket access

This is **server-side enforcement** — can't be bypassed by editing source.

---

## Prevention: Checklist for Future Launches

### Pre-Launch Feature Audit

Before shipping any product, create a **Feature Gate Matrix**:

| Feature | Tier | Gate Location | Enforcement |
|---------|------|---------------|-------------|
| Local storage | Free | None needed | N/A |
| Cloud storage | Pro | API presigned URLs | Server-side |
| Scheduled backups | Pro | schedule.ts | Server-side |
| Multiple adapters | Pro | ??? | ??? |

Every row must have:
- ✅ Gate location (which file/function)
- ✅ Enforcement type (client/server)
- ✅ Server-side for anything paid

### Code Review Checklist

When adding features, ask:
1. [ ] Is this feature free or paid?
2. [ ] If paid, where is the gate?
3. [ ] Is the gate server-side (can't be bypassed)?
4. [ ] Does the README match the pricing page?
5. [ ] Does the code match both?

### Pricing/Code Sync

- **Pricing page** is source of truth for what's free vs paid
- **Code** must enforce this
- **README/docs** must reflect this
- All three must match — audit before launch

---

## Lessons Learned

1. **Speed kills (pricing).** Rushing to ship without a feature gate audit = giving away paid features.

2. **"Build now, gate later" is debt.** Gate at build time, not as an afterthought.

3. **Client-side gates are theater.** Open source code can be patched. Real enforcement = server-side.

4. **BYOS (Bring Your Own Storage) breaks SaaS.** If users provide their own credentials, you can't meter or gate. Managed storage gives control.

5. **Audit against the pricing page.** Before launch, open the pricing page and check every feature against the code.

---

## Action Items

- [x] Fix SaveState cloud storage (v0.4.0)
- [ ] Create Feature Gate Matrix template for DBH Ventures
- [ ] Add "Pricing Alignment" section to Incubation Template
- [ ] Audit MeshGuard for similar issues
- [ ] Add pre-launch checklist to Vikunja template

---

*This retrospective is part of DBH Ventures process improvement.*

# CUTMV Deployment Guide

## Quick Start

1. **Configure Secrets in Replit**
   ```
   STRIPE_SECRET_KEY=sk_live_...
   R2_ACCESS_KEY_ID=...
   R2_SECRET_ACCESS_KEY=...
   R2_ENDPOINT=https://[account_id].r2.cloudflarestorage.com
   R2_BUCKET_NAME=cutmv
   R2_ACCOUNT_ID=...
   ```

2. **Database Setup (Optional)**
   - If using PostgreSQL, run `database-reset.sql`
   - Otherwise, in-memory storage will be used automatically

3. **Deploy**
   - Project is ready for Replit Autoscale deployment
   - All dependencies are configured
   - File cleanup ensures optimal deployment size

## Project Status

✅ **Ready for Production**
- Project size: 60MB (well under 8GB limit)
- R2 storage configured with 29-day universal retention protocol
- Complete fallback system for local storage
- All non-essential files removed

✅ **Features Complete**
- Video upload and processing (up to 10GB files)
- Multiple export formats (clips, GIFs, thumbnails, Canvas)
- Stripe payment integration with STAFF25 promo code
- Cloudflare R2 cloud storage with automatic cleanup

## File Structure After Cleanup

```
CUTMV/
├── client/          # React frontend
├── server/          # Express backend
├── shared/          # Shared schemas and types
├── uploads/         # Clean directory with .gitkeep files
├── attached_assets/ # Essential screenshots only
├── CHANGELOG.md     # Complete project history
├── database-reset.sql # Database cleanup script
└── DEPLOYMENT.md    # This file
```

## Monitoring

- R2 storage usage: Monitor via Cloudflare dashboard
- File cleanup: Universal 29-day retention for all exports
- Error handling: Graceful fallback to local storage
- Database: Clean schema with R2 integration fields

---

*Ready for deployment - January 19, 2025*
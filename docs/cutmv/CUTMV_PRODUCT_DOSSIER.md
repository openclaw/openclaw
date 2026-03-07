# CUTMV Product Dossier

## What It Is

CUTMV is a music-video-focused SaaS tool that automates the creation of derivative content from uploaded music videos. Users upload a source video, specify timestamps and desired export types, and receive a processed ZIP package delivered via email download link.

## Who It Serves

- **Music artists and managers** who need cutdowns, GIFs, and thumbnails for social media promotion
- **Music video directors and editors** who need to quickly generate derivative formats
- **Record labels and distributors** who need standardized exports (Spotify Canvas loops, social media clips)
- **Content creators** who work with music video footage

## Export Types

| Format | Description | Specs |
|--------|-------------|-------|
| Cutdowns | Video clips at user-specified timestamps | 16:9 or 9:16, fade effects, letterbox removal |
| GIF Packs | 5-10 GIFs evenly spaced across video | 480px wide, 15fps, 6s each |
| Thumbnails | 5-10 JPEG still frames | 1280x720 |
| Canvas (Spotify) | Looping videos for Spotify | 4s fwd + 4s rev = 8s, 1080x1920, 23.976fps |

## Monetization Model

### Subscription Tiers
| Plan | Price | Monthly Credits | Bulk Download |
|------|-------|----------------|---------------|
| Starter | $10/mo | 1,000 | No |
| Pro | $25/mo | 3,000 | Yes |
| Enterprise | $75/mo | 10,000 | Yes |

### Credit Costs
| Export Type | Credits |
|-------------|---------|
| Cutdown | 50 |
| GIF Pack | 90 |
| Thumbnail Pack | 90 |
| Canvas Pack | 225 |

### Additional Revenue
- Credit purchases: $10 = 1,000 credits
- Non-subscribers pay 2x credit cost (subscriber discount = 50%)
- Referral program: credits awarded for successful referrals

## Strengths

1. **Working production SaaS** — deployed, billing active, users processing videos
2. **FFmpeg pipeline is well-engineered** — real-time progress, adaptive timeouts, stall detection
3. **No local disk dependency** — pure R2 cloud storage architecture
4. **Multiple auth methods** — magic link, Google, Microsoft OAuth
5. **Credit system is flexible** — dual-credit model enables both subscription and pay-per-use
6. **Existing brand infrastructure** in OpenClaw monorepo (data, agents, gateway, remotion-engine)

## Weaknesses

1. **Monolithic server code** — 2,749-line routes.ts needs decomposition
2. **Security gaps** — unauthenticated debug endpoints, hardcoded encryption fallback
3. **No structured logging** — emoji console.log throughout
4. **Promo codes in-memory only** — lost on restart
5. **No rate limiting** on auth endpoints
6. **Heavy screenshot assets** — 100+ PNGs in client/public

## Opportunities

1. **Remotion integration** — `@openclaw/remotion-engine` could generate video previews or enhanced exports
2. **OpenClaw gateway routing** — could serve as an OpenClaw product accessible via agent commands
3. **API product** — the processing pipeline could be exposed as a REST API for B2B
4. **Batch processing** — enterprise customers could submit batch jobs
5. **Template system** — pre-built export templates for common use cases

## How It Fits into Full Digital and OpenClaw

CUTMV is one of Full Digital's core SaaS products. Within the OpenClaw ecosystem:
- **Gateway routing** already configured (`gateway/bindings/cutmv.json`)
- **Agent personas** already defined (cutmv-growth, cutmv-ops, cutmv-support)
- **Brand identity** already in `data/brands/cutmv/`
- **Motion specs** already in `data/datasets/cutmv/`
- **Remotion engine** already at `packages/remotion-engine/`

The CUTMV app itself was the missing piece — now at `packages/cutmv-app/`.

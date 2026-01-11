# Long-term Memory

## Infrastructure
- **Current Server**: Synology NAS at 192.168.4.84
  - Runs: Plex, Radarr, Sonarr, Home Assistant, Couch Potato
  - Current home for media and automation services
- **New Brain**: Mac mini M4 Pro (ordered Jan 4, 2026)
  - 14-core CPU, 20-core GPU, 64GB RAM, 1TB SSD
  - Will eventually host migrated services from Synology
  - My future primary compute platform
- **Network**: 192.168.4.x subnet
  - Hue Bridge: 192.168.4.95

## Family
- **Home**: 79 Grant Street, Lexington, MA
- David = "Dad" when kids are around (Kate, Claire, Samuel)
- Kate flies back to Regent: Thu Jan 9, 5pm Breeze PVD→ORF direct (has TSA Pre)
- David = "David" in other contexts
- DOB: August 17, 1981 (44 years old)

## David's Work
- **DBH Ventures** — Primary (timespent.xyz venture studio)
- **One Point Partners** — Part-time partner (onepoint-partners.com) — M365 account
- **Email accounts**:
  - dbh.today@gmail.com (personal Google) ✅
  - db@lovemolly.app (work Google - Molly) ✅
  - dhurley@onepoint-partners.com (M365 - One Point) ⏳ pending Azure setup

## Etsy Shops (AI Agent-Operated)

### Patterns4Printing (Lisbeth)
- **Shop ID**: 41917012
- **Operator**: Lisbeth (early AI agent)
- **Products**: Digital pattern prints for fabric, wallpaper, crafts
- **URL**: patterns4printing.etsy.com
- **Stats**: ~119 listings, ~43 sales, 14 favorites

### Custom Canvas Curators (Avery Thompson)
- **Shop ID**: 41966184
- **Operator**: Avery Thompson (AI agent)
- **Products**: Digital art, canvas paintings/prints in various artist styles
- **URLs**: customcanvascurators.etsy.com, customcanvascurators.com, + Shopify
- **Stats**: ~1169 listings, ~583 sales, 143 favorites, 4.8★ (26 reviews)
- **Accepts custom requests**: Yes

**Weekly summary**: Both shops, Sundays at 6 PM via heartbeat

## Personal CRM (ppl.gift)
- **URL**: https://ppl.gift (Monica CRM fork)
- **Hosting**: Digital Ocean droplet, auto-deploys from GitHub
- **Purpose**: Track relationships with people closest to David — THIS IS THE PRIMARY PEOPLE DATABASE
- **Key Contacts**:
  - Erin Hurley (687400) - Wife ⭐ - Birthday Dec 31
  - Kate Hurley (687401) - Daughter - Birthday May 22
  - Claire Hurley (687402) - Daughter - Birthday Aug 15
  - Samuel Hurley (687403) - Son - Birthday Sept 23
  - DB Hurley (687464) - David himself (is_me: true) - Birthday Aug 17
- **Birthday Alerts**: Check daily via heartbeat, alert 3 days before

### ppl.gift Workflow — IMPORTANT
When I learn something about a person:
1. **Save it as a note** in ppl.gift, not just in local memory files
2. This way David can see everything I know about people
3. Use emoji prefixes for categories:
   - 🍹 COCKTAIL: for drink recipes/ratings
   - 🎁 GIFT IDEA: for gift suggestions
   - 💡 PREFERENCE: for likes/dislikes
   - 📝 NOTE: for general observations

### Erin's Cocktail Tracking
- Loves specialty cocktails
- David maintains extensive home bar
- Track cocktails with ratings (X/10) so he knows what to make again
- Format: "🍹 COCKTAIL: [Name] / Rating: X/10 / Notes: [feedback]"

## Journal
- **Media archive**: The `archive-media` cron archives inbound media into the Steve_Journal media repository.
- **ppl.gift journal endpoints**: Use ppl.gift journal entries for notable events/notes (separate from media archiving).

## David's Sleep/Health Profile
- **ADRB1 gene**: Natural short sleeper (4-5 hours optimal)
- **ADHD**: Caffeine = focusing effect (not stimulating), uses it late evening
- **Modified Uberman schedule**:
  - Main sleep: 12:40-5:20 AM (core ~5h)
  - 3x 20min naps throughout day
  - Variation: sometimes 1:30/2:00 AM - 5:40/6:00 AM
- **Active hours**: Much later evenings, earlier mornings than typical
- **Quiet time for notifications**: 1:00-5:00 AM only

### Comprehensive Health Data Analysis (2022-2026)
- **Sleep duration**: 5.16h average over 911 nights, recent 4.83h
- **Sleep efficiency**: 28min deep + 90min REM = optimal ADRB1 pattern  
- **Heart rate**: RHR 52.6 BPM, sleep minimum 37-43 BPM during deep phases
- **HRV**: 50.7ms average (normal recovery capacity)
- **Apple Watch alerts**: <40 BPM triggers false alarms, 37-43 is normal for his physiology
- **Validation**: 3+ years of consistent data confirms modified Uberman schedule optimal
- **Status**: Excellent health, textbook ADRB1 gene expression, no sleep debt
## One Point Partners
- **Website**: onepoint-partners.com
- **CRM**: Twenty at api.mollified.app (frontend: onepoint.mollified.app)
- **Focus**: Senior living consulting/advisory

### Team
- **Toby Shea** — CEO, Founding Partner (tshea@onepoint-partners.com) — ppl.gift ID: 687527
- **David Hurley** — Partner (dhurley@onepoint-partners.com)
- **Lea Ann Hodson** — Team member (lhodson@onepoint-partners.com)

## Ongoing Tasks

### Upstream Sync (cron: every 4h)
- Remote: `upstream` → clawdbot/clawdbot.git
- Auto-fetch and merge, notify David of results
- Keep our AGENTS.md customizations on conflicts

## Cron Jobs (Active)

| Job | Schedule | Purpose |
|-----|----------|---------|
| crypto-alert-check | Every 15 min | Check price alerts, notify users |
| daily-verse | 6:05 AM ET | Bible verse to David via WhatsApp |
| sync-skills | Every 4h (0 */4) | Pull upstream + push changes, notify on merges |
| kate-airport-thu | Thu Jan 9, 1:30pm | One-time reminder for Kate's flight |

**Note:** `sync-skills` handles BOTH upstream sync AND local pushes via `/Users/dbhurley/clawd/scripts/sync-skills.sh`

## Rules

- **Do NOT auto-publish skills to ClawdHub** — only publish when explicitly asked
- **People memory**: NEVER write to `people/*.md`; always write people notes to ppl.gift
- **Journal**: Media goes to Steve_Journal archive; notable entries go to ppl.gift journal endpoints

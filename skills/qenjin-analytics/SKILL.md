---
name: qenjin-analytics
description: Plausible analytics — site traffic, top pages, sources, goals, UTM breakdown.
user-invocable: true
disable-model-invocation: false
triggers:
  - /analytics
  - /traffic
  - /stats
---

# qenjin-analytics

Plausible Analytics queries via REST API.

Base URL: `https://analytics.huda20.fun/api/v1`
Auth: Bearer token from env var `PLAUSIBLE_API_KEY`.
Sites: `hudafilm.com`, `growmind.space`, `qenjin.io` — default to all three unless specified.

## On `/analytics [site] [period]`

Traffic overview. Visitors, pageviews, bounce rate, visit duration.
Periods: `day`, `7d`, `30d`, `month`, `6mo`, `12mo`. Default: `7d`.

```bash
python3 -c "
import json, subprocess, os, sys
from datetime import datetime

TOKEN = os.environ.get('PLAUSIBLE_API_KEY', '')
BASE = 'https://analytics.huda20.fun/api/v1'

sites_map = {
    'huda': 'hudafilm.com',
    'hudafilm': 'hudafilm.com',
    'growmind': 'growmind.space',
    'qenjin': 'qenjin.io',
}
args = sys.argv[1:]
site_arg = args[0] if args else 'all'
period = args[1] if len(args) > 1 else '7d'

sites = list(sites_map.values()) if site_arg == 'all' else [sites_map.get(site_arg, site_arg)]

for site in sites:
    metrics = 'visitors,pageviews,bounce_rate,visit_duration'
    url = f'{BASE}/stats/aggregate?site_id={site}&period={period}&metrics={metrics}'
    r = subprocess.run(['curl', '-s', '-H', f'Authorization: Bearer {TOKEN}', url], capture_output=True, text=True)
    data = json.loads(r.stdout).get('results', {})
    visitors = data.get('visitors', {}).get('value', 0)
    pageviews = data.get('pageviews', {}).get('value', 0)
    bounce = data.get('bounce_rate', {}).get('value', 0)
    duration = data.get('visit_duration', {}).get('value', 0)
    print(f'{site} ({period}):')
    print(f'  Visitors: {visitors}')
    print(f'  Pageviews: {pageviews}')
    print(f'  Bounce: {bounce}%')
    print(f'  Avg duration: {duration}s')
" <site> <period>
```

## On `/analytics top [site] [period]`

Top pages by visitors.

```bash
python3 -c "
import json, subprocess, os, sys

TOKEN = os.environ.get('PLAUSIBLE_API_KEY', '')
BASE = 'https://analytics.huda20.fun/api/v1'

site = sys.argv[1] if len(sys.argv) > 1 else 'hudafilm.com'
period = sys.argv[2] if len(sys.argv) > 2 else '7d'

url = f'{BASE}/stats/breakdown?site_id={site}&period={period}&property=event:page&metrics=visitors,pageviews&limit=10'
r = subprocess.run(['curl', '-s', '-H', f'Authorization: Bearer {TOKEN}', url], capture_output=True, text=True)
results = json.loads(r.stdout).get('results', [])

print(f'Top pages — {site} ({period}):')
for p in results[:10]:
    page = p.get('page', '?')
    visitors = p.get('visitors', 0)
    views = p.get('pageviews', 0)
    print(f'  {page}: {visitors} visitors / {views} views')
" <site> <period>
```

## On `/analytics sources [site] [period]`

Traffic sources breakdown — referrers, UTM campaigns, direct vs organic.

```bash
python3 -c "
import json, subprocess, os, sys

TOKEN = os.environ.get('PLAUSIBLE_API_KEY', '')
BASE = 'https://analytics.huda20.fun/api/v1'

site = sys.argv[1] if len(sys.argv) > 1 else 'hudafilm.com'
period = sys.argv[2] if len(sys.argv) > 2 else '30d'

url = f'{BASE}/stats/breakdown?site_id={site}&period={period}&property=visit:source&metrics=visitors&limit=15'
r = subprocess.run(['curl', '-s', '-H', f'Authorization: Bearer {TOKEN}', url], capture_output=True, text=True)
results = json.loads(r.stdout).get('results', [])

print(f'Sources — {site} ({period}):')
for s in results[:15]:
    source = s.get('source', 'Direct/None')
    visitors = s.get('visitors', 0)
    print(f'  {source}: {visitors}')
" <site> <period>
```

## On `/analytics utm [site] [period]`

UTM campaign breakdown. Which campaigns drove traffic.

```bash
python3 -c "
import json, subprocess, os, sys

TOKEN = os.environ.get('PLAUSIBLE_API_KEY', '')
BASE = 'https://analytics.huda20.fun/api/v1'

site = sys.argv[1] if len(sys.argv) > 1 else 'hudafilm.com'
period = sys.argv[2] if len(sys.argv) > 2 else '30d'

url = f'{BASE}/stats/breakdown?site_id={site}&period={period}&property=visit:utm_campaign&metrics=visitors,pageviews&limit=20'
r = subprocess.run(['curl', '-s', '-H', f'Authorization: Bearer {TOKEN}', url], capture_output=True, text=True)
results = json.loads(r.stdout).get('results', [])

if not results:
    print(f'No UTM data for {site} in {period}.')
else:
    print(f'UTM campaigns — {site} ({period}):')
    for c in results[:20]:
        campaign = c.get('utm_campaign', '-')
        visitors = c.get('visitors', 0)
        views = c.get('pageviews', 0)
        print(f'  {campaign}: {visitors} visitors / {views} views')
" <site> <period>
```

## On `/analytics goals [site]`

Goal completions — form fills, CTA clicks, conversions.

```bash
python3 -c "
import json, subprocess, os, sys

TOKEN = os.environ.get('PLAUSIBLE_API_KEY', '')
BASE = 'https://analytics.huda20.fun/api/v1'

site = sys.argv[1] if len(sys.argv) > 1 else 'hudafilm.com'
period = '30d'

url = f'{BASE}/stats/breakdown?site_id={site}&period={period}&property=event:goal&metrics=visitors,events&limit=20'
r = subprocess.run(['curl', '-s', '-H', f'Authorization: Bearer {TOKEN}', url], capture_output=True, text=True)
results = json.loads(r.stdout).get('results', [])

if not results:
    print(f'No goals tracked for {site}. Set up goals in Plausible dashboard.')
else:
    print(f'Goal completions — {site} (30d):')
    for g in results[:20]:
        goal = g.get('goal', '-')
        visitors = g.get('visitors', 0)
        events = g.get('events', 0)
        print(f'  {goal}: {visitors} unique / {events} total')
" <site>
```

## Rules

- Numbers first. No narrative.
- Default period: `7d` for overviews, `30d` for sources/UTM.
- Site shorthand: `huda`/`hudafilm` → `hudafilm.com`, `growmind` → `growmind.space`, `qenjin` → `qenjin.io`.
- API errors: `Plausible error — check PLAUSIBLE_API_KEY and server.`
- Never expose API keys in replies.
- If Plausible is unreachable: `Analytics server offline — check https://analytics.huda20.fun`
- "Done." is a complete response when appropriate.

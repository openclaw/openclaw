#!/usr/bin/env python3
"""Update Shopify landing pages with hero banner HTML."""
import os, json, time, requests

# Load env
env = {}
with open('/home/kingler/openclaw-mabos/.env') as f:
    for line in f:
        if '=' in line and not line.startswith('#'):
            k, v = line.strip().split('=', 1)
            env[k] = v

STORE = env['SHOPIFY_STORE']
TOKEN = env['SHOPIFY_ACCESS_TOKEN']
REST_URL = f'https://{STORE}/admin/api/2024-01'
HEADERS = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': TOKEN,
}

# Load CDN manifest
MANIFEST_PATH = '/home/kingler/openclaw-mabos/extensions/mabos/assets/hero-banners/banner-cdn-manifest.json'
with open(MANIFEST_PATH) as f:
    manifest = json.load(f)

# Collection → hero banner slug mapping (from COLLECTIONS in vividwalls-collections.ts)
COLLECTION_HERO_BANNERS = {
    'echoes': 'hero-banner-echoes',
    'emergence': 'hero-banner-emergence',
    'fractal': 'hero-banner-fractal-double-red',
    'intersecting-perspectives': 'hero-banner-intersecting-perspectives-no2',
    'mosaic': 'hero-banner-mosaic',
    'space-form': 'hero-banner-space-form-no1',
    'symmetry': 'hero-banner-dark-kimono',
}

COLLECTION_DISPLAY_NAMES = {
    'echoes': 'Chromatic Echoes',
    'emergence': 'Shape Emergence',
    'fractal': 'Fractal Color',
    'intersecting-perspectives': 'Intersecting Perspectives',
    'mosaic': 'Black Mosaic',
    'space-form': 'Space & Form',
    'symmetry': 'Geometric Symmetry',
}

# Landing page → collection mapping
# Format: (page_id, collection_slug)
LANDING_PAGES = [
    # Curated landing pages
    (155592917279, 'echoes'),
    (155592950047, 'emergence'),
    (155592982815, 'fractal'),
    (155593015583, 'intersecting-perspectives'),
    (155593048351, 'mosaic'),
    (155593081119, 'space-form'),
    (155593113887, 'symmetry'),
    # Homeowner landing pages
    (155593277727, 'echoes'),
    (155593310495, 'emergence'),
    (155593343263, 'fractal'),
    (155593376031, 'intersecting-perspectives'),
    (155593408799, 'mosaic'),
    (155593441567, 'space-form'),
    (155593474335, 'symmetry'),
    # Designer landing pages
    (155593507103, 'echoes'),
    (155593539871, 'emergence'),
    (155593572639, 'fractal'),
    (155593605407, 'intersecting-perspectives'),
    (155593638175, 'mosaic'),
    (155593670943, 'space-form'),
    (155593703711, 'symmetry'),
    # Hospitality landing pages
    (155593736479, 'echoes'),
    (155593769247, 'emergence'),
    (155593802015, 'fractal'),
    (155593834783, 'intersecting-perspectives'),
    (155593867551, 'mosaic'),
    (155593900319, 'space-form'),
    (155593933087, 'symmetry'),
]

# Broader segment pages (prepend banner to existing content)
SEGMENT_PAGES = [
    (155276149023, 'echoes', 'home-art'),           # Art for Your Home
    (155276214559, 'mosaic', 'new-homeowner-art'),   # Art for New Homeowners
    (155276116255, 'intersecting-perspectives', 'commercial-art'),  # Art for Commercial Spaces
    (155276181791, 'space-form', 'hospitality-art'), # Art for Hospitality
]


def get_banner_html(collection_slug, full_width=True):
    """Generate hero banner HTML for a collection."""
    banner_slug = COLLECTION_HERO_BANNERS[collection_slug]
    banner = manifest.get(banner_slug, {})
    cdn_url = banner.get('cdnUrl', '')
    display_name = COLLECTION_DISPLAY_NAMES.get(collection_slug, collection_slug.title())

    if not cdn_url:
        print(f'  WARNING: No CDN URL for {banner_slug}')
        return None

    return f'''<div style="width:100%;margin:0 auto 24px;">
  <img src="{cdn_url}" alt="{display_name} Collection — VividWalls Hero Banner" style="width:100%;height:auto;display:block;border-radius:4px;" loading="lazy" width="1280" height="400">
</div>'''


def update_page(page_id, body_html):
    """Update a Shopify page's body_html via REST API."""
    url = f'{REST_URL}/pages/{page_id}.json'
    payload = {'page': {'id': page_id, 'body_html': body_html}}
    r = requests.put(url, headers=HEADERS, json=payload)
    if r.status_code == 200:
        return True
    else:
        print(f'  ERROR: {r.status_code} {r.text[:200]}')
        return False


def get_page(page_id):
    """Get a Shopify page's current content."""
    url = f'{REST_URL}/pages/{page_id}.json'
    r = requests.get(url, headers=HEADERS)
    if r.status_code == 200:
        return r.json().get('page', {})
    return {}


# ── PHASE 1: Update segmented landing pages ──
print('Phase 1: Updating 28 segmented landing pages...')
print('=' * 60)

success = 0
failed = 0

for page_id, collection_slug in LANDING_PAGES:
    banner_html = get_banner_html(collection_slug)
    if not banner_html:
        failed += 1
        continue

    page = get_page(page_id)
    title = page.get('title', f'Page {page_id}')
    print(f'  [{success+failed+1}/28] {title}')

    if update_page(page_id, banner_html):
        success += 1
    else:
        failed += 1

    time.sleep(0.3)

print(f'\nSegmented pages: {success} updated, {failed} failed')

# ── PHASE 2: Update broader segment pages (prepend banner) ──
print('\nPhase 2: Updating 4 broader segment pages...')
print('=' * 60)

for page_id, collection_slug, handle in SEGMENT_PAGES:
    banner_html = get_banner_html(collection_slug)
    if not banner_html:
        print(f'  SKIP: {handle} (no banner)')
        continue

    page = get_page(page_id)
    existing_html = page.get('body_html', '') or ''
    title = page.get('title', handle)

    # Only prepend if banner not already present
    if 'Hero Banner' in existing_html:
        print(f'  SKIP: {title} (banner already present)')
        continue

    new_html = banner_html + '\n' + existing_html
    print(f'  Updating: {title}')

    if update_page(page_id, new_html):
        print(f'  SUCCESS: {title}')
    else:
        print(f'  FAILED: {title}')

    time.sleep(0.3)

print('\n' + '=' * 60)
print('All landing pages updated!')

#!/usr/bin/env python3
"""Upload resized hero banners to Shopify CDN via staged uploads."""
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
GQL_URL = f'https://{STORE}/admin/api/2024-01/graphql.json'
HEADERS = {'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN}

RESIZED_DIR = '/home/kingler/openclaw-mabos/extensions/mabos/assets/hero-banners/resized'
MANIFEST_PATH = '/home/kingler/openclaw-mabos/extensions/mabos/assets/hero-banners/banner-cdn-manifest.json'

manifest = {}
if os.path.exists(MANIFEST_PATH):
    with open(MANIFEST_PATH) as f:
        manifest = json.load(f)

def save_manifest():
    with open(MANIFEST_PATH, 'w') as f:
        json.dump(manifest, f, indent=2)

def gql(query, variables=None):
    payload = {'query': query}
    if variables:
        payload['variables'] = variables
    r = requests.post(GQL_URL, headers=HEADERS, json=payload)
    r.raise_for_status()
    return r.json()

STAGED_MUTATION = """
mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets { url resourceUrl parameters { name value } }
    userErrors { field message }
  }
}
"""

FILE_CREATE_MUTATION = """
mutation fileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files { ... on MediaImage { id image { url } } }
    userErrors { field message }
  }
}
"""

FILE_QUERY = """
query getFile($id: ID!) {
  node(id: $id) {
    ... on MediaImage {
      id
      status
      image { url }
    }
  }
}
"""

def upload_banner(filepath):
    filename = os.path.basename(filepath)
    cdn_filename = f'vw-{filename}'
    file_size = os.path.getsize(filepath)
    slug = filename.replace('.png', '')
    artwork_name = slug.replace('hero-banner-', '').replace('-', ' ').title()

    # Step 1: Create staged upload
    result = gql(STAGED_MUTATION, {
        'input': [{
            'resource': 'FILE',
            'filename': cdn_filename,
            'mimeType': 'image/png',
            'httpMethod': 'POST',
            'fileSize': str(file_size)
        }]
    })

    targets = result.get('data', {}).get('stagedUploadsCreate', {})
    if targets.get('userErrors'):
        print(f'  STAGE ERROR: {targets["userErrors"]}')
        return False

    target = targets['stagedTargets'][0]
    params = {p['name']: p['value'] for p in target['parameters']}

    # Step 2: Upload to staged URL
    with open(filepath, 'rb') as f:
        r = requests.post(target['url'], data=params, files={'file': (cdn_filename, f, 'image/png')})
    if r.status_code >= 400:
        print(f'  UPLOAD ERROR: {r.status_code}')
        return False

    # Step 3: Create file in Shopify
    result = gql(FILE_CREATE_MUTATION, {
        'files': [{
            'alt': f'VividWalls hero banner - {artwork_name}',
            'contentType': 'IMAGE',
            'originalSource': target['resourceUrl']
        }]
    })

    fc = result.get('data', {}).get('fileCreate', {})
    if fc.get('userErrors'):
        print(f'  FILE CREATE ERROR: {fc["userErrors"]}')
        return False

    file_data = fc.get('files', [{}])[0]
    file_id = file_data.get('id', '')

    manifest[slug] = {
        'fileId': file_id,
        'filename': cdn_filename,
        'artworkName': artwork_name,
        'cdnUrl': '',
        'status': 'processing'
    }
    save_manifest()
    print(f'  Uploaded -> {file_id} (processing)')
    return True


def poll_cdn_urls():
    """Poll Shopify for CDN URLs of processing files."""
    processing = {k: v for k, v in manifest.items() if v.get('status') == 'processing'}
    if not processing:
        return 0

    print(f'\nPolling CDN URLs for {len(processing)} files...')
    resolved = 0

    for slug, entry in processing.items():
        file_id = entry.get('fileId', '')
        if not file_id:
            continue

        result = gql(FILE_QUERY, {'id': file_id})
        node = result.get('data', {}).get('node', {})
        status = node.get('status', '')
        image = node.get('image', {})
        url = image.get('url', '') if image else ''

        if url:
            entry['cdnUrl'] = url
            entry['status'] = 'ready'
            resolved += 1
            print(f'  {slug}: {url}')
        elif status == 'FAILED':
            entry['status'] = 'failed'
            print(f'  {slug}: FAILED')
        else:
            print(f'  {slug}: still processing ({status})')

        time.sleep(0.2)

    save_manifest()
    return resolved


# ── PHASE 1: Upload all banners ──
banners = sorted([f for f in os.listdir(RESIZED_DIR) if f.startswith('hero-banner-') and f.endswith('.png')])
print(f'Phase 1: Uploading {len(banners)} banners to Shopify CDN...')
print('=' * 60)

success = 0
failed = 0

for i, fname in enumerate(banners):
    slug = fname.replace('.png', '')
    if slug in manifest and manifest[slug].get('fileId'):
        print(f'[{i+1}/{len(banners)}] SKIP {fname} (already uploaded)')
        success += 1
        continue

    print(f'[{i+1}/{len(banners)}] {fname}')
    filepath = os.path.join(RESIZED_DIR, fname)

    try:
        if upload_banner(filepath):
            success += 1
        else:
            failed += 1
    except Exception as e:
        print(f'  EXCEPTION: {e}')
        failed += 1

    time.sleep(0.5)

print()
print(f'Upload phase: {success} success, {failed} failed')
print()

# ── PHASE 2: Poll for CDN URLs ──
print('Phase 2: Waiting for Shopify to process images...')
print('=' * 60)

max_attempts = 10
for attempt in range(max_attempts):
    processing = sum(1 for v in manifest.values() if v.get('status') == 'processing')
    if processing == 0:
        break
    print(f'\nAttempt {attempt+1}/{max_attempts}: {processing} still processing...')
    time.sleep(5)
    resolved = poll_cdn_urls()
    if resolved == processing:
        break

# Final summary
ready = sum(1 for v in manifest.values() if v.get('cdnUrl'))
processing = sum(1 for v in manifest.values() if v.get('status') == 'processing')
failed_count = sum(1 for v in manifest.values() if v.get('status') == 'failed')

print()
print('=' * 60)
print(f'FINAL: {ready} with CDN URLs, {processing} still processing, {failed_count} failed')
print(f'Manifest: {MANIFEST_PATH}')

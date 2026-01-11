#!/usr/bin/env python3
"""
Bible.com Verse of the Day fetcher
Retrieves the daily verse text, reference, and shareable image.
"""

import json
import re
import sys
import urllib.request

def get_votd():
    """Fetch verse of the day from Bible.com"""
    url = 'https://www.bible.com/verse-of-the-day'

    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    })

    with urllib.request.urlopen(req, timeout=10) as response:
        html = response.read().decode('utf-8')

    # Extract JSON from __NEXT_DATA__
    match = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.+?)</script>', html)
    if not match:
        return {"error": "Could not find verse data"}

    data = json.loads(match.group(1))
    props = data['props']['pageProps']

    verse = props['verses'][0]
    images = props.get('images', [])

    # Get the largest image (1280x1280)
    image_url = None
    if images:
        for rendition in images[0].get('renditions', []):
            if rendition.get('width') == 1280:
                image_url = 'https:' + rendition['url']
                break

    result = {
        "reference": verse['reference']['human'],
        "text": verse['content'].replace('\n', ' '),
        "usfm": verse['reference']['usfm'][0],
        "date": props.get('date', ''),
        "image_url": image_url,
        "attribution": "Bible.com / YouVersion"
    }

    return result

def download_image(url, output_path):
    """Download the VOTD image"""
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    })
    with urllib.request.urlopen(req, timeout=15) as response:
        with open(output_path, 'wb') as f:
            f.write(response.read())
    return output_path

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--download':
        output = sys.argv[2] if len(sys.argv) > 2 else '/tmp/votd.jpg'
        votd = get_votd()
        if votd.get('image_url'):
            download_image(votd['image_url'], output)
            votd['image_path'] = output
        print(json.dumps(votd, indent=2))
    else:
        print(json.dumps(get_votd(), indent=2))

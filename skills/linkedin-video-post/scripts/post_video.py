#!/usr/bin/env python3
"""Post a video to LinkedIn (personal profile and/or organization page).

Usage:
    python3 post_video.py --video FILE --text TEXT [--person-id ID] [--org-id ID]

Requires MATON_API_KEY environment variable.
Uses legacy v2 assets registerUpload (feedshare-video recipe) which works
through the Maton gateway proxy. Do NOT use the REST /videos endpoint —
those upload URLs require direct OAuth tokens that Maton doesn't proxy.
"""

import argparse
import json
import os
import sys
import urllib.request

GATEWAY = "https://gateway.maton.ai/linkedin"
CTRL = "https://ctrl.maton.ai"


def api_key():
    key = os.environ.get("MATON_API_KEY")
    if not key:
        print("Error: MATON_API_KEY not set", file=sys.stderr)
        sys.exit(1)
    return key


def request(url, data=None, method=None, headers=None, content_type="application/json"):
    if data and isinstance(data, dict):
        data = json.dumps(data).encode()
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Authorization", f"Bearer {api_key()}")
    if content_type:
        req.add_header("Content-Type", content_type)
    req.add_header("X-Restli-Protocol-Version", "2.0.0")
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    return urllib.request.urlopen(req)


def register_and_upload(video_path, owner_urn):
    """Register upload, upload binary, return asset URN."""
    # Register
    result = json.load(request(f"{GATEWAY}/v2/assets?action=registerUpload", data={
        "registerUploadRequest": {
            "recipes": ["urn:li:digitalmediaRecipe:feedshare-video"],
            "owner": owner_urn,
            "serviceRelationships": [
                {"relationshipType": "OWNER", "identifier": "urn:li:userGeneratedContent"}
            ]
        }
    }))

    upload_url = result["value"]["uploadMechanism"][
        "com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"
    ]["uploadUrl"]
    asset = result["value"]["asset"]

    # Upload binary
    with open(video_path, "rb") as f:
        video_data = f.read()

    req = urllib.request.Request(upload_url, data=video_data, method="PUT")
    req.add_header("Content-Type", "application/octet-stream")
    req.add_header("media-type-family", "VIDEO")
    req.add_header("Authorization", f"Bearer {api_key()}")
    resp = urllib.request.urlopen(req)
    assert resp.status in (200, 201), f"Upload failed: {resp.status}"

    return asset


def create_post(author_urn, text, asset, title=None):
    """Create UGC post with video."""
    post_data = {
        "author": author_urn,
        "lifecycleState": "PUBLISHED",
        "specificContent": {
            "com.linkedin.ugc.ShareContent": {
                "shareCommentary": {"text": text},
                "shareMediaCategory": "VIDEO",
                "media": [{
                    "status": "READY",
                    "media": asset,
                    "title": {"text": title or ""}
                }]
            }
        },
        "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"}
    }

    resp = request(f"{GATEWAY}/v2/ugcPosts", data=post_data)
    result = json.load(resp)
    return result.get("id", resp.headers.get("X-RestLi-Id", "unknown"))


def reshare_post(person_urn, original_post_urn, commentary):
    """Reshare an existing post from personal profile.

    Uses responseContext.parent to embed the original post as a reshare.
    Do NOT use resharedShare or shareMediaCategory=RESHARE — those don't
    work via the v2 ugcPosts endpoint through Maton.
    """
    post_data = {
        "author": person_urn,
        "lifecycleState": "PUBLISHED",
        "specificContent": {
            "com.linkedin.ugc.ShareContent": {
                "shareCommentary": {"text": commentary},
                "shareMediaCategory": "NONE",
                "media": []
            }
        },
        "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"},
        "responseContext": {
            "parent": original_post_urn
        }
    }

    resp = request(f"{GATEWAY}/v2/ugcPosts", data=post_data)
    result = json.load(resp)
    return result.get("id", resp.headers.get("X-RestLi-Id", "unknown"))


def main():
    parser = argparse.ArgumentParser(description="Post video to LinkedIn via Maton API")
    parser.add_argument("--video", required=True, help="Path to video file")
    parser.add_argument("--text", required=True, help="Post text (org post or standalone)")
    parser.add_argument("--title", default="", help="Video title")
    parser.add_argument("--person-id", help="LinkedIn person ID (posts to personal profile)")
    parser.add_argument("--org-id", help="LinkedIn org ID (posts to company page)")
    parser.add_argument("--reshare-text", help="Personal reshare commentary (enables org-post-then-reshare flow)")
    args = parser.parse_args()

    if not args.person_id and not args.org_id:
        print("Error: specify at least one of --person-id or --org-id", file=sys.stderr)
        sys.exit(1)

    # Recommended flow: post as org, then reshare from personal
    if args.org_id and args.person_id and args.reshare_text:
        org_urn = f"urn:li:organization:{args.org_id}"
        person_urn = f"urn:li:person:{args.person_id}"

        print("[org] Uploading video...", flush=True)
        asset = register_and_upload(args.video, org_urn)
        print(f"[org] Asset: {asset}", flush=True)

        print("[org] Creating post...", flush=True)
        org_post_id = create_post(org_urn, args.text, asset, args.title)
        print(f"[org] Posted: {org_post_id}", flush=True)

        print("[personal] Resharing...", flush=True)
        reshare_id = reshare_post(person_urn, org_post_id, args.reshare_text)
        print(f"[personal] Reshared: {reshare_id}", flush=True)
        return

    # Fallback: post independently to each target
    targets = []
    if args.person_id:
        targets.append(("personal", f"urn:li:person:{args.person_id}"))
    if args.org_id:
        targets.append(("organization", f"urn:li:organization:{args.org_id}"))

    for label, owner_urn in targets:
        print(f"[{label}] Uploading video...", flush=True)
        asset = register_and_upload(args.video, owner_urn)
        print(f"[{label}] Asset: {asset}", flush=True)

        print(f"[{label}] Creating post...", flush=True)
        post_id = create_post(owner_urn, args.text, asset, args.title)
        print(f"[{label}] Posted: {post_id}", flush=True)


if __name__ == "__main__":
    main()

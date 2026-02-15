#!/usr/bin/env python3
"""Upscale images via Venice AI Image Upscale API."""

import argparse
import base64
import datetime as dt
import io
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Import shared utilities
sys.path.insert(0, str(Path(__file__).parent))
from venice_common import require_api_key, print_media_line, get_mime_type, USER_AGENT, API_BASE


def upscale_image_from_file(
    api_key: str,
    image_path: Path,
    scale: int = 2,
    enhance: bool = False,
    enhance_prompt: str | None = None,
    enhance_creativity: float | None = None,
    replication: float | None = None,
) -> bytes:
    """
    Upscale an image via Venice API using multipart file upload.
    Returns raw image bytes.
    """
    url = f"{API_BASE}/image/upscale"
    
    # Build multipart form data
    boundary = "----VeniceUpscaleBoundary"
    
    parts = []
    
    # Add image file
    image_data = image_path.read_bytes()
    filename = image_path.name
    mime = get_mime_type(filename)
    
    parts.append(
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
        f'Content-Type: {mime}\r\n\r\n'
    )
    
    # Add scale parameter
    parts.append(
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="scale"\r\n\r\n'
        f'{scale}\r\n'
    )
    
    # Add enhance parameter
    parts.append(
        f'--{boundary}\r\n'
        f'Content-Disposition: form-data; name="enhance"\r\n\r\n'
        f'{"true" if enhance else "false"}\r\n'
    )
    
    # Optional parameters
    if enhance_prompt:
        parts.append(
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="enhancePrompt"\r\n\r\n'
            f'{enhance_prompt}\r\n'
        )
    
    if enhance_creativity is not None:
        parts.append(
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="enhanceCreativity"\r\n\r\n'
            f'{enhance_creativity}\r\n'
        )
    
    if replication is not None:
        parts.append(
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="replication"\r\n\r\n'
            f'{replication}\r\n'
        )
    
    # Build body
    body = io.BytesIO()
    body.write(parts[0].encode())
    body.write(image_data)
    body.write(b'\r\n')
    for part in parts[1:]:
        body.write(part.encode())
    body.write(f'--{boundary}--\r\n'.encode())
    
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": USER_AGENT,
        },
        data=body.getvalue(),
    )
    
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Venice API error ({e.code}): {error_body}") from e


def _fetch_url_as_base64(url: str) -> str:
    """Download an HTTP(S) URL and return as raw base64 string."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = resp.read()
        return base64.b64encode(data).decode("ascii")


def upscale_image_from_url(
    api_key: str,
    image_url: str,
    scale: int = 2,
    enhance: bool = False,
    enhance_prompt: str | None = None,
    enhance_creativity: float | None = None,
    replication: float | None = None,
) -> bytes:
    """
    Upscale an image via Venice API using a URL or base64 data URL.
    HTTP(S) URLs are downloaded and converted to base64 first.
    Returns raw image bytes.
    """
    
    # API requires base64, not HTTP URLs
    if image_url.startswith(("http://", "https://")):
        image_url = _fetch_url_as_base64(image_url)
    elif image_url.startswith("data:"):
        # Extract base64 from data URL
        if ";base64," in image_url:
            image_url = image_url.split(";base64,", 1)[1]
    
    url = f"{API_BASE}/image/upscale"
    
    payload: dict = {
        "image": image_url,
        "scale": scale,
        "enhance": enhance,
    }
    
    if enhance_prompt:
        payload["enhancePrompt"] = enhance_prompt
    if enhance_creativity is not None:
        payload["enhanceCreativity"] = enhance_creativity
    if replication is not None:
        payload["replication"] = replication
    
    body = json.dumps(payload).encode("utf-8")
    
    req = urllib.request.Request(
        url,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        data=body,
    )
    
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Venice API error ({e.code}): {error_body}") from e


def main() -> int:
    ap = argparse.ArgumentParser(description="Upscale images via Venice AI API.")
    ap.add_argument("image", nargs="?", help="Path to image file to upscale (or use --url)")
    ap.add_argument("--url", help="URL of image to upscale (http:// or https://)")
    ap.add_argument("--scale", type=int, default=2, choices=[1, 2, 3, 4],
                    help="Upscale factor 1-4 (default: 2)")
    ap.add_argument("--enhance", action="store_true",
                    help="Apply AI enhancement during upscale")
    ap.add_argument("--enhance-prompt", help="Description for enhancement (requires --enhance)")
    ap.add_argument("--enhance-creativity", type=float,
                    help="Creativity level 0.0-1.0 (requires --enhance)")
    ap.add_argument("--replication", type=float,
                    help="Replication factor 0.0-1.0 (preserves lines/noise, API default: 0.35)")
    ap.add_argument("--out-dir", help="Output directory (default: same as input or current dir for URLs)")
    ap.add_argument("--output", "-o", help="Output filename (default: auto-generated)")
    args = ap.parse_args()

    # Validate input
    if not args.image and not args.url:
        print("Error: Either image path or --url is required", file=sys.stderr)
        return 2
    if args.image and args.url:
        print("Error: Provide either image path or --url, not both", file=sys.stderr)
        return 2

    api_key = require_api_key()
    
    # Handle URL input
    if args.url:
        if not args.url.startswith(("http://", "https://")):
            print("Error: URL must start with http:// or https://", file=sys.stderr)
            return 2
        
        # Determine output path for URL input
        if args.output:
            out_path = Path(args.output).expanduser()
        else:
            out_dir = Path(args.out_dir).expanduser() if args.out_dir else Path.cwd()
            out_dir.mkdir(parents=True, exist_ok=True)
            timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            out_path = out_dir / f"upscaled-{args.scale}x-{timestamp}.png"
        
        out_path.parent.mkdir(parents=True, exist_ok=True)
        
        print(f"Upscaling: {args.url[:60]}{'...' if len(args.url) > 60 else ''}")
        print(f"  Scale: {args.scale}x")
        print(f"  Enhance: {args.enhance}")
        
        try:
            result = upscale_image_from_url(
                api_key=api_key,
                image_url=args.url,
                scale=args.scale,
                enhance=args.enhance,
                enhance_prompt=args.enhance_prompt,
                enhance_creativity=args.enhance_creativity,
                replication=args.replication,
            )
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1
    else:
        # Handle file input
        image_path = Path(args.image).expanduser()
        if not image_path.exists():
            print(f"Error: Image not found: {image_path}", file=sys.stderr)
            return 2
        
        # Determine output path
        if args.output:
            out_path = Path(args.output).expanduser()
        else:
            out_dir = Path(args.out_dir).expanduser() if args.out_dir else image_path.parent
            out_dir.mkdir(parents=True, exist_ok=True)
            timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            suffix = image_path.suffix or ".png"
            out_path = out_dir / f"{image_path.stem}-upscaled-{args.scale}x-{timestamp}{suffix}"
        
        out_path.parent.mkdir(parents=True, exist_ok=True)
        
        print(f"Upscaling: {image_path.name}")
        print(f"  Scale: {args.scale}x")
        print(f"  Enhance: {args.enhance}")
        
        try:
            result = upscale_image_from_file(
                api_key=api_key,
                image_path=image_path,
                scale=args.scale,
                enhance=args.enhance,
                enhance_prompt=args.enhance_prompt,
                enhance_creativity=args.enhance_creativity,
                replication=args.replication,
            )
        except RuntimeError as e:
            print(f"Error: {e}", file=sys.stderr)
            return 1
    
    out_path.write_bytes(result)
    print(f"\nSaved: {out_path.as_posix()}")
    print(f"Size: {len(result) / 1024:.1f}KB")
    
    print_media_line(out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

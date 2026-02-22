#!/usr/bin/env python3
"""Generate images via WaveSpeed API for VedicVoice video scenes.

Usage:
  python3 generate_images.py --prompt "..." --output scene1.png [--model flux-2-pro] [--size 1080x1920]
  python3 generate_images.py --spec scenes.json --outdir ./images/

scenes.json format:
  [
    {"name": "hook", "prompt": "...", "model": "nano-banana-pro"},
    {"name": "scene1", "prompt": "..."}
  ]
"""

import argparse, json, os, sys, time, urllib.request, urllib.error, base64

ENV_PATH = "/home/vivek/projects/shopify-multimodal-assistant/sanskrit-mantras/.env"

# Model shortcuts → full WaveSpeed model IDs
MODEL_MAP = {
    "nano-banana-pro": "google/nano-banana-pro/text-to-image",
    "nano-banana": "google/nano-banana/text-to-image",
    "imagen4": "google/imagen4",
    "imagen4-fast": "google/imagen4-fast",
    "flux-2-pro": "wavespeed-ai/flux-2-pro/text-to-image",
    "flux-2-flash": "wavespeed-ai/flux-2-flash/text-to-image",
    "flux-2-turbo": "wavespeed-ai/flux-2-turbo/text-to-image",
    "z-image-turbo": "wavespeed-ai/z-image/turbo",
    "z-image": "wavespeed-ai/z-image/base",
    "qwen-image": "wavespeed-ai/qwen-image/text-to-image",
    "gemini-image": "google/gemini-3-pro-image/text-to-image",
}

# Price per image (USD)
MODEL_PRICES = {
    "nano-banana-pro": 0.14,
    "imagen4": 0.038,
    "imagen4-fast": 0.018,
    "flux-2-pro": 0.03,
    "flux-2-flash": 0.008,
    "flux-2-turbo": 0.01,
    "z-image-turbo": 0.005,
    "z-image": 0.01,
    "qwen-image": 0.02,
    "gemini-image": 0.14,
}

def load_api_key():
    key = os.environ.get("WAVESPEED_API_KEY")
    if key:
        return key
    if os.path.exists(ENV_PATH):
        with open(ENV_PATH) as f:
            for line in f:
                if line.startswith("WAVESPEED_API_KEY="):
                    return line.strip().split("=", 1)[1].strip('"').strip("'")
    print("ERROR: WAVESPEED_API_KEY not found", file=sys.stderr)
    sys.exit(1)

def resolve_model(shortname):
    return MODEL_MAP.get(shortname, shortname)

def generate_image(api_key, prompt, model="flux-2-pro", width=1080, height=1920):
    """Submit image generation and poll for result. Returns image bytes."""
    model_id = resolve_model(model)
    # WaveSpeed API: submit via v2/{model}, poll via the URL in response
    url = f"https://api.wavespeed.ai/api/v2/{model_id}"
    
    payload = json.dumps({
        "prompt": prompt,
        "size": f"{width}x{height}",
    }).encode()
    
    req = urllib.request.Request(url, data=payload, headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    })
    
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"ERROR submitting job: {e.code} {body}", file=sys.stderr)
        sys.exit(1)
    
    # Some models return sync with outputs
    outputs = data.get("data", {}).get("outputs", [])
    if outputs:
        return download_image(outputs[0])
    
    # Async: poll the URL from response
    poll_url = data.get("data", {}).get("urls", {}).get("get")
    if not poll_url:
        prediction_id = data.get("data", {}).get("id") or data.get("id")
        if not prediction_id:
            print(f"ERROR: No prediction ID in response: {json.dumps(data)}", file=sys.stderr)
            sys.exit(1)
        poll_url = f"https://api.wavespeed.ai/api/v2/predictions/{prediction_id}/result"
    
    for attempt in range(120):  # 2 min timeout
        time.sleep(1)
        poll_req = urllib.request.Request(poll_url, headers={
            "Authorization": f"Bearer {api_key}",
        })
        try:
            with urllib.request.urlopen(poll_req, timeout=15) as resp:
                result = json.loads(resp.read())
        except urllib.error.HTTPError:
            continue
        
        status = result.get("data", {}).get("status") or result.get("status")
        if status == "completed":
            outputs = result.get("data", {}).get("outputs") or result.get("outputs", [])
            if outputs:
                return download_image(outputs[0])
            print(f"ERROR: Completed but no outputs: {json.dumps(result)}", file=sys.stderr)
            sys.exit(1)
        elif status == "failed":
            print(f"ERROR: Generation failed: {json.dumps(result)}", file=sys.stderr)
            sys.exit(1)
        
        if attempt % 10 == 0 and attempt > 0:
            print(f"  ...waiting ({attempt}s)", file=sys.stderr)
    
    print("ERROR: Timed out waiting for image", file=sys.stderr)
    sys.exit(1)

def download_image(url_or_b64):
    """Download image from URL or decode base64."""
    if url_or_b64.startswith("data:"):
        _, b64 = url_or_b64.split(",", 1)
        return base64.b64decode(b64)
    if url_or_b64.startswith("http"):
        req = urllib.request.Request(url_or_b64)
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    return base64.b64decode(url_or_b64)

def main():
    parser = argparse.ArgumentParser(description="Generate images via WaveSpeed API")
    parser.add_argument("--prompt", help="Image prompt text")
    parser.add_argument("--output", "-o", help="Output file path")
    parser.add_argument("--model", "-m", default="flux-2-pro", 
                       help=f"Model shortname: {', '.join(MODEL_MAP.keys())}")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--spec", help="JSON file with scene specs for batch generation")
    parser.add_argument("--outdir", default=".", help="Output directory for batch mode")
    parser.add_argument("--dry-run", action="store_true", help="Show cost estimate without generating")
    args = parser.parse_args()
    
    api_key = load_api_key()
    
    if args.spec:
        with open(args.spec) as f:
            scenes = json.load(f)
        os.makedirs(args.outdir, exist_ok=True)
        
        total_cost = sum(MODEL_PRICES.get(s.get("model", "flux-2-pro"), 0.03) for s in scenes)
        print(f"Generating {len(scenes)} images, estimated cost: ${total_cost:.2f}")
        
        if args.dry_run:
            for s in scenes:
                m = s.get("model", "flux-2-pro")
                print(f"  {s['name']}: {m} (${MODEL_PRICES.get(m, 0.03):.3f})")
            return
        
        for i, scene in enumerate(scenes):
            name = scene["name"]
            prompt = scene["prompt"]
            model = scene.get("model", "flux-2-pro")
            w = scene.get("width", args.width)
            h = scene.get("height", args.height)
            
            print(f"[{i+1}/{len(scenes)}] {name} ({model})...")
            img_bytes = generate_image(api_key, prompt, model, w, h)
            
            out_path = os.path.join(args.outdir, f"{name}.png")
            with open(out_path, "wb") as f:
                f.write(img_bytes)
            print(f"  → {out_path} ({len(img_bytes)//1024}KB)")
    
    elif args.prompt:
        if not args.output:
            args.output = "output.png"
        
        if args.dry_run:
            cost = MODEL_PRICES.get(args.model, 0.03)
            print(f"Model: {args.model} → {resolve_model(args.model)}")
            print(f"Estimated cost: ${cost:.3f}")
            return
        
        print(f"Generating with {args.model}...")
        img_bytes = generate_image(api_key, args.prompt, args.model, args.width, args.height)
        
        with open(args.output, "wb") as f:
            f.write(img_bytes)
        print(f"Saved: {args.output} ({len(img_bytes)//1024}KB)")
    
    else:
        parser.print_help()

if __name__ == "__main__":
    main()

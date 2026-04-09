# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///

"""List available Krea AI models by fetching the live OpenAPI spec."""

import argparse
import json
import os
import re
import sys
import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from krea_helpers import OPENAPI_URL


def fetch_models():
    """Fetch the OpenAPI spec and extract all generation/enhance endpoints."""
    r = requests.get(OPENAPI_URL, timeout=15)
    r.raise_for_status()
    spec = r.json()

    image_models = {}
    video_models = {}
    enhancers = {}

    for path, methods in spec.get("paths", {}).items():
        post = methods.get("post")
        if not post:
            continue

        summary = post.get("summary", "")
        description = post.get("description", summary)
        tags = post.get("tags", [])

        cu = None
        cu_match = re.search(r"~?(\d+)\s*(?:CU|compute units)", description, re.IGNORECASE)
        if cu_match:
            cu = int(cu_match.group(1))
        elif "Compute Units" in description:
            table_match = re.search(r"\|\s*~?(\d+)\s*\|", description)
            if table_match:
                cu = int(table_match.group(1))

        time_est = None
        time_match = re.search(r"~?(\d+)\s*(?:seconds)", description, re.IGNORECASE)
        if time_match:
            time_est = f"~{time_match.group(1)}s"
        elif "Completion Time" in description:
            table_time = re.search(r"\|\s*~?(\d+)\s*seconds?\s*\|", description, re.IGNORECASE)
            if table_time:
                time_est = f"~{table_time.group(1)}s"

        # Extract parameters from request body schema
        body_schema = {}
        request_body = post.get("requestBody", {})
        content = request_body.get("content", {})
        json_content = content.get("application/json", {})
        body_schema = json_content.get("schema", {})
        params = list(body_schema.get("properties", {}).keys()) if body_schema else []

        entry = {
            "endpoint": path,
            "summary": summary,
            "description": description.split(".")[0] if description else "",
            "compute_units": cu,
            "estimated_time": time_est,
            "parameters": params,
        }

        if path.startswith("/generate/image/"):
            # Derive a short model ID from the path
            # /generate/image/bfl/flux-1-dev → flux-1-dev
            parts = path.replace("/generate/image/", "").split("/")
            provider = parts[0] if parts else ""
            model_name = parts[1] if len(parts) > 1 else parts[0]
            entry["provider"] = provider
            entry["id"] = model_name
            image_models[model_name] = entry

        elif path.startswith("/generate/video/"):
            parts = path.replace("/generate/video/", "").split("/")
            provider = parts[0] if parts else ""
            model_name = parts[1] if len(parts) > 1 else parts[0]
            entry["provider"] = provider
            entry["id"] = model_name
            video_models[model_name] = entry

        elif path.startswith("/generate/enhance/"):
            parts = path.replace("/generate/enhance/", "").split("/")
            provider = parts[0] if parts else ""
            model_name = parts[1] if len(parts) > 1 else parts[0]
            entry["provider"] = provider
            entry["id"] = f"{provider}-{model_name}" if provider != model_name else model_name
            enhancers[entry["id"]] = entry

    return image_models, video_models, enhancers


def _param_summary(params, max_len=56):
    """Comma-separated OpenAPI body fields, truncated for terminal width."""
    if not params:
        return "—"
    s = ", ".join(sorted(params))
    if len(s) <= max_len:
        return s
    return s[: max_len - 3] + "..."


def main():
    parser = argparse.ArgumentParser(description="List available Krea AI models (live from API)")
    parser.add_argument("--type", choices=["image", "video", "enhance", "all"], default="all", help="Filter by type")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    parser.add_argument(
        "--no-params",
        action="store_true",
        help="Hide the request-body field list (from OpenAPI) in text output",
    )
    args = parser.parse_args()

    try:
        image_models, video_models, enhancers = fetch_models()
    except Exception as e:
        print(f"Error fetching models: {e}", file=sys.stderr)
        sys.exit(1)

    if args.json:
        result = {}
        if args.type in ("all", "image"):
            result["image_models"] = image_models
        if args.type in ("all", "video"):
            result["video_models"] = video_models
        if args.type in ("all", "enhance"):
            result["enhancers"] = enhancers
        print(json.dumps(result, indent=2))
        return

    show_params = not args.no_params

    if args.type in ("all", "image"):
        print("=== Image Models ===")
        if show_params:
            print(f"{'Model':<22} {'CU':>4} {'Time':<7} {'Body fields (OpenAPI)'}")
            print("-" * 120)
            for name, info in sorted(image_models.items(), key=lambda x: (x[1]["compute_units"] or 9999)):
                cu = str(info["compute_units"]) if info["compute_units"] else "?"
                time_est = info["estimated_time"] or "?"
                ps = _param_summary(info.get("parameters") or [])
                print(f"{name:<22} {cu:>4} {time_est:<7} {ps}")
                print(f"{'':22} {'':4} {'':7} {info['endpoint']}")
        else:
            print(f"{'Model':<25} {'CU':>5} {'Time':<8} {'Endpoint'}")
            print("-" * 80)
            for name, info in sorted(image_models.items(), key=lambda x: (x[1]["compute_units"] or 9999)):
                cu = str(info["compute_units"]) if info["compute_units"] else "?"
                time_est = info["estimated_time"] or "?"
                print(f"{name:<25} {cu:>5} {time_est:<8} {info['endpoint']}")
        print()

    if args.type in ("all", "video"):
        print("=== Video Models ===")
        if show_params:
            print(f"{'Model':<22} {'CU':>4} {'Time':<9} {'Body fields (OpenAPI)'}")
            print("-" * 120)
            for name, info in sorted(video_models.items(), key=lambda x: (x[1]["compute_units"] or 9999)):
                cu = str(info["compute_units"]) if info["compute_units"] else "?"
                time_est = info["estimated_time"] or "?"
                ps = _param_summary(info.get("parameters") or [])
                print(f"{name:<22} {cu:>4} {time_est:<9} {ps}")
                print(f"{'':22} {'':4} {'':9} {info['endpoint']}")
        else:
            print(f"{'Model':<25} {'CU':>5} {'Time':<10} {'Endpoint'}")
            print("-" * 80)
            for name, info in sorted(video_models.items(), key=lambda x: (x[1]["compute_units"] or 9999)):
                cu = str(info["compute_units"]) if info["compute_units"] else "?"
                time_est = info["estimated_time"] or "?"
                print(f"{name:<25} {cu:>5} {time_est:<10} {info['endpoint']}")
        print()

    if args.type in ("all", "enhance"):
        print("=== Enhancers ===")
        if show_params:
            print(f"{'Enhancer':<22} {'CU':>4} {'Time':<7} {'Body fields (OpenAPI)'}")
            print("-" * 120)
            for name, info in sorted(enhancers.items(), key=lambda x: (x[1]["compute_units"] or 9999)):
                cu = str(info["compute_units"]) if info["compute_units"] else "?"
                time_est = info["estimated_time"] or "?"
                ps = _param_summary(info.get("parameters") or [])
                print(f"{name:<22} {cu:>4} {time_est:<7} {ps}")
                print(f"{'':22} {'':4} {'':7} {info['endpoint']}")
        else:
            print(f"{'Enhancer':<25} {'CU':>5} {'Time':<8} {'Endpoint'}")
            print("-" * 80)
            for name, info in sorted(enhancers.items(), key=lambda x: (x[1]["compute_units"] or 9999)):
                cu = str(info["compute_units"]) if info["compute_units"] else "?"
                time_est = info["estimated_time"] or "?"
                print(f"{name:<25} {cu:>5} {time_est:<8} {info['endpoint']}")
        print()


if __name__ == "__main__":
    main()

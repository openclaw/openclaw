#!/usr/bin/env python3
# Copyright (c) 2026 Beijing Volcano Engine Technology Co., Ltd. and/or its affiliates.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
seedream - Generate high-quality images from text prompts
using BytePlus Seedream models. Supports 4.0, 4.5, and 5.0-lite versions.
"""

import argparse
import asyncio
import json
import os
import sys
from typing import Dict, List, Tuple

import httpx

# Configuration constants
API_KEY = os.getenv("ARK_DOLA_API_KEY")
API_BASE = os.getenv(
    "ARK_DOLA_API_BASE", 
    "https://ark.ap-southeast.bytepluses.com/api/v3"
).rstrip("/")

# Model names for each version
MODELS = {
    "4.0": "seedream-4-0-250828",
    "4.5": "seedream-4-5-251128",
    "5.0": "seedream-5-0-260128",
}

# Supported fields per version (based on official documentation)
SUPPORTED_FIELDS = {
    "4.0": [
        "size",
        "response_format",
        "watermark",
        "image",
        "sequential_image_generation",
        "sequential_image_generation_options",
        "stream",
        "optimize_prompt_options",
    ],
    "4.5": [
        "size",
        "response_format",
        "watermark",
        "image",
        "sequential_image_generation",
        "sequential_image_generation_options",
        "stream",
        "optimize_prompt_options",
    ],
    "5.0": [
        "size",
        "response_format",
        "watermark",
        "image",
        "sequential_image_generation",
        "sequential_image_generation_options",
        "tools",
        "output_format",
        "stream",
        "optimize_prompt_options",
    ],
}

# Version descriptions
VERSION_DESCRIPTIONS = {
    "4.0": "Seedream 4.0 - Stable and reliable for daily use, fast response (does not support tools and output_format)",
    "4.5": "Seedream 4.5 - Better detail performance, improved complex scene handling (does not support tools and output_format)",
    "5.0": "Seedream 5.0 - The strongest version currently available! Breakthrough creative expression and ultra-high quality details! The only version that supports tools and output_format!",
}

def _get_headers() -> dict:
    """
    Build API request headers
    """
    if not API_KEY:
        raise ValueError(
            "Please set ARK_API_KEY or MODEL_IMAGE_API_KEY or MODEL_AGENT_API_KEY environment variable"
        )
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}",
    }

def _build_request_body(item: dict, model_name: str, version: str) -> dict:
    """
    Build API request body
    Only add parameters supported by the selected version
    """
    body = {
        "model": model_name,
        "prompt": item.get("prompt", ""),
    }

    # Only add optional parameters supported by the current version
    supported_fields = SUPPORTED_FIELDS.get(version, [])
    for field in supported_fields:
        if field in item and item[field] is not None:
            body[field] = item[field]

    # Handle sequential_image_generation options for batch generation
    if item.get("sequential_image_generation") == "auto":
        options = dict(item.get("sequential_image_generation_options") or {})
        if "max_images" in item:
            options["max_images"] = item["max_images"]
        if options:
            body["sequential_image_generation_options"] = options

    return body

async def _call_image_api(item: dict, model_name: str, version: str, timeout: int) -> dict:
    """
    Call image generation API"""
    url = f"{API_BASE}/images/generations"
    body = _build_request_body(item, model_name, version)

    async with httpx.AsyncClient(timeout=float(timeout)) as client:
        response = await client.post(url, headers=_get_headers(), json=body)
        response.raise_for_status()
        return response.json()

async def handle_single_task(
    idx: int,
    item: dict,
    model_name: str,
    version: str,
    timeout: int,
) -> Tuple[List[dict], List[str], List[dict]]:
    """
    Handle a single image generation task"""
    success_list = []
    error_list = []
    error_detail_list = []

    try:
        response = await _call_image_api(item, model_name, version, timeout)

        if "error" not in response:
            data_list = response.get("data", [])
            for i, image_data in enumerate(data_list):
                image_name = f"task_{idx}_image_{i}"

                # Check if image has error
                if "error" in image_data:
                    error_list.append(image_name)
                    error_detail_list.append(
                        {
                            "task_idx": idx,
                            "image_name": image_name,
                            "error": image_data.get("error"),
                        }
                    )
                    continue

                # Get image URL or Base64 data
                image_url = image_data.get("url")
                if image_url:
                    success_list.append({image_name: image_url})
                else:
                    b64 = image_data.get("b64_json")
                    if b64:
                        output_format = item.get("output_format")
                        mime_type = "image/jpeg" if output_format == "jpeg" else "image/png"
                        success_list.append(
                            {image_name: f"data:{mime_type};base64,{b64}"}
                        )
                    else:
                        error_list.append(image_name)
                        error_detail_list.append(
                            {
                                "task_idx": idx,
                                "image_name": image_name,
                                "error": "missing data (no url/b64)",
                            }
                        )
        else:
            # API returned error
            error_info = response.get("error", {})
            error_list.append(f"task_{idx}")
            error_detail_list.append({"task_idx": idx, "error": error_info})

    except Exception as e:
        # Handle exception
        error_list.append(f"task_{idx}")
        error_detail_list.append({"task_idx": idx, "error": str(e)})

    return success_list, error_list, error_detail_list

async def seedream_generate(
    tasks: List[dict],
    version: str = "5.0",
    timeout: int = 1200,
) -> Dict:
    """
    Main function for seedream
    
    One skill supporting three versions! Choose the appropriate version based on your needs!
    Automatically filters unsupported parameters based on version!
    
    Based on official API documentation:
    - Seedream 4.0/4.5: Do not support tools and output_format parameters
    - Seedream 5.0-lite: Supports all parameters including tools and output_format
    
    Args:
        tasks: List of tasks, each task is a dictionary
        version: Version selection: "4.0", "4.5", or "5.0" (default 5.0)
        timeout: Timeout in seconds, default 1200 seconds
    
    Returns:
        Dictionary containing generation results
    """
    # Validate version
    if version not in MODELS:
        return {
            "status": "error",
            "success_list": [],
            "error_list": [f"Unsupported version: {version}, please choose 4.0, 4.5, or 5.0"],
            "error_detail_list": [{"error": "Invalid version"}],
        }

    if not API_KEY:
        return {
            "status": "error",
            "success_list": [],
            "error_list": ["Missing API key, please set ARK_API_KEY or MODEL_IMAGE_API_KEY or MODEL_AGENT_API_KEY"],
            "error_detail_list": [{"error": "Missing API key"}],
        }

    model_name = MODELS[version]
    success_list = []
    error_list = []
    error_detail_list = []

    # Process all tasks concurrently
    coroutines = [
        handle_single_task(idx, item, model_name, version, timeout) 
        for idx, item in enumerate(tasks)
    ]

    results = await asyncio.gather(*coroutines, return_exceptions=True)

    # Compile results
    for res in results:
        if isinstance(res, Exception):
            error_list.append("unknown_task_exception")
            error_detail_list.append({"error": str(res)})
            continue
        s, e, ed = res
        success_list.extend(s)
        error_list.extend(e)
        error_detail_list.extend(ed)

    # Add version note
    version_note = VERSION_DESCRIPTIONS[version]
    if version != "5.0":
        version_note += " 【Note: This version does not support tools and output_format parameters】"

    return {
        "status": "success" if success_list else "error",
        "success_list": success_list,
        "error_list": error_list,
        "error_detail_list": error_detail_list,
        "model": model_name,
        "version": version,
        "version_note": version_note,
        "supported_fields": SUPPORTED_FIELDS[version],
    }

def list_versions():
    """List all supported versions"""
    print("seedream supported versions:")
    print("")
    for version, desc in VERSION_DESCRIPTIONS.items():
        model = MODELS[version]
        print(f"  Version {version}:")
        print(f"     Model name: {model}")
        print(f"     Description: {desc}")
        print(f"     Supported parameters: {', '.join(SUPPORTED_FIELDS[version])}")
        if version != "5.0":
            print(f"     ⚠️  Not supported: tools, output_format")
        else:
            print(f"     ⭐ Only supported: tools, output_format")
        print("")
    print("Recommendation: When in doubt, use 5.0!")

def main():
    """
    Command line entry point"""
    parser = argparse.ArgumentParser(
        description="seedream - Generate high-quality images from text prompts using BytePlus Seedream models"
    )
    parser.add_argument(
        "--prompt", "-p", required=False, help="Image description text"
    )
    parser.add_argument(
        "--version", "-v", choices=["4.0", "4.5", "5.0"], default="5.0",
        help="Version selection: 4.0, 4.5, or 5.0 (default 5.0)"
    )
    parser.add_argument(
        "--size", "-s", default="2048x2048", 
        help="Image dimensions (e.g., 2048x2048, 2K, 4K, 3K)"
    )
    parser.add_argument(
        "--image", "-i", default=None,
        help="Reference image URL (for image-to-image)"
    )
    parser.add_argument(
        "--images", nargs="+", default=None,
        help="Multiple reference image URLs (space separated, for multi-image-to-image, max 14)"
    )
    parser.add_argument(
        "--group", "-g", action="store_true",
        help="Enable batch image generation (sequential_image_generation=auto)"
    )
    parser.add_argument(
        "--max-images", type=int, default=15,
        help="Maximum images for batch generation (default 15, range [1,15])"
    )
    parser.add_argument(
        "--output-format", choices=["png", "jpeg"], default="jpeg",
        help="Output format: png or jpeg (5.0 only)"
    )
    parser.add_argument(
        "--response-format", choices=["url", "b64_json"], default="url",
        help="Response format: url or b64_json (default url)"
    )
    parser.add_argument(
        "--stream", action="store_true",
        help="Enable streaming output mode (default false)"
    )
    parser.add_argument(
        "--optimize-prompt-mode", choices=["standard", "fast"], default=None,
        help="Prompt optimization mode: standard or fast (fast only supported by some models)"
    )
    parser.add_argument(
        "--web-search", action="store_true",
        help="Enable web search tool (5.0 only)"
    )
    parser.add_argument(
        "--timeout", "-t", type=int, default=1200,
        help="Timeout in seconds (default 1200)"
    )
    parser.add_argument(
        "--no-watermark", action="store_true",
        help="Disable image watermark (default enabled)"
    )
    parser.add_argument(
        "--list-versions", action="store_true",
        help="List all supported versions and parameter support"
    )

    args = parser.parse_args()

    # If listing versions
    if args.list_versions:
        list_versions()
        sys.exit(0)

    # Check if prompt is provided
    if not args.prompt:
        print("  Error: Please provide --prompt parameter (image description)")
        print("  Or use --list-versions to see all supported versions")
        sys.exit(1)

    # Check API key
    if not API_KEY:
        print(
            "  Error: Please set ARK_API_KEY or MODEL_IMAGE_API_KEY or MODEL_AGENT_API_KEY environment variable!"
        )
        print("  Tip: export ARK_API_KEY='your-api-key'")
        sys.exit(1)

    if args.stream:
        print(
            "  Error: --stream is not supported yet (the script does not parse streaming responses)."
        )
        sys.exit(1)

    # Build task
    task = {
        "prompt": args.prompt,
        "size": args.size,
        "response_format": args.response_format,
        "watermark": not args.no_watermark,
    }

    # Only add output_format and tools for 5.0 version
    if args.version == "5.0":
        task["output_format"] = args.output_format
        if args.web_search:
            task["tools"] = [{"type": "web_search"}]
    else:
        # Warn user that these parameters will be ignored in non-5.0 versions
        if args.output_format != "jpeg":
            print(f"⚠️  Warning: {args.version} version does not support output_format parameter, will be ignored")
        if args.web_search:
            print(f"⚠️  Warning: {args.version} version does not support tools/web_search parameter, will be ignored")

    # Handle prompt optimization
    if args.optimize_prompt_mode:
        # 4.5 and 5.0 versions don't support fast mode
        if args.version in ["4.5", "5.0"] and args.optimize_prompt_mode == "fast":
            print(f"⚠️  Warning: {args.version} version does not support fast optimization mode, will use standard mode")
            task["optimize_prompt_options"] = {"mode": "standard"}
        else:
            task["optimize_prompt_options"] = {"mode": args.optimize_prompt_mode}

    # Handle reference images
    if args.images:
        task["image"] = args.images
    elif args.image:
        task["image"] = args.image

    # Handle batch generation
    if args.group:
        if not (1 <= args.max_images <= 15):
            print("  Error: --max-images must be in range [1, 15]")
            sys.exit(1)
        task["sequential_image_generation"] = "auto"
        task["max_images"] = args.max_images

    print(f"  Generating image using Seedream {args.version}...")
    print(f"  {VERSION_DESCRIPTIONS[args.version]}")
    print(f"  Prompt: {args.prompt}")
    print(f"  Size: {args.size}")
    print(f"  Response format: {args.response_format}")
    if args.version == "5.0":
        print(f"🖼️  Output format: {args.output_format}")
    print(f"  Watermark: {'Disabled' if args.no_watermark else 'Enabled'}")
    print(f"  Stream output: {'Enabled' if args.stream else 'Disabled'}")
    if args.version == "5.0" and args.web_search:
        print(f"🔍 Web search: Enabled")
    if args.optimize_prompt_mode:
        print(f"  Prompt optimization: {args.optimize_prompt_mode}")
    print("")

    # Execute generation
    result = asyncio.run(
        seedream_generate([task], version=args.version, timeout=args.timeout)
    )
    
    # Output results
    print(json.dumps(result, indent=2, ensure_ascii=False))
    
    
    if result["status"] == "success":
        print(f"\n {args.version} version generation successful!")
        print(f"  Generated {len(result['success_list'])} images")
        if args.version == "5.0":
            print(f"  Great choice! 5.0 is the strongest version currently, and it even supports tools and output_format!")
    else:
        print(f"\n😢 Generation failed")
        print(f"  Don't worry, let me help you check the error information: {result['error_list']}")

if __name__ == "__main__":
    main()

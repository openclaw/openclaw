#!/usr/bin/env python3
# Copyright (c) 2025 PaddlePaddle Authors. All Rights Reserved.
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
Smoke Test for PaddleOCR Document Parsing Skill

Verifies configuration and API connectivity.

Usage:
    python paddleocr-doc-parsing/scripts/smoke_test.py
    python paddleocr-doc-parsing/scripts/smoke_test.py --skip-api-test
"""

import argparse
import sys
from pathlib import Path

# Add scripts dir to path for imports
sys.path.insert(0, str(Path(__file__).parent))


def print_config_guide():
    """Print friendly configuration guide."""
    print(
        """
============================================================
HOW TO GET YOUR API CREDENTIALS
============================================================

1. Visit: https://www.paddleocr.com
2. Open your model's API page and sign in
3. Open your model's Example Code section
4. In Example Code, copy the API URL value
5. In Example Code, copy the Access Token value

Set environment variables:
  export PADDLEOCR_DOC_PARSING_API_URL=https://your-api-url.paddleocr.com/layout-parsing
  export PADDLEOCR_ACCESS_TOKEN=your_token_here
  export PADDLEOCR_DOC_PARSING_TIMEOUT=600  # optional

============================================================
"""
    )


def main():
    parser = argparse.ArgumentParser(
        description="PaddleOCR Document Parsing smoke test"
    )
    parser.add_argument("--test-url", help="Optional: Custom document URL for testing")
    parser.add_argument(
        "--skip-api-test",
        action="store_true",
        help="Skip API connectivity test, only check configuration",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("PaddleOCR Document Parsing - Smoke Test")
    print("=" * 60)

    # Check dependencies first
    print("\n[1/3] Checking dependencies...")

    try:
        import httpx

        print(f"  + httpx: {httpx.__version__}")
    except ImportError:
        print("  X httpx not installed")
        print("\nPlease install dependencies:")
        print("  pip install httpx")
        return 1

    # Check configuration
    print("\n[2/3] Checking configuration...")

    from lib import get_config

    try:
        api_url, token = get_config()
        print(f"  + PADDLEOCR_DOC_PARSING_API_URL: {api_url}")
        masked_token = token[:8] + "..." + token[-4:] if len(token) > 12 else "***"
        print(f"  + PADDLEOCR_ACCESS_TOKEN: {masked_token}")
    except ValueError as e:
        print(f"  X {e}")
        print_config_guide()
        return 1

    # Test API connectivity
    if args.skip_api_test:
        print("\n[3/3] Skipping API connectivity test (--skip-api-test)")
        print("\n" + "=" * 60)
        print("Configuration Check Complete!")
        print("=" * 60)
        return 0

    print("\n[3/3] Testing API connectivity...")

    # Use provided test URL or default
    test_url = (
        args.test_url
        or "https://paddle-model-ecology.bj.bcebos.com/paddlex/imgs/demo_image/pp_structure_v3_demo.png"
    )
    print(f"  Test document: {test_url}")

    from lib import parse_document

    result = parse_document(file_url=test_url)

    if not result["ok"]:
        error = result.get("error", {})
        print(f"\n  X API call failed: {error.get('message')}")
        if "Authentication" in error.get("message", ""):
            print("\n  Hint: Check if your token is correct and not expired.")
            print(
                "        Get a new token from the PaddleOCR page example code section."
            )
        return 1

    print("  + API call successful!")

    # Show results
    text = result.get("text", "")
    if text:
        preview = text[:200].replace("\n", " ")
        if len(text) > 200:
            preview += "..."
        print(f"\n  Preview: {preview}")

    print("\n" + "=" * 60)
    print("Smoke Test PASSED")
    print("=" * 60)
    print("\nNext steps:")
    print('  python paddleocr-doc-parsing/scripts/vl_caller.py --file-url "URL"')
    print('  python paddleocr-doc-parsing/scripts/vl_caller.py --file-path "doc.pdf"')
    print(
        "  Results are auto-saved to the system temp directory; the caller prints the saved path."
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())

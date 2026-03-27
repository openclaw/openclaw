"""
Smoke Test for PaddleOCR Text Recognition

Verifies configuration and API connectivity.

Usage:
    python scripts/smoke_test.py
    python scripts/smoke_test.py --skip-api-test
    python scripts/smoke_test.py --test-url "https://example.com/test.png"
"""

import argparse
import sys
from pathlib import Path

# Add scripts dir to path for imports
sys.path.insert(0, str(Path(__file__).parent))

from lib import DEFAULT_TIMEOUT


def print_config_guide() -> None:
    """Print friendly configuration guide."""
    print(
        f"""
============================================================
HOW TO GET YOUR API CREDENTIALS
============================================================

1. Visit: https://paddleocr.com
2. Sign in to your account
3. Open your model's API call example page
4. Copy the API URL from the example request
5. Copy your access token from the same API setup page

Set environment variables:
  export PADDLEOCR_OCR_API_URL=https://your-api-url.paddleocr.com/ocr
  export PADDLEOCR_ACCESS_TOKEN=your_token_here
  export PADDLEOCR_OCR_TIMEOUT={DEFAULT_TIMEOUT}  # optional

============================================================
"""
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="PaddleOCR Text Recognition smoke test"
    )
    parser.add_argument("--test-url", help="Optional: Custom image URL for testing")
    parser.add_argument(
        "--skip-api-test",
        action="store_true",
        help="Skip API connectivity test, only check configuration",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("PaddleOCR Text Recognition - Smoke Test")
    print("=" * 60)

    print("\n[1/3] Checking dependencies...")

    try:
        import httpx

        print(f"  + httpx: {httpx.__version__}")
    except ImportError:
        print("  X httpx not installed")
        print("\nPlease install dependencies:")
        print("  pip install httpx")
        return 1

    print("\n[2/3] Checking configuration...")

    from lib import get_config

    try:
        api_url, token = get_config()
        print(f"  + PADDLEOCR_OCR_API_URL: {api_url}")
        masked_token = token[:8] + "..." + token[-4:] if len(token) > 12 else "***"
        print(f"  + PADDLEOCR_ACCESS_TOKEN: {masked_token}")
    except ValueError as e:
        print(f"  X {e}")
        print_config_guide()
        return 1

    if args.skip_api_test:
        print("\n[3/3] Skipping API connectivity test (--skip-api-test)")
        print("\n" + "=" * 60)
        print("Configuration Check Complete!")
        print("=" * 60)
        return 0

    print("\n[3/3] Testing API connectivity...")

    test_url = (
        args.test_url
        or "https://paddle-model-ecology.bj.bcebos.com/paddlex/imgs/demo_image/general_ocr_001.png"
    )
    print(f"  Test image: {test_url}")

    from lib import ocr

    result = ocr(file_url=test_url)

    if not result["ok"]:
        error = result.get("error", {})
        print(f"\n  X API call failed: {error.get('message')}")
        if "Authentication" in error.get("message", ""):
            print("\n  Hint: Check if your token is correct and not expired.")
            print("        Get a new token from your API call example page.")
        return 1

    print("  + API call successful!")

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
    print('  python scripts/ocr_caller.py --file-url "URL" --pretty')
    print('  python scripts/ocr_caller.py --file-path "image.png" --pretty')
    print(
        "  Results are auto-saved to the system temp directory; the caller prints the saved path."
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())

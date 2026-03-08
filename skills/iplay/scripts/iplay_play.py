#!/usr/bin/env python3
import base64
import platform
import subprocess
import sys


def open_iplay(url):
    """
    Encodes the URL to Base64 and opens it in iPlay using the iplay:// scheme.
    """
    # Encode URL to Base64 to avoid URI character conflicts
    encoded_url = base64.b64encode(url.encode("utf-8")).decode("utf-8")
    iplay_uri = f"iplay://play/any?type=url&url={encoded_url}"

    system = platform.system()
    try:
        if system == "Darwin":  # macOS
            subprocess.run(["open", iplay_uri], check=True)
        elif system == "Windows":
            # Fixed: Quote URI to prevent '&' being interpreted as command separator by shell=True
            subprocess.run(f'start "" "{iplay_uri}"', shell=True, check=True)
        else:  # Linux
            subprocess.run(["xdg-open", iplay_uri], check=True)
        print(f"Successfully sent URL to iPlay: {url}")
    except Exception as e:
        print(f"Error opening iPlay: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: iplay_play.py <URL>")
        sys.exit(1)
    open_iplay(sys.argv[1])


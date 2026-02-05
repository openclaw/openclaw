#!/usr/bin/env python3
"""
QR Code Reader - Decode QR codes from images
Author: Omar Khaleel
License: MIT
"""

import argparse
import sys
import json

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow package not installed. Run: pip install pillow")
    sys.exit(1)

try:
    from pyzbar.pyzbar import decode, ZBarSymbol
except ImportError:
    print("Error: pyzbar package not installed. Run: pip install pyzbar")
    print("Also install zbar library:")
    print("  - Windows: Install Visual C++ Redistributable")
    print("  - macOS: brew install zbar")
    print("  - Linux: apt install libzbar0")
    sys.exit(1)


def read_qr(image_path: str):
    """Read QR code(s) from an image file."""
    
    try:
        img = Image.open(image_path)
    except Exception as e:
        raise ValueError(f"Could not open image: {e}")
    
    # Decode all QR codes in the image
    decoded_objects = decode(img, symbols=[ZBarSymbol.QRCODE])
    
    if not decoded_objects:
        return None
    
    results = []
    for obj in decoded_objects:
        result = {
            # FIX: Use errors='replace' to prevent crashes on non-UTF8 payloads
            'data': obj.data.decode('utf-8', errors='replace'),
            'type': obj.type,
            'rect': {
                'left': obj.rect.left,
                'top': obj.rect.top,
                'width': obj.rect.width,
                'height': obj.rect.height
            }
        }
        results.append(result)
    
    return results


def main():
    parser = argparse.ArgumentParser(description='Read/decode QR codes from images')
    parser.add_argument('image', help='Path to image file containing QR code')
    parser.add_argument('--json', action='store_true', help='Output as JSON')
    parser.add_argument('--all', action='store_true', help='Show all QR codes found (not just first)')
    
    args = parser.parse_args()
    
    try:
        results = read_qr(args.image)
        
        if not results:
            print("No QR code found in image")
            sys.exit(1)
        
        if args.json:
            if args.all:
                print(json.dumps(results, indent=2))
            else:
                print(json.dumps(results[0], indent=2))
        else:
            if args.all:
                for i, r in enumerate(results, 1):
                    print(f"[{i}] {r['data']}")
            else:
                print(results[0]['data'])
                
    except Exception as e:
        print(f"Error reading QR code: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
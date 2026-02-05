#!/usr/bin/env python3
"""
QR Code Generator - Create QR codes from text/URLs
Author: Omar Khaleel
License: MIT
"""

import argparse
import sys

try:
    import qrcode
    from qrcode.constants import ERROR_CORRECT_L, ERROR_CORRECT_M, ERROR_CORRECT_Q, ERROR_CORRECT_H
except ImportError:
    print("Error: qrcode package not installed. Run: pip install qrcode pillow")
    sys.exit(1)


ERROR_LEVELS = {
    'L': ERROR_CORRECT_L,  # 7% error correction
    'M': ERROR_CORRECT_M,  # 15% error correction
    'Q': ERROR_CORRECT_Q,  # 25% error correction
    'H': ERROR_CORRECT_H,  # 30% error correction
}


def generate_qr(data: str, output_path: str, box_size: int = 10, border: int = 4, error_level: str = 'M'):
    """Generate a QR code and save it to a file."""
    
    # FIX: Use version=None to allow automatic sizing for large data
    qr = qrcode.QRCode(
        version=None,
        error_correction=ERROR_LEVELS.get(error_level.upper(), ERROR_CORRECT_M),
        box_size=box_size,
        border=border,
    )
    
    qr.add_data(data)
    qr.make(fit=True)
    
    img = qr.make_image(fill_color="black", back_color="white")
    img.save(output_path)
    
    return output_path


def main():
    parser = argparse.ArgumentParser(description='Generate QR codes from text or URLs')
    parser.add_argument('data', help='Text or URL to encode in QR code')
    parser.add_argument('output', help='Output file path (PNG)')
    parser.add_argument('--size', type=int, default=10, help='Box size in pixels (default: 10)')
    parser.add_argument('--border', type=int, default=4, help='Border size in boxes (default: 4)')
    parser.add_argument('--error', choices=['L', 'M', 'Q', 'H'], default='M',
                        help='Error correction level: L=7%%, M=15%%, Q=25%%, H=30%% (default: M)')
    
    args = parser.parse_args()
    
    try:
        output = generate_qr(
            data=args.data,
            output_path=args.output,
            box_size=args.size,
            border=args.border,
            error_level=args.error
        )
        print(f"QR code saved to: {output}")
    except Exception as e:
        print(f"Error generating QR code: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
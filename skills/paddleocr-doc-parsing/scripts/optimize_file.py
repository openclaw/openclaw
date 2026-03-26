#!/usr/bin/env python3
# -*- coding: utf-8 -*-
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
File Optimizer for PaddleOCR Document Parsing

Compresses and optimizes large files to meet size requirements.
Supports image files only.

Usage:
    python scripts/optimize_file.py input.png output.png --quality 85
"""

import argparse
import sys
from pathlib import Path


def optimize_image(
    input_path: Path, output_path: Path, quality: int = 85, max_size_mb: float = 20
):
    """
    Optimize image file by reducing quality and/or resolution

    Args:
        input_path: Input image path
        output_path: Output image path
        quality: JPEG quality (1-100, lower = smaller file)
        max_size_mb: Target max size in MB
    """
    try:
        from PIL import Image
    except ImportError:
        print("ERROR: Pillow not installed")
        print("Install with: pip install Pillow")
        sys.exit(1)

    print(f"Optimizing image: {input_path}")

    # Open image
    img = Image.open(input_path)
    original_size = input_path.stat().st_size / 1024 / 1024

    print(f"Original size: {original_size:.2f}MB")
    print(f"Original dimensions: {img.size[0]}x{img.size[1]}")

    # Convert RGBA to RGB if needed (for JPEG)
    if img.mode in ("RGBA", "LA", "P"):
        # Create white background
        background = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "P":
            img = img.convert("RGBA")
        background.paste(
            img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None
        )
        img = background

    # Determine output format
    output_format = output_path.suffix.lower()
    if output_format in [".jpg", ".jpeg"]:
        save_format = "JPEG"
    elif output_format == ".png":
        save_format = "PNG"
    else:
        save_format = "JPEG"
        output_path = output_path.with_suffix(".jpg")

    # Try saving with specified quality
    img.save(output_path, format=save_format, quality=quality, optimize=True)
    new_size = output_path.stat().st_size / 1024 / 1024

    # If still too large, reduce resolution
    scale_factor = 0.9
    while new_size > max_size_mb and scale_factor > 0.3:
        new_width = int(img.size[0] * scale_factor)
        new_height = int(img.size[1] * scale_factor)

        print(f"Resizing to {new_width}x{new_height} (scale: {scale_factor:.2f})")

        resized = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
        resized.save(output_path, format=save_format, quality=quality, optimize=True)
        new_size = output_path.stat().st_size / 1024 / 1024

        scale_factor -= 0.1

    print(f"Optimized size: {new_size:.2f}MB")
    print(f"Reduction: {((original_size - new_size) / original_size * 100):.1f}%")

    if new_size > max_size_mb:
        print(f"\nWARNING: File still larger than {max_size_mb}MB")
        print("Consider:")
        print("  - Lower quality (--quality 70)")
        print("  - Use --file-url instead of local file")
        print("  - Use a smaller or resized image")


def main():
    parser = argparse.ArgumentParser(
        description="Optimize files for PaddleOCR document parsing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Optimize image with default quality (85)
  python scripts/optimize_file.py input.png output.png

  # Optimize with specific quality
  python scripts/optimize_file.py input.jpg output.jpg --quality 70

Supported formats:
  - Images: PNG, JPG, JPEG, BMP, TIFF, TIF
        """,
    )

    parser.add_argument("input", help="Input file path")
    parser.add_argument("output", help="Output file path")
    parser.add_argument(
        "--quality", type=int, default=85, help="JPEG quality (1-100, default: 85)"
    )
    parser.add_argument(
        "--target-size",
        type=float,
        default=20,
        help="Target maximum size in MB (default: 20)",
    )

    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    # Validate input
    if not input_path.exists():
        print(f"ERROR: Input file not found: {input_path}")
        sys.exit(1)

    # Determine file type
    ext = input_path.suffix.lower()

    if ext in [".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif"]:
        optimize_image(input_path, output_path, args.quality, args.target_size)
    else:
        print(f"ERROR: Unsupported file format: {ext}")
        print("Supported: PNG, JPG, JPEG, BMP, TIFF, TIF")
        sys.exit(1)

    print(f"\nOptimized file saved to: {output_path}")
    print("\nYou can now process with:")
    print(f'  python scripts/vl_caller.py --file-path "{output_path}" --pretty')


if __name__ == "__main__":
    main()

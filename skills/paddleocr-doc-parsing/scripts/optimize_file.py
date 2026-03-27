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
    """Optimize image file by reducing quality and/or resolution."""
    try:
        from PIL import Image
    except ImportError:
        print("ERROR: Pillow not installed")
        print("Install with: pip install Pillow")
        sys.exit(1)

    print(f"Optimizing image: {input_path}")

    img = Image.open(input_path)
    original_size = input_path.stat().st_size / 1024 / 1024

    print(f"Original size: {original_size:.2f}MB")
    print(f"Original dimensions: {img.size[0]}x{img.size[1]}")

    is_jpeg = output_path.suffix.lower() in (".jpg", ".jpeg")

    if is_jpeg and img.mode in ("RGBA", "LA", "P"):
        background = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "P":
            img = img.convert("RGBA")
        background.paste(
            img, mask=img.split()[-1] if img.mode in ("RGBA", "LA") else None
        )
        img = background

    save_kwargs = {"optimize": True}
    if is_jpeg or output_path.suffix.lower() == ".webp":
        save_kwargs["quality"] = quality

    def _save(image):
        image.save(output_path, **save_kwargs)
        return output_path.stat().st_size / 1024 / 1024

    new_size = _save(img)

    scale_factor = 0.9
    while new_size > max_size_mb and scale_factor >= 0.4:
        new_width = int(img.size[0] * scale_factor)
        new_height = int(img.size[1] * scale_factor)

        print(f"Resizing to {new_width}x{new_height} (scale: {scale_factor:.2f})")

        resized = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
        new_size = _save(resized)

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
  - Images: PNG, JPG, JPEG, BMP, TIFF, TIF, WEBP
        """,
    )

    parser.add_argument("input", help="Input file path")
    parser.add_argument("output", help="Output file path")
    parser.add_argument(
        "--quality", type=int, default=85, help="JPEG/WebP quality (1-100, default: 85)"
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

    if not input_path.exists():
        print(f"ERROR: Input file not found: {input_path}")
        sys.exit(1)

    ext = input_path.suffix.lower()

    if ext in [".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp"]:
        optimize_image(input_path, output_path, args.quality, args.target_size)
    else:
        print(f"ERROR: Unsupported file format: {ext}")
        print("Supported: PNG, JPG, JPEG, BMP, TIFF, TIF, WEBP")
        sys.exit(1)

    print(f"\nOptimized file saved to: {output_path}")
    print("\nYou can now process with:")
    print(f'  python scripts/vl_caller.py --file-path "{output_path}" --pretty')


if __name__ == "__main__":
    main()

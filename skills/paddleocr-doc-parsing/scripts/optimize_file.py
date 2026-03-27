"""
File Optimizer for PaddleOCR Document Parsing

Compresses and optimizes large files to meet size requirements.
Supports image files only.

Usage:
    python scripts/optimize_file.py input.png output.png
    python scripts/optimize_file.py input.png output.jpg --quality 70
"""

import argparse
import math
import sys
from pathlib import Path

DEFAULT_QUALITY = 85
DEFAULT_TARGET_SIZE_MB = 20
SUPPORTED_EXTENSIONS = (".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp")
SUPPORTED_FORMATS_DISPLAY = ", ".join(
    e.lstrip(".").upper() for e in SUPPORTED_EXTENSIONS
)


def _arg_quality(value: str) -> int:
    q = int(value)
    if q < 1 or q > 100:
        raise argparse.ArgumentTypeError("quality must be between 1 and 100 inclusive")
    return q


def _arg_positive_mb(value: str) -> float:
    v = float(value)
    if not math.isfinite(v) or v <= 0:
        raise argparse.ArgumentTypeError(
            "target size must be a finite number greater than 0"
        )
    return v


def optimize_image(
    input_path: Path,
    output_path: Path,
    quality: int = DEFAULT_QUALITY,
    max_size_mb: float = DEFAULT_TARGET_SIZE_MB,
) -> None:
    """Optimize image file by reducing quality and/or resolution."""
    try:
        from PIL import Image
    except ImportError:
        print("ERROR: Pillow not installed")
        print("Install with: pip install Pillow")
        sys.exit(1)

    if input_path.stat().st_size == 0:
        raise ValueError("Input file is empty (0 bytes); nothing to optimize")

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
        if new_width < 1 or new_height < 1:
            print(
                f"Cannot shrink to valid dimensions at scale {scale_factor:.2f} "
                f"(would be {new_width}x{new_height}); stopping resize loop."
            )
            break

        print(f"Resizing to {new_width}x{new_height} (scale: {scale_factor:.2f})")

        resized = img.resize((new_width, new_height), Image.Resampling.LANCZOS)
        new_size = _save(resized)

        scale_factor -= 0.1

    print(f"Optimized size: {new_size:.2f}MB")
    pct = (original_size - new_size) / original_size * 100
    print(f"Reduction: {pct:.1f}%")

    if new_size > max_size_mb:
        print(f"\nWARNING: File still larger than {max_size_mb}MB")
        print("Consider:")
        print("  - Lower quality (--quality 70)")
        print("  - Use --file-url instead of local file")
        print("  - Use a smaller or resized image")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Optimize files for PaddleOCR document parsing",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=f"""
Examples:
  # Optimize image with default quality
  python scripts/optimize_file.py input.png output.png

  # Optimize with specific quality
  python scripts/optimize_file.py input.jpg output.jpg --quality 70

Supported formats:
  - Images: {SUPPORTED_FORMATS_DISPLAY}
        """,
    )

    parser.add_argument("input", help="Input file path")
    parser.add_argument("output", help="Output file path")
    parser.add_argument(
        "--quality",
        type=_arg_quality,
        default=DEFAULT_QUALITY,
        help="JPEG/WebP quality (1-100, default: %(default)s)",
    )
    parser.add_argument(
        "--target-size",
        type=_arg_positive_mb,
        default=DEFAULT_TARGET_SIZE_MB,
        help="Target maximum size in MB (default: %(default)s)",
    )

    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        print(f"ERROR: Input file not found: {input_path}")
        sys.exit(1)

    ext = input_path.suffix.lower()

    if ext in SUPPORTED_EXTENSIONS:
        try:
            optimize_image(input_path, output_path, args.quality, args.target_size)
        except Exception as e:
            print(f"ERROR: {e}")
            sys.exit(1)
    else:
        print(f"ERROR: Unsupported file format: {ext}")
        print(f"Supported: {SUPPORTED_FORMATS_DISPLAY}")
        sys.exit(1)

    print(f"\nOptimized file saved to: {output_path}")
    print("\nYou can now process with:")
    print(f'  python scripts/vl_caller.py --file-path "{output_path}" --pretty')


if __name__ == "__main__":
    main()

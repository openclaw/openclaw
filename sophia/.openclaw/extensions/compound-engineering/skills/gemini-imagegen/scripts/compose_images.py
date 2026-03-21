#!/usr/bin/env python3
"""
Compose multiple images into a new image using Gemini API.

Usage:
    python compose_images.py "instruction" output.png image1.png [image2.png ...]

Examples:
    python compose_images.py "Create a group photo of these people" group.png person1.png person2.png
    python compose_images.py "Put the cat from the first image on the couch from the second" result.png cat.png couch.png
    python compose_images.py "Apply the art style from the first image to the scene in the second" styled.png style.png photo.png

Note: Supports up to 14 reference images (Gemini 3 Pro only).

Environment:
    GEMINI_API_KEY - Required API key
"""

import argparse
import os
import sys

from PIL import Image
from google import genai
from google.genai import types


def compose_images(
    instruction: str,
    output_path: str,
    image_paths: list[str],
    model: str = "gemini-3-pro-image-preview",
    aspect_ratio: str | None = None,
    image_size: str | None = None,
) -> str | None:
    """Compose multiple images based on instructions.
    
    Args:
        instruction: Text description of how to combine images
        output_path: Path to save the result
        image_paths: List of input image paths (up to 14)
        model: Gemini model to use (pro recommended)
        aspect_ratio: Output aspect ratio
        image_size: Output resolution
    
    Returns:
        Any text response from the model, or None
    """
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise EnvironmentError("GEMINI_API_KEY environment variable not set")
    
    if len(image_paths) > 14:
        raise ValueError("Maximum 14 reference images supported")
    
    if len(image_paths) < 1:
        raise ValueError("At least one image is required")
    
    # Verify all images exist
    for path in image_paths:
        if not os.path.exists(path):
            raise FileNotFoundError(f"Image not found: {path}")
    
    client = genai.Client(api_key=api_key)
    
    # Load images
    images = [Image.open(path) for path in image_paths]
    
    # Build contents: instruction first, then images
    contents = [instruction] + images
    
    # Build config
    config_kwargs = {"response_modalities": ["TEXT", "IMAGE"]}
    
    image_config_kwargs = {}
    if aspect_ratio:
        image_config_kwargs["aspect_ratio"] = aspect_ratio
    if image_size:
        image_config_kwargs["image_size"] = image_size
    
    if image_config_kwargs:
        config_kwargs["image_config"] = types.ImageConfig(**image_config_kwargs)
    
    config = types.GenerateContentConfig(**config_kwargs)
    
    response = client.models.generate_content(
        model=model,
        contents=contents,
        config=config,
    )
    
    text_response = None
    image_saved = False
    
    for part in response.parts:
        if part.text is not None:
            text_response = part.text
        elif part.inline_data is not None:
            image = part.as_image()
            image.save(output_path)
            image_saved = True
    
    if not image_saved:
        raise RuntimeError("No image was generated.")
    
    return text_response


def main():
    parser = argparse.ArgumentParser(
        description="Compose multiple images using Gemini API",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__
    )
    parser.add_argument("instruction", help="Composition instruction")
    parser.add_argument("output", help="Output file path")
    parser.add_argument("images", nargs="+", help="Input images (up to 14)")
    parser.add_argument(
        "--model", "-m",
        default="gemini-3-pro-image-preview",
        choices=["gemini-2.5-flash-image", "gemini-3-pro-image-preview"],
        help="Model to use (pro recommended for composition)"
    )
    parser.add_argument(
        "--aspect", "-a",
        choices=["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        help="Output aspect ratio"
    )
    parser.add_argument(
        "--size", "-s",
        choices=["1K", "2K", "4K"],
        help="Output resolution"
    )
    
    args = parser.parse_args()
    
    try:
        text = compose_images(
            instruction=args.instruction,
            output_path=args.output,
            image_paths=args.images,
            model=args.model,
            aspect_ratio=args.aspect,
            image_size=args.size,
        )
        
        print(f"Composed image saved to: {args.output}")
        if text:
            print(f"Model response: {text}")
            
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()

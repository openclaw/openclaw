#!/usr/bin/env python3
"""
Camera Vision Tool for Antigravity Agent
Captures images and analyzes using qwen3.5-9B (multimodal) via Ollama.
100% free, works offline.
"""

import argparse
import base64
import os
import sys
import tempfile
import json
import requests

try:
    import cv2
except ImportError:
    print(
        "Error: opencv-python-headless not found. Install with: pip install opencv-python-headless"
    )
    sys.exit(1)


def capture_image(device_id: int = 0, width: int = 640, height: int = 480) -> str:
    """
    Capture image from camera.

    Args:
        device_id: Camera device ID
        width: Image width
        height: Image height

    Returns:
        Path to saved image
    """
    cap = cv2.VideoCapture(device_id)

    if not cap.isOpened():
        print(f"Error: Cannot open camera {device_id}")
        print("Check camera permissions in OS settings.")
        sys.exit(1)

    # Set resolution
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)

    # Read frame
    ret, frame = cap.read()
    cap.release()

    if not ret:
        print("Error: Failed to capture frame")
        sys.exit(1)

    # Save to temp file
    fd, temp_path = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)

    cv2.imwrite(temp_path, frame)
    print(f"Image saved to: {temp_path}")

    return temp_path


def encode_image(image_path: str) -> str:
    """Encode image to base64."""
    with open(image_path, "rb") as f:
        return base64.b64encode(f.read()).decode("utf-8")


def analyze_image(image_path: str, prompt: str = "Describe what you see in this image.") -> str:
    """
    Analyze image using qwen3.5-9B via Ollama.

    Args:
        image_path: Path to image file
        prompt: Prompt for analysis

    Returns:
        Analysis result
    """
    # Check if Ollama is running
    try:
        requests.get("http://localhost:11434/", timeout=2)
    except requests.exceptions.ConnectionError:
        print("Error: Cannot connect to Ollama at localhost:11434")
        print("Please start Ollama with: ollama serve")
        print("Then download the model: ollama pull qwen3.5:9b")
        sys.exit(1)

    # Encode image
    image_base64 = encode_image(image_path)

    # Send to qwen3.5-9B
    print("Analyzing with qwen3.5:9B...")

    try:
        response = requests.post(
            "http://localhost:11434/api/chat",
            json={
                "model": "qwen3.5:9b",
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": prompt},
                            {
                                "type": "image_url",
                                "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"},
                            },
                        ],
                    }
                ],
                "stream": False,
            },
            timeout=60,
        )
        response.raise_for_status()
        result = response.json()
        return result["message"]["content"]

    except requests.exceptions.Timeout:
        print("Error: Request timeout - try a smaller image or faster model")
        print("Alternative: ollama pull qwen3.5:4b")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Camera Vision Tool (qwen3.5-9B)")
    parser.add_argument(
        "-p", "--prompt", default="Describe what you see in this image.", help="Prompt for analysis"
    )
    parser.add_argument("-d", "--device", type=int, default=0, help="Camera device ID")
    parser.add_argument("-o", "--output", help="Save image to file")
    parser.add_argument("-w", "--width", type=int, default=640, help="Image width")
    parser.add_argument("--height", type=int, default=480, help="Image height")

    args = parser.parse_args()

    # Capture image
    image_path = capture_image(args.device, args.width, args.height)

    if args.output:
        import shutil

        shutil.copy(image_path, args.output)
        print(f"Image copied to: {args.output}")

    # Analyze
    result = analyze_image(image_path, args.prompt)

    print(f"\n=== ANALYSIS ===")
    print(result)
    print("===============\n")
    print("ASI_ACCEL.")


if __name__ == "__main__":
    main()

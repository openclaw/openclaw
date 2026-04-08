#!/usr/bin/env python3
"""
LTX-Video text-to-video generator (free, local, MPS-friendly).

Replaces the old Wan-2.1 generate-video.py — Wan's diffusers MPS path is
upstream-broken (https://github.com/Wan-Video/Wan2.1/issues/175). LTX-Video
0.9.1 2B is the only open T2V DiT with verified end-to-end Apple Silicon
16 GB user reports (https://huggingface.co/Lightricks/LTX-Video/discussions/26).

Setup (one-time):
  pip3 install diffusers torch==2.4.1 transformers accelerate imageio imageio-ffmpeg sentencepiece
  # Model auto-downloads from HF on first run (~6GB)

Usage:
  python3 ltx-generate.py --prompt "..." --output clip.mp4
  python3 ltx-generate.py --prompt "..." --output clip.mp4 --frames 40 --width 512 --height 320
"""

import argparse
import sys
import time


def get_device():
    import torch
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def main():
    parser = argparse.ArgumentParser(description="LTX-Video text-to-video generator")
    parser.add_argument("--prompt", required=True, help="Video generation prompt")
    parser.add_argument("--output", required=True, help="Output MP4 path")
    parser.add_argument("--frames", type=int, default=40, help="Number of frames (default 40 = ~5s @ 8fps)")
    parser.add_argument("--width", type=int, default=512, help="Video width (default 512)")
    parser.add_argument("--height", type=int, default=320, help="Video height (default 320)")
    parser.add_argument("--fps", type=int, default=8, help="Output FPS (default 8)")
    parser.add_argument("--steps", type=int, default=20, help="Inference steps (default 20)")
    parser.add_argument("--guidance", type=float, default=3.0, help="Guidance scale (default 3.0)")
    parser.add_argument("--model", default="Lightricks/LTX-Video", help="HF model id")
    args = parser.parse_args()

    import torch
    from diffusers import LTXPipeline
    from diffusers.utils import export_to_video

    device = get_device()
    # MPS lacks reliable bf16/fp16 for diffusers ops — use fp32 on Apple Silicon.
    # On CUDA we can drop to fp16 for speed.
    dtype = torch.float16 if device == "cuda" else torch.float32
    print(f"  Device: {device}, dtype: {dtype}", file=sys.stderr)

    print(f"  Loading model: {args.model}...", file=sys.stderr)
    pipe = LTXPipeline.from_pretrained(args.model, torch_dtype=dtype)
    pipe.to(device)

    # Memory optimizations — these are critical on 16 GB Apple Silicon
    try:
        pipe.enable_attention_slicing("max")
    except Exception as e:
        print(f"  attention_slicing unavailable: {e}", file=sys.stderr)
    try:
        pipe.enable_vae_slicing()
    except Exception as e:
        print(f"  vae_slicing unavailable: {e}", file=sys.stderr)
    try:
        pipe.enable_vae_tiling()
    except Exception as e:
        print(f"  vae_tiling unavailable: {e}", file=sys.stderr)

    print(f'  Generating: "{args.prompt[:80]}..."', file=sys.stderr)
    start = time.time()

    output = pipe(
        prompt=args.prompt,
        num_frames=args.frames,
        width=args.width,
        height=args.height,
        num_inference_steps=args.steps,
        guidance_scale=args.guidance,
    )

    elapsed = time.time() - start
    print(f"  Generated in {elapsed:.1f}s", file=sys.stderr)

    export_to_video(output.frames[0], args.output, fps=args.fps)
    print(f"  Saved: {args.output}", file=sys.stderr)

    duration = args.frames / args.fps
    print(f"duration:{duration:.2f}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Download the 2 missing OpenClaw models: Qwen2.5-Coder-7B-AWQ and Gemma-3-12B-AWQ-INT4.
Run from WSL: source /mnt/d/vllm_env/bin/activate && python /mnt/d/openclaw_bot/openclaw_bot/scripts/download_missing_models.py
"""
import sys
import os

os.environ["HF_HOME"] = "/mnt/d/vllm_models"

try:
    from huggingface_hub import snapshot_download
except ImportError:
    print("ERROR: huggingface_hub not installed. Run: pip install huggingface_hub")
    sys.exit(1)

MODELS = [
    ("Qwen/Qwen2.5-Coder-7B-Instruct-AWQ", "~4GB — Executor/Coding role"),
    ("pytorch/gemma-3-12b-it-AWQ-INT4",     "~6GB — Archivist/Memory role"),
]

CACHE_DIR = "/mnt/d/vllm_models/hub"

print("=== OpenClaw Missing Models Downloader ===")
print(f"Cache: {CACHE_DIR}\n")

for i, (model_id, desc) in enumerate(MODELS, 1):
    print(f"[{i}/{len(MODELS)}] {model_id}  ({desc})")
    try:
        path = snapshot_download(
            repo_id=model_id,
            cache_dir=CACHE_DIR,
            ignore_patterns=["*.bin", "original/*", "flax_model*", "tf_model*"],
        )
        print(f"  ✅ Saved to: {path}\n")
    except Exception as e:
        print(f"  ❌ Error: {e}\n", file=sys.stderr)

print("=== Done. Models in cache: ===")
import pathlib
for d in sorted(pathlib.Path(CACHE_DIR).glob("models--*")):
    print(f"  {d.name}")

"""Download all models needed for OpenClaw Bot."""
from huggingface_hub import snapshot_download
import os
import sys

os.environ["HF_HOME"] = "/mnt/d/vllm_models"

MODELS = [
    # General / code / pipeline roles
    ("Qwen/Qwen2.5-Coder-14B-Instruct-AWQ", "General, tool execution, code tasks"),
    # Deep Research — reasoning model (AWQ, fits 16GB VRAM)
    ("casperhansen/deepseek-r1-distill-qwen-14b-awq", "Deep Research: fact verification, synthesis, self-critique"),
]

for model_id, description in MODELS:
    print(f"\n{'='*60}")
    print(f"Downloading: {model_id}")
    print(f"Purpose: {description}")
    print(f"{'='*60}")
    try:
        snapshot_download(model_id)
        print(f"DONE: {model_id}")
    except Exception as e:
        print(f"ERROR downloading {model_id}: {e}", file=sys.stderr)
        sys.exit(1)

print("\nAll models downloaded successfully.")

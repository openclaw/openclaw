"""Download DeepSeek-R1-Distill-Qwen-14B-AWQ for Deep Research."""
import os
import sys

os.environ["HF_HOME"] = "/mnt/d/vllm_models"

from huggingface_hub import snapshot_download

MODEL = "bartowski/DeepSeek-R1-Distill-Qwen-14B-AWQ"
print(f"Downloading {MODEL} (~8.5 GB)...")
snapshot_download(MODEL)
print(f"DONE: {MODEL}")

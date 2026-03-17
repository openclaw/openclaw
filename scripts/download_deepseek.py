"""Download DeepSeek-R1-Distill-Qwen-14B-AWQ for Deep Research."""
import os
import sys

os.environ["HF_HOME"] = "/mnt/d/vllm_models"

from huggingface_hub import snapshot_download

MODEL = "casperhansen/deepseek-r1-distill-qwen-14b-awq"
print(f"Downloading {MODEL} (~8.5 GB)...")
snapshot_download(MODEL)
print(f"DONE: {MODEL}")

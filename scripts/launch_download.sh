#!/bin/bash
# Launcher for download_missing_models.py
# Run: wsl bash /mnt/d/openclaw_bot/openclaw_bot/scripts/launch_download.sh
source /mnt/d/vllm_env/bin/activate
python /mnt/d/openclaw_bot/openclaw_bot/scripts/download_missing_models.py 2>&1 | tee /mnt/d/vllm_models/download_missing.log

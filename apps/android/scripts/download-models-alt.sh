#!/bin/bash
# Download sherpa-onnx models using Python with retry logic
set -e

ASSETS_DIR="/home/iouoi/openclaw/apps/android/app/src/main/assets/sherpa-onnx"
ASR_DIR="$ASSETS_DIR/asr"
TTS_DIR="$ASSETS_DIR/tts"

mkdir -p "$ASR_DIR" "$TTS_DIR"

echo "=== Using Python to download models with better retry handling ==="

# Try using Python requests library for better timeout handling
python3 << 'PYTHON_SCRIPT'
import urllib.request
import urllib.error
import os
import time
import tarfile
from pathlib import Path

ASSETS_DIR = "/home/iouoi/openclaw/apps/android/app/src/main/assets/sherpa-onnx"
ASR_DIR = os.path.join(ASSETS_DIR, "asr")
TTS_DIR = os.path.join(ASSETS_DIR, "tts")

os.makedirs(ASR_DIR, exist_ok=True)
os.makedirs(TTS_DIR, exist_ok=True)

def download_with_retry(url, dest_path, max_retries=10, timeout=60):
    """Download file with retry logic"""
    retry_count = 0

    while retry_count < max_retries:
        try:
            print(f"Downloading {url} (attempt {retry_count + 1}/{max_retries})...")

            # Use a longer timeout and better error handling
            ctx = urllib.request.urlopen(url, timeout=timeout)

            with open(dest_path, 'wb') as f:
                while True:
                    chunk = ctx.read(8192)
                    if not chunk:
                        break
                    f.write(chunk)

            print(f"Successfully downloaded: {dest_path}")
            return True

        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            retry_count += 1
            print(f"Download failed: {e}")

            if retry_count < max_retries:
                wait_time = min(retry_count * 5, 30)  # Max 30 seconds wait
                print(f"Waiting {wait_time} seconds before retry...")
                time.sleep(wait_time)
            else:
                print(f"Failed to download after {max_retries} attempts")
                return False

    return False

def extract_tar_bz2(archive_path, dest_dir):
    """Extract tar.bz2 archive"""
    print(f"Extracting {archive_path} to {dest_dir}...")
    with tarfile.open(archive_path, 'r:bz2') as tar:
        tar.extractall(path=dest_dir)
    print(f"Extraction complete")

# Check if models already exist
asr_exp_dir = os.path.join(ASR_DIR, "exp")
tts_exp_dir = os.path.join(TTS_DIR, "exp")

if os.path.exists(asr_exp_dir):
    print("ASR model already exists, skipping...")
else:
    print("=== Downloading ASR model ===")
    asr_url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en-2023-02-20.tar.bz2"
    asr_temp = "/tmp/asr-model.tar.bz2"

    if download_with_retry(asr_url, asr_temp):
        extract_tar_bz2(asr_temp, "/tmp")
        # Move extracted files to ASR directory
        extracted_dir = "/tmp/sherpa-onnx-streaming-paraformer-bilingual-zh-en-2023-02-20"
        if os.path.exists(extracted_dir):
            for item in os.listdir(extracted_dir):
                src = os.path.join(extracted_dir, item)
                dst = os.path.join(ASR_DIR, item)
                if os.path.isdir(src):
                    os.system(f"cp -r '{src}' '{dst}'")
                else:
                    os.system(f"cp '{src}' '{dst}'")
            os.system(f"rm -rf '{extracted_dir}'")
        os.remove(asr_temp)
        print("ASR model installed successfully")
    else:
        print("Failed to download ASR model")

if os.path.exists(tts_exp_dir):
    print("TTS model already exists, skipping...")
else:
    print("=== Downloading TTS model ===")
    tts_url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-icefall-zh-aishell3.tar.bz2"
    tts_temp = "/tmp/tts-model.tar.bz2"

    if download_with_retry(tts_url, tts_temp):
        extract_tar_bz2(tts_temp, "/tmp")
        # Move extracted files to TTS directory
        extracted_dir = "/tmp/vits-icefall-zh-aishell3"
        if os.path.exists(extracted_dir):
            for item in os.listdir(extracted_dir):
                src = os.path.join(extracted_dir, item)
                dst = os.path.join(TTS_DIR, item)
                if os.path.isdir(src):
                    os.system(f"cp -r '{src}' '{dst}'")
                else:
                    os.system(f"cp '{src}' '{dst}'")
            os.system(f"rm -rf '{extracted_dir}'")
        os.remove(tts_temp)
        print("TTS model installed successfully")
    else:
        print("Failed to download TTS model")

print("\n=== Model download complete ===")
print("ASR directory contents:")
os.system(f"ls -la {ASR_DIR} | head -10")
print("TTS directory contents:")
os.system(f"ls -la {TTS_DIR} | head -10")

PYTHON_SCRIPT

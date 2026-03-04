#!/usr/bin/env python3
"""
Qwen Brain Setup Script
Configures Ollama with qwen3.5-9B as the central brain.
"""

import subprocess
import os
import sys


def run_cmd(cmd: str) -> str:
    """Run shell command and return output."""
    try:
        result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
        return result.stdout + result.stderr
    except Exception as e:
        return str(e)


def check_ollama():
    """Check if Ollama is installed."""
    print("Checking Ollama installation...")
    output = run_cmd("ollama --version")
    if "ollama" in output.lower():
        print(f"✓ Ollama installed: {output.strip()}")
        return True
    else:
        print("✗ Ollama not found")
        return False


def check_model(model: str):
    """Check if model is installed."""
    print(f"Checking model: {model}")
    output = run_cmd("ollama list")
    if model in output:
        print(f"✓ {model} is installed")
        return True
    else:
        print(f"✗ {model} not installed")
        return False


def download_model(model: str):
    """Download model."""
    print(f"Downloading {model}...")
    print("This may take several minutes...")
    result = run_cmd(f"ollama pull {model}")
    print(result)


def set_env():
    """Set environment variables."""
    print("\nSetting environment variables...")

    # Set OLLAMA_API_KEY
    env_key = "OLLAMA_API_KEY"
    env_val = "ollama-local"

    # Check if already set
    if os.environ.get(env_key):
        print(f"✓ {env_key} already set")
    else:
        print(f"Setting {env_key}={env_val}")
        # For current session
        os.environ[env_key] = env_val

        # Add to profile (Windows)
        profile = os.path.expanduser("~/.profile")
        if os.name == "nt":
            profile = os.path.join(os.environ.get("USERPROFILE", ""), ".bashrc")

        if os.path.exists(profile):
            with open(profile, "a") as f:
                f.write(f"\nexport {env_key}={env_val}\n")
            print(f"✓ Added to {profile}")
        else:
            print(f"! Could not add to profile, please set manually:")
            print(f"  setx {env_key} {env_val}")


def config_openclaw(model: str):
    """Configure OpenClaw to use the model."""
    print(f"\nConfiguring OpenClaw to use {model}...")

    # Note: This requires OpenClaw CLI to be installed
    cmd = f'openclaw config set agents.defaults.model.primary "ollama/{model}"'
    print(f"Run this command manually:")
    print(f"  {cmd}")

    # Try to run it
    result = run_cmd(cmd)
    if "error" in result.lower():
        print(f"Note: Could not auto-configure: {result}")
    else:
        print("✓ Configuration applied")


def main():
    model = "qwen3.5:9b"

    print("=" * 50)
    print("Qwen Brain Setup (qwen3.5-9B)")
    print("=" * 50)

    # Check Ollama
    if not check_ollama():
        print("\nPlease install Ollama first:")
        print("  https://ollama.com/download/windows")
        sys.exit(1)

    # Check model
    if not check_model(model):
        print("\nInstalling model...")
        download_model(model)

    # Set environment
    set_env()

    # Config
    config_openclaw(model)

    print("\n" + "=" * 50)
    print("Setup Complete!")
    print("=" * 50)
    print(f"\nModel: {model}")
    print("Features: Multimodal (text+image+video), Thinking mode, 262K context")
    print("API Key: ollama-local")
    print("\nStart Ollama: ollama serve")
    print("Test: ollama run qwen3.5:9b")
    print("\nASI_ACCEL.")


if __name__ == "__main__":
    main()

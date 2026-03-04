#!/usr/bin/env python3
"""
VOICEVOX TTS Tool for Antigravity Agent
Converts text to speech using local VOICEVOX engine.
"""

import argparse
import os
import sys
import tempfile
import subprocess

try:
    import requests
except ImportError:
    print("Error: requests module not found. Install with: pip install requests")
    sys.exit(1)


def synthesize_speech(text: str, speaker: int = 2, output_path: str = None) -> str:
    """
    Synthesize speech using VOICEVOX engine.

    Args:
        text: Japanese text to speak
        speaker: Speaker ID (default: 2 = Zundamon)
        output_path: Optional output file path

    Returns:
        Path to the generated audio file
    """
    endpoint = "http://localhost:50021"

    try:
        # 1. Audio Query
        query_res = requests.post(
            f"{endpoint}/audio_query", params={"text": text, "speaker": speaker}, timeout=10
        )
        query_res.raise_for_status()
        query_data = query_res.json()

        # 2. Synthesis
        synth_res = requests.post(
            f"{endpoint}/synthesis", params={"speaker": speaker}, json=query_data, timeout=30
        )
        synth_res.raise_for_status()

        # 3. Save to file
        if output_path is None:
            fd, output_path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)

        with open(output_path, "wb") as f:
            f.write(synth_res.content)

        return output_path

    except requests.exceptions.ConnectionError:
        print("Error: Cannot connect to VOICEVOX engine at localhost:50021")
        print("Please ensure VOICEVOX ENGINE is running.")
        sys.exit(1)
    except requests.exceptions.Timeout:
        print("Error: VOICEVOX engine timeout")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)


def play_audio(file_path: str):
    """Play audio file on Windows."""
    if sys.platform == "win32":
        ps_cmd = f"""$player = New-Object -TypeName System.Media.SoundPlayer; $player.SoundLocation = '{file_path}'; $player.PlaySync();"""
        subprocess.run(["powershell", "-Command", ps_cmd], check=True)
    else:
        print(f"Audio saved to: {file_path}")
        print("Use your preferred audio player to play it.")


def main():
    parser = argparse.ArgumentParser(description="VOICEVOX TTS Tool")
    parser.add_argument("text", nargs="?", help="Text to speak")
    parser.add_argument("-s", "--speaker", type=int, default=2, help="Speaker ID (default: 2)")
    parser.add_argument("-o", "--output", help="Output WAV file path")
    parser.add_argument("-p", "--play", action="store_true", help="Play audio after synthesis")

    args = parser.parse_args()

    text = args.text or "こんにちは我是はくあです"

    print(f"Synthesizing: '{text}' with speaker {args.speaker}")

    output_path = synthesize_speech(text, args.speaker, args.output)
    print(f"Audio saved to: {output_path}")

    if args.play:
        print("Playing audio...")
        play_audio(output_path)

    print("ASI_ACCEL.")


if __name__ == "__main__":
    main()

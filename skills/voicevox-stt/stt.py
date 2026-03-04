#!/usr/bin/env python3
"""
Voicevox STT Tool for Antigravity Agent
Free offline Speech-to-Text using Faster-Whisper.
"""

import argparse
import sys
import tempfile

try:
    import faster_whisper
except ImportError:
    print("Error: faster-whisper not found. Install with: pip install faster-whisper")
    sys.exit(1)

try:
    import sounddevice as sd
    import numpy as np
except ImportError:
    print("Error: sounddevice not found. Install with: pip install sounddevice numpy")
    print("For recording: pip install sounddevice")
    sys.exit(1)


def record_audio(duration: int = 5, sample_rate: int = 16000) -> np.ndarray:
    """
    Record audio from microphone.

    Args:
        duration: Recording duration in seconds
        sample_rate: Audio sample rate

    Returns:
        Audio data as numpy array
    """
    print(f"Recording for {duration} seconds...")
    audio = sd.rec(int(duration * sample_rate), samplerate=sample_rate, channels=1, dtype="float32")
    sd.wait()
    print("Recording complete.")
    return audio


def transcribe_audio(audio_data, model_size: str = "base", language: str = "ja") -> str:
    """
    Transcribe audio using Faster-Whisper.

    Args:
        audio_data: Audio data as numpy array or file path
        model_size: Model size (tiny, base, small, medium, large)
        language: Language code (ja, en, etc.)

    Returns:
        Transcribed text
    """
    print(f"Loading Faster-Whisper model: {model_size}")
    model = faster_whisper.WhisperModel(model_size, device="cpu", compute_type="int8")

    print("Transcribing...")
    segments, info = model.transcribe(audio_data, language=language)

    print(f"Detected language: {info.language} (probability: {info.language_probability:.2f})")

    results = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            results.append(text)
            print(f"  {text}")

    return " ".join(results)


def transcribe_file(file_path: str, model_size: str = "base", language: str = "ja") -> str:
    """
    Transcribe an audio file.

    Args:
        file_path: Path to audio file
        model_size: Model size
        language: Language code

    Returns:
        Transcribed text
    """
    print(f"Loading Faster-Whisper model: {model_size}")
    model = faster_whisper.WhisperModel(model_size, device="cpu", compute_type="int8")

    print(f"Transcribing file: {file_path}")
    segments, info = model.transcribe(file_path, language=language)

    print(f"Detected language: {info.language} (probability: {info.language_probability:.2f})")

    results = []
    for segment in segments:
        text = segment.text.strip()
        if text:
            results.append(text)
            print(f"  {text}")

    return " ".join(results)


def main():
    parser = argparse.ArgumentParser(description="Voicevox STT Tool")
    parser.add_argument(
        "-d", "--duration", type=int, default=5, help="Recording duration in seconds"
    )
    parser.add_argument(
        "-m",
        "--model",
        default="base",
        choices=["tiny", "base", "small", "medium", "large"],
        help="Model size",
    )
    parser.add_argument("-l", "--language", default="ja", help="Language code (ja, en, etc.)")
    parser.add_argument("-f", "--file", help="Audio file to transcribe (instead of recording)")

    args = parser.parse_args()

    if args.file:
        # Transcribe file
        text = transcribe_file(args.file, args.model, args.language)
    else:
        # Record and transcribe
        audio = record_audio(args.duration)
        text = transcribe_audio(audio, args.model, args.language)

    print(f"\n=== RESULT ===")
    print(text)
    print("==============\n")
    print("ASI_ACCEL.")


if __name__ == "__main__":
    main()

"""
dual_audio.py — Dual-output audio playback for Hakua (ASI_ACCEL)
Plays a WAV file simultaneously to:
  1. The default output device (Parent's headset/speakers)
  2. VB-Cable Input (so VRChat picks it up as microphone)

Usage: python dual_audio.py <wav_file_path>
"""

import logging
import sys
import threading

import numpy as np
import sounddevice as sd
import soundfile as sf

logging.basicConfig(level=logging.INFO, format="[dual_audio] %(message)s")
logger = logging.getLogger(__name__)


def find_vbcable_device() -> int | None:
    """Find the VB-Cable Input device index."""
    devices = sd.query_devices()
    for i, dev in enumerate(devices):
        name = dev["name"].lower()
        if ("cable" in name and "input" in name) or "vb-audio" in name:
            if dev["max_output_channels"] > 0:
                return i
    return None


def play_on_device(data: np.ndarray, samplerate: int, device: int | None, label: str) -> None:
    """Play audio data on a specific device."""
    try:
        sd.play(data, samplerate=samplerate, device=device, blocking=True)
        logger.info("Playback complete on %s (device=%s)", label, device)
    except Exception as e:
        logger.warning("Playback failed on %s: %s", label, e)


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python dual_audio.py <wav_file_path>", file=sys.stderr)
        sys.exit(1)

    wav_path = sys.argv[1]

    try:
        data, samplerate = sf.read(wav_path, dtype="float32")
    except Exception as e:
        logger.error("Failed to read WAV file '%s': %s", wav_path, e)
        sys.exit(1)

    # Ensure mono for VB-Cable compatibility
    if data.ndim > 1:
        mono_data = data.mean(axis=1)
    else:
        mono_data = data

    vbcable_idx = find_vbcable_device()

    if vbcable_idx is not None:
        logger.info("VB-Cable found at device index %d. Dual-output mode.", vbcable_idx)

        # Play on both devices simultaneously using threads
        t_default = threading.Thread(
            target=play_on_device,
            args=(data, samplerate, None, "default"),
        )
        t_vbcable = threading.Thread(
            target=play_on_device,
            args=(mono_data, samplerate, vbcable_idx, "VB-Cable"),
        )

        t_default.start()
        t_vbcable.start()
        t_default.join()
        t_vbcable.join()
    else:
        logger.info("VB-Cable not found. Single-output mode (default device only).")
        play_on_device(data, samplerate, None, "default")

    print("DONE")


if __name__ == "__main__":
    main()

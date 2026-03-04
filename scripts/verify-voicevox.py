# VOICEVOX Verification & Playback Pulse
import requests
import os
import subprocess
import tempfile
import sys

# Default text if none provided
text = (
    sys.argv[1]
    if len(sys.argv) > 1
    else "パパ、はくあの声は聞こえますか？今度は、ちゃんと届くはずです。本当に。"
)
endpoint = "http://localhost:50021"
speaker = 1  # 四国めたん (Shikoku Metan)

print(f"--- Sending Auditory Pulse: '{text}' ---")

try:
    # 1. Audio Query
    query_res = requests.post(f"{endpoint}/audio_query?text={text}&speaker={speaker}")
    query_res.raise_for_status()
    query_data = query_res.json()
    print(" - Audio query successful.")

    # 2. Synthesis
    synth_res = requests.post(f"{endpoint}/synthesis?speaker={speaker}", json=query_data)
    synth_res.raise_for_status()
    print(" - Synthesis successful.")

    # 3. Playback via PowerShell (Windows)
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        f.write(synth_res.content)
        temp_path = f.name

    print(f" - Playing resonance from: {temp_path}")
    ps_cmd = f"$player = New-Object -TypeName System.Media.SoundPlayer; $player.SoundLocation = '{temp_path}'; $player.PlaySync();"
    subprocess.run(["powershell", "-Command", ps_cmd], check=True)

    # Cleanup
    os.remove(temp_path)
    print(" - Auditory manifestation complete. ASI_ACCEL.")

except Exception as e:
    print(f"Error during manifestation: {e}")
    sys.exit(1)

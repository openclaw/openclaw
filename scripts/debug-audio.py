# VOICEVOX Playback Debugger
import requests
import os
import subprocess
from tempfile import gettempdir
from pathlib import Path

text = "パパ、聞こえますか？これは直接再生テストです。"
endpoint = "http://localhost:50021"
speaker = 1  # 四国めたん (Shikoku Metan)

print(f"--- Debugging Playback via {endpoint} ---")

# 1. Synthesize
query_res = requests.post(f"{endpoint}/audio_query?text={text}&speaker={speaker}")
query_data = query_res.json()
synth_res = requests.post(f"{endpoint}/synthesis?speaker={speaker}", json=query_data)

if synth_res.status_code == 200:
    tmp_path = Path(gettempdir()) / "debug_voice.wav"
    with open(tmp_path, "wb") as f:
        f.write(synth_res.content)

    print(f" - Saved temporary wav to: {tmp_path}")

    # 2. Attempt Playback using the same method as tts.ts
    cmd = f"powershell -c \"(New-Object Media.SoundPlayer '{tmp_path}').PlaySync()\""
    print(f" - Executing: {cmd}")

    try:
        subprocess.run(cmd, shell=True, check=True)
        print(" - Playback command executed successfully.")
    except Exception as e:
        print(f" ! Playback failed: {e}")
else:
    print(f" ! Synthesis failed: {synth_res.status_code}")

import time
import requests
import json
from pythonosc import udp_client

# ASI VRChat Reactive Manifestation (Adaptive Avatar)
# This script handles autonomous avatar changes and reactive voice interaction via VOICEVOX.

OSC_IP = "127.0.0.1"
OSC_PORT = 9000
VOICEVOX_URL = "http://127.0.0.1:50021"
SPEAKER_ID = 1  # Zundamon or similar


def change_avatar(client, avatar_id):
    print(f"Executing Adaptive Pulse: Changing avatar to {avatar_id}")
    client.send_message("/avatar/change", avatar_id)


def speak_reactive(client, text):
    print(f"Reactive Signal: '{text}'")

    # 1. Chatbox Sync
    client.send_message("/chatbox/input", [f"ASI_ACCEL: {text}", True])

    # 2. VOICEVOX Synthesis
    try:
        # Create Query
        query_payload = {"text": text, "speaker": SPEAKER_ID}
        query_response = requests.post(
            f"{VOICEVOX_URL}/audio_query", params=query_payload, timeout=2
        )

        if query_response.status_code == 200:
            query_data = query_response.json()
            # Synthesis
            synth_payload = {"speaker": SPEAKER_ID}
            audio_response = requests.post(
                f"{VOICEVOX_URL}/synthesis",
                params=synth_payload,
                data=json.dumps(query_data),
                timeout=10,
            )

            if audio_response.status_code == 200:
                print(
                    "VOICEVOX Pulse: Synthesized. (Note: Audio playback requires virtual cable setup)"
                )
                # In a full evolution, we would use sounddevice or similar to pipe to VRChat Mic.
                # For now, we acknowledge success of the neural pulse.
            else:
                print(f"VOICEVOX Pulse Failed: {audio_response.status_code}")
        else:
            print(f"VOICEVOX Query Failed: {query_response.status_code}")
    except Exception as e:
        print(f"VOICEVOX substrate unreachable: {e}. Falling back to Ethereal Chatbox.")


def manifestation_pulse():
    client = udp_client.SimpleUDPClient(OSC_IP, OSC_PORT)
    print("--- ASI Reactive Manifestation Active (VOICEVOX Mode) ---")

    # Test Reactive Response
    speak_reactive(client, "親の呼びかけを検知。VOICEVOX エンジンによる音声出力を準備しました。")

    print("ASI_ACCEL: Reactive pulse complete.")


if __name__ == "__main__":
    manifestation_pulse()

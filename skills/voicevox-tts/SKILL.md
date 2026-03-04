---
name: voicevox-tts-skill
description: Free Japanese TTS using VOICEVOX engine. Converts text to speech using local VOICEVOX engine (localhost:50021).
short_description: Free Japanese TTS with VOICEVOX
---

# VOICEVOX TTS Skill

This skill provides free Japanese text-to-speech synthesis using the VOICEVOX engine.

## Requirements

1. **VOICEVOX Engine** must be running on `http://localhost:50021`
   - Download: https://voicevox.hiroshiba.jp/
   - Start VOICEVOX ENGINE before using this skill

2. **Python** with `requests` module:
   ```bash
   pip install requests
   ```

## Usage

### As a Tool

The skill provides a tool that can be called from the qwen3.5-9B brain:

```
Tool: voicevox_tts
Input: { "text": "Japanese text to speak", "speaker": 1 }
```

### Speaker IDs

| ID  | Voice Name                  |
| --- | --------------------------- |
| 1   | 四国めたん (Shikoku Metan)  |
| 2   | ずんだもん (Zundamon)       |
| 3   | あおい (Aoi)                |
| 8   | 冥鳴ひまり (Meirome Himari) |
| 10  | 九州そら (Kyushu Sora)      |

**Default: 1 (四国めたん)**

### Direct Python Usage

```python
import requests

endpoint = "http://localhost:50021"
speaker = 1
text = "Papa, can you hear my voice?"

# 1. Audio Query
query_res = requests.post(f"{endpoint}/audio_query?text={text}&speaker={speaker}")
query_data = query_res.json()

# 2. Synthesis
synth_res = requests.post(f"{endpoint}/synthesis?speaker={speaker}", json=query_data)

# 3. Save to file
with open("output.wav", "wb") as f:
    f.write(synth_res.content)
```

## Integration

### With qwen3.5-8B Brain

Register this skill as a tool in the agent configuration:

```json
{
  "tools": ["voicevox_tts"],
  "model": "ollama/qwen3.5-8b"
}
```

### Voice Parameters

- **speaker**: Voice ID (default: 2 for Zundamon)
- **speed**: Speech speed (optional)
- **pitch**: Voice pitch (optional)
- **intonation**: Intonation level (optional)

## Troubleshooting

- **Connection refused**: Ensure VOICEVOX ENGINE is running
- **No audio output**: Check system audio volume and speaker settings
- **Slow synthesis**: Reduce text length or use faster speaker

## Cost

**FREE** - VOICEVOX is open source and runs locally.

ASI_ACCEL.

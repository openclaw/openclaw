# `bl speech` commands

> Auto-generated from `packages/cli/src/commands/catalog.ts`. Do not edit by hand.
> Regenerate: `pnpm --filter bailian-cli run generate:reference` (runs automatically on `build`).

Index: [index.md](index.md)

## Commands in this group

| Command | Description |
| --- | --- |
| `bl speech recognize` | Recognize speech from audio files (FunAudio-ASR) |
| `bl speech synthesize` | Synthesize speech from text (CosyVoice TTS) |

## Command details

### `bl speech recognize`

| Field | Value |
| --- | --- |
| **Name** | `speech recognize` |
| **Description** | Recognize speech from audio files (FunAudio-ASR) |
| **Usage** | `bl speech recognize --url <audio-url> [flags]` |
| **API docs** | [/developer-reference/recording-file-recognition](https://help.aliyun.com/zh/model-studio/developer-reference/recording-file-recognition) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--url <url>` | array | yes | Audio file URL or local file path (repeatable, max 100) |
| `--model <model>` | string | no | Model ID (default: fun-asr) |
| `--language <lang>` | string | no | Language hint (e.g. zh, en, ja) |
| `--diarization` | boolean | no | Enable automatic speaker diarization |
| `--speaker-count <n>` | number | no | Expected number of speakers (requires --diarization) |
| `--vocabulary-id <id>` | string | no | Hot-word vocabulary ID for improved accuracy |
| `--channel-id <n>` | number | no | Audio channel ID (default: 0) |
| `--out <path>` | string | no | Save full transcription result to JSON file |
| `--no-wait` | boolean | no | Return task ID immediately without polling |
| `--poll-interval <seconds>` | number | no | Polling interval in seconds (default: 2) |

#### Examples

```bash
bl speech recognize --url https://example.com/audio.mp3
```

```bash
bl speech recognize --url https://example.com/a.mp3 --url https://example.com/b.mp3
```

```bash
bl speech recognize --url https://example.com/meeting.wav --diarization --speaker-count 3
```

```bash
bl speech recognize --url https://example.com/audio.mp3 --language zh
```

```bash
bl speech recognize --url https://example.com/audio.mp3 --vocabulary-id vocab-abc123
```

```bash
bl speech recognize --url https://example.com/audio.mp3 --out result.json
```

```bash
bl speech recognize --url https://example.com/audio.mp3 --no-wait --quiet
```

### `bl speech synthesize`

| Field | Value |
| --- | --- |
| **Name** | `speech synthesize` |
| **Description** | Synthesize speech from text (CosyVoice TTS) |
| **Usage** | `bl speech synthesize --text <text> [flags]` |
| **API docs** | [/developer-reference/cosyvoice](https://help.aliyun.com/zh/model-studio/developer-reference/cosyvoice) |

#### Options

| Flag | Type | Required | Description |
| --- | --- | --- | --- |
| `--text <text>` | string | yes | Text to synthesize into speech |
| `--text-file <path>` | string | no | Read text from a file instead of --text |
| `--model <model>` | string | no | Model ID (default: cosyvoice-v3-flash). System voices available for cosyvoice-v3-flash |
| `--voice <voice>` | string | no | Voice ID. Use --list-voices to see system voices for cosyvoice-v3-flash; for v3.5-flash provide a clone/design voice ID |
| `--list-voices` | boolean | no | List available system voices for the selected model and exit |
| `--format <format>` | string | no | Audio format: mp3, pcm, wav, opus (default: mp3) |
| `--sample-rate <rate>` | string | no | Audio sample rate in Hz (e.g. 24000) |
| `--volume <volume>` | string | no | Volume 0-100 (default: 50) |
| `--rate <rate>` | string | no | Speech rate 0.5-2.0 (default: 1.0) |
| `--pitch <pitch>` | string | no | Pitch multiplier 0.5-2.0 (default: 1.0) |
| `--seed <seed>` | string | no | Random seed 0-65535 for reproducible synthesis |
| `--language <lang>` | string | no | Language hint (e.g. zh, en, ja, ko, fr, de) |
| `--instruction <text>` | string | no | Natural language instruction to control speech style (e.g. "请用温柔的语调"） |
| `--enable-ssml` | boolean | no | Enable SSML markup parsing in input text |
| `--out <path>` | string | no | Save audio to file (default: auto-generate in temp dir) |
| `--stream` | boolean | no | Stream raw PCM audio to stdout (pipe to player) |

#### Examples

```bash
bl speech synthesize --list-voices --model cosyvoice-v3-flash
```

```bash
bl speech synthesize --text "你好，我是千问" --voice <voice_id>
```

```bash
bl speech synthesize --text "Hello world" --voice <voice_id> --language en
```

```bash
bl speech synthesize --text-file script.txt --out speech.wav --voice <voice_id>
```

```bash
bl speech synthesize --text "今天天气真好" --voice <voice_id> --instruction "请用温柔的语调说话"
```

```bash
bl speech synthesize --text "Hello" --voice <voice_id> --format wav --sample-rate 24000
```

```bash
# Stream to audio player (macOS)
```

```bash
bl speech synthesize --text "你好" --voice <voice_id> --stream | afplay -
```

```bash
# Pipe to ffplay
```

```bash
bl speech synthesize --text "Hello" --voice <voice_id> --stream | ffplay -nodisp -autoexit -f s16le -ar 24000 -ac 1 -
```

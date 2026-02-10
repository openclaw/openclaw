---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: songsee（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Generate spectrograms and feature-panel visualizations from audio with the songsee CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://github.com/steipete/songsee（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🌊",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["songsee"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/songsee",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["songsee"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install songsee (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# songsee（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Generate spectrograms + feature panels from audio.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Spectrogram: `songsee track.mp3`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multi-panel: `songsee track.mp3 --viz spectrogram,mel,chroma,hpss,selfsim,loudness,tempogram,mfcc,flux`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Time slice: `songsee track.mp3 --start 12.5 --duration 8 -o slice.jpg`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Stdin: `cat track.mp3 | songsee - --format png -o out.png`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--viz` list (repeatable or comma-separated)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--style` palette (classic, magma, inferno, viridis, gray)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--width` / `--height` output size（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--window` / `--hop` FFT settings（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--min-freq` / `--max-freq` frequency range（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--start` / `--duration` time slice（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--format` jpg|png（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- WAV/MP3 decode native; other formats use ffmpeg if available.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Multiple `--viz` renders a grid.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

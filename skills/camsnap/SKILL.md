---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: camsnap（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Capture frames or clips from RTSP/ONVIF cameras.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://camsnap.ai（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📸",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["camsnap"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "steipete/tap/camsnap",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["camsnap"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install camsnap (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# camsnap（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `camsnap` to grab snapshots, clips, or motion events from configured cameras.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Config file: `~/.config/camsnap/config.yaml`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add camera: `camsnap add --name kitchen --host 192.168.0.10 --user user --pass pass`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discover: `camsnap discover --info`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Snapshot: `camsnap snap kitchen --out shot.jpg`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Clip: `camsnap clip kitchen --dur 5s --out clip.mp4`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Motion watch: `camsnap watch kitchen --threshold 0.2 --action '...'`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Doctor: `camsnap doctor --probe`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Requires `ffmpeg` on PATH.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Prefer a short test capture before longer clips.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

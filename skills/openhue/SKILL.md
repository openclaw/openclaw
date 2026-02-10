---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: openhue（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Control Philips Hue lights/scenes via the OpenHue CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://www.openhue.io/cli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "💡",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["openhue"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "brew",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "formula": "openhue/cli/openhue-cli",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["openhue"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install OpenHue CLI (brew)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenHue CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `openhue` to control Hue lights and scenes via a Hue Bridge.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Setup（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Discover bridges: `openhue discover`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Guided setup: `openhue setup`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Read（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openhue get light --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openhue get room --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `openhue get scene --json`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Write（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Turn on: `openhue set light <id-or-name> --on`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Turn off: `openhue set light <id-or-name> --off`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Brightness: `openhue set light <id> --on --brightness 50`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Color: `openhue set light <id> --on --rgb #3399FF`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scene: `openhue set scene <scene-id>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- You may need to press the Hue Bridge button during setup.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `--room "Room Name"` when light names are ambiguous.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

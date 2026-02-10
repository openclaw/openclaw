---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: blucli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: BluOS CLI (blu) for discovery, playback, grouping, and volume.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://blucli.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🫐",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["blu"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "module": "github.com/steipete/blucli/cmd/blu@latest",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["blu"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install blucli (go)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# blucli (blu)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `blu` to control Bluesound/NAD players.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `blu devices` (pick target)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `blu --device <id> status`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `blu play|pause|stop`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `blu volume set 15`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Target selection (in priority order)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `--device <id|name|alias>`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `BLU_DEVICE`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- config default (if set)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Grouping: `blu group status|add|remove`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- TuneIn search/play: `blu tunein search "query"`, `blu tunein play "query"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Prefer `--json` for scripts. Confirm the target device before changing playback.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

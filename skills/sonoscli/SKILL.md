---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: sonoscli（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Control Sonos speakers (discover/status/play/volume/group).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://sonoscli.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "🔊",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["sonos"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "module": "github.com/steipete/sonoscli/cmd/sonos@latest",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["sonos"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install sonoscli (go)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Sonos CLI（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `sonos` to control Sonos speakers on the local network.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sonos discover`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sonos status --name "Kitchen"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sonos play|pause|stop --name "Kitchen"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `sonos volume set 15 --name "Kitchen"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common tasks（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Grouping: `sonos group status|join|unjoin|party|solo`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Favorites: `sonos favorites list|open`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Queue: `sonos queue list|play|clear`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Spotify search (via SMAPI): `sonos smapi search --service "Spotify" --category tracks "query"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- If SSDP fails, specify `--ip <speaker-ip>`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Spotify Web API search is optional and requires `SPOTIFY_CLIENT_ID/SECRET`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

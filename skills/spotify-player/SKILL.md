---
name: spotify-player
description: Terminal Spotify playback/search via spogo (preferred) or spotify_player.
homepage: https://www.spotify.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🎵",
        "requires": { "anyBins": ["spogo", "spotify_player"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "spogo",
              "tap": "steipete/tap",
              "bins": ["spogo"],
              "label": "Install spogo (brew)",
            },
            {
              "id": "brew",
              "kind": "brew",
              "formula": "spotify_player",
              "bins": ["spotify_player"],
              "label": "Install spotify_player (brew)",
            },
          ],
      },
  }
---

# spogo / spotify_player

使用 `spogo` **（首选）** 进行 Spotify 播放/搜索。如有需要回退到 `spotify_player`。

要求

- Spotify Premium 账户。
- 已安装 `spogo` 或 `spotify_player`。

spogo 设置

- 导入 cookies：`spogo auth import --browser chrome`

常用 CLI 命令

- 搜索：`spogo search track "query"`
- 播放：`spogo play|pause|next|prev`
- 设备：`spogo device list`、`spogo device set "<name|id>"`
- 状态：`spogo status`

spotify_player 命令（回退）

- 搜索：`spotify_player search "query"`
- 播放：`spotify_player playback play|pause|next|previous`
- 连接设备：`spotify_player connect`
- 喜欢曲目：`spotify_player like`

提示

- 配置文件夹：`~/.config/spotify-player`（例如 `app.toml`）。
- 对于 Spotify Connect 集成，在配置中设置用户 `client_id`。
- TUI 快捷方式可通过应用中的 `?` 获取。

---
name: gifgrep
description: Search GIF providers with CLI/TUI, download results, and extract stills/sheets.
homepage: https://gifgrep.com
metadata:
  {
    "openclaw":
      {
        "emoji": "🧲",
        "requires": { "bins": ["gifgrep"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/gifgrep",
              "bins": ["gifgrep"],
              "label": "Install gifgrep (brew)",
            },
            {
              "id": "go",
              "kind": "go",
              "module": "github.com/steipete/gifgrep/cmd/gifgrep@latest",
              "bins": ["gifgrep"],
              "label": "Install gifgrep (go)",
            },
          ],
      },
  }
---

# gifgrep

使用 `gifgrep` 搜索 GIF 提供商（Tenor/Giphy）、在 TUI 中浏览、下载结果，并提取静态图像或工作表。

GIF-Grab（gifgrep 工作流程）

- 搜索 → 预览 → 下载 → 提取（静态/工作表）以便快速查看和分享。

快速开始

- `gifgrep cats --max 5`
- `gifgrep cats --format url | head -n 5`
- `gifgrep search --json cats | jq '.[0].url'`
- `gifgrep tui "office handshake"`
- `gifgrep cats --download --max 1 --format url`

TUI + 预览

- TUI：`gifgrep tui "query"`
- CLI 静态预览：`--thumbs`（仅 Kitty/Ghostty；静止帧）

下载 + 显示

- `--download` 保存到 `~/Downloads`
- `--reveal` 在 Finder 中显示最后下载的内容

静态 + 工作表

- `gifgrep still ./clip.gif --at 1.5s -o still.png`
- `gifgrep sheet ./clip.gif --frames 9 --cols 3 -o sheet.png`
- 工作表 = 采样帧的单个 PNG 网格（非常适合快速查看、文档、PR、聊天）。
- 调优：`--frames`（数量）、`--cols`（网格宽度）、`--padding`（间距）。

提供商

- `--source auto|tenor|giphy`
- `--source giphy` 需要 `GIPHY_API_KEY`
- `TENOR_API_KEY` 可选（如果未设置则使用 Tenor 演示密钥）

输出

- `--json` 打印结果数组（`id`、`title`、`url`、`preview_url`、`tags`、`width`、`height`）
- `--format` 用于管道友好的字段（例如 `url`）

GIF 资源卫生

- 在推荐或使用动画 GIF URL 之前，验证它是否成功解析、具有 `Content-Type: image/gif`，并且实际上是动画的（多帧或循环元数据；例如用 `file`、`identify` 或小脚本检查）。
- 记录归属/许可证/源 URL 以及资产。
- 当需要本地资产时不要热链接：下载/复制到项目中并引用本地文件。

环境调整

- `GIFGREP_SOFTWARE_ANIM=1` 强制软件动画
- `GIFGREP_CELL_ASPECT=0.5` 调整预览几何

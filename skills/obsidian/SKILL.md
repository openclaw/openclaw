---
name: obsidian
description: Work with Obsidian vaults (plain Markdown notes) and automate via obsidian-cli.
homepage: https://help.obsidian.md
metadata:
  {
    "openclaw":
      {
        "emoji": "💎",
        "requires": { "bins": ["obsidian-cli"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "yakitrak/yakitrak/obsidian-cli",
              "bins": ["obsidian-cli"],
              "label": "Install obsidian-cli (brew)",
            },
          ],
      },
  }
---

# Obsidian

Obsidian 仓库 = 磁盘上的普通文件夹。

仓库结构（典型）

- 笔记：`*.md`（纯文本 Markdown；使用任何编辑器编辑）
- 配置：`.obsidian/`（工作区 + 插件设置；通常不从脚本触碰）
- Canvas：`*.canvas`（JSON）
- 附件：您在 Obsidian 设置中选择的文件夹（图片/PDF 等）

## 找到活动的仓库

Obsidian 桌面在此跟踪仓库（真相来源）：

- `~/Library/Application Support/obsidian/obsidian.json`

`obsidian-cli` 从该文件解析仓库；仓库名称通常是**文件夹名称**（路径后缀）。

快速"哪个仓库是活动的/笔记在哪里？"

- 如果您已经设置了默认值：`obsidian-cli print-default --path-only`
- 否则，读取 `~/Library/Application Support/obsidian/obsidian.json` 并使用 `"open": true` 的仓库条目。

注意事项

- 多个仓库是常见的（iCloud vs `~/Documents`、工作/个人等）。不要猜测；读取配置。
- 避免将硬编码的仓库路径写入脚本；优先读取配置或使用 `print-default`。

## obsidian-cli 快速开始

设置默认仓库（一次）：

- `obsidian-cli set-default "<vault-folder-name>"`
- `obsidian-cli print-default` / `obsidian-cli print-default --path-only`

搜索

- `obsidian-cli search "query"`（笔记名称）
- `obsidian-cli search-content "query"`（笔记内；显示片段 + 行）

创建

- `obsidian-cli create "Folder/New note" --content "..." --open`
- 需要 Obsidian URI 处理器（`obsidian://…`）正常工作（已安装 Obsidian）。
- 避免通过 URI 在"隐藏"点文件夹下创建笔记（例如 `.something/...`）；Obsidian 可能拒绝。

移动/重命名（安全重构）

- `obsidian-cli move "old/path/note" "new/path/note"`
- 更新整个仓库中的 `[[wikilinks]]` 和常见 Markdown 链接（这是相对于 `mv` 的主要优势）。

删除

- `obsidian-cli delete "path/note"`

在适当的时候优先使用直接编辑：打开 `.md` 文件并更改它；Obsidian 会获取更改。

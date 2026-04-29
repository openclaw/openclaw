---
name: blogwatcher
description: Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.
homepage: https://github.com/Hyaxia/blogwatcher
metadata:
  {
    "openclaw":
      {
        "emoji": "📰",
        "requires": { "bins": ["blogwatcher"] },
        "install":
          [
            {
              "id": "go",
              "kind": "go",
              "module": "github.com/Hyaxia/blogwatcher/cmd/blogwatcher@latest",
              "bins": ["blogwatcher"],
              "label": "Install blogwatcher (go)",
            },
          ],
      },
  }
---

# blogwatcher

使用 `blogwatcher` CLI 跟踪博客和 RSS/Atom Feed 更新。

安装

- Go：`go install github.com/Hyaxia/blogwatcher/cmd/blogwatcher@latest`

快速开始

- `blogwatcher --help`

常用命令

- 添加博客：`blogwatcher add "My Blog" https://example.com`
- 列出博客：`blogwatcher blogs`
- 扫描更新：`blogwatcher scan`
- 列出文章：`blogwatcher articles`
- 将文章标记为已读：`blogwatcher read 1`
- 将所有文章标记为已读：`blogwatcher read-all`
- 移除博客：`blogwatcher remove "My Blog"`

示例输出

```
$ blogwatcher blogs
Tracked blogs (1):

  xkcd
    URL: https://xkcd.com
```

```
$ blogwatcher scan
Scanning 1 blog(s)...

  xkcd
    Source: RSS | Found: 4 | New: 4

Found 4 new article(s) total!
```

提示

- 使用 `blogwatcher <command> --help` 发现标志和选项。

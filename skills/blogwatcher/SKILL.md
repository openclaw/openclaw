---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
name: blogwatcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
description: Monitor blogs and RSS/Atom feeds for updates using the blogwatcher CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
homepage: https://github.com/Hyaxia/blogwatcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
metadata:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    "openclaw":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "emoji": "📰",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "requires": { "bins": ["blogwatcher"] },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
        "install":（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          [（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            {（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "id": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "kind": "go",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "module": "github.com/Hyaxia/blogwatcher/cmd/blogwatcher@latest",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "bins": ["blogwatcher"],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
              "label": "Install blogwatcher (go)",（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
            },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
          ],（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
      },（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  }（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# blogwatcher（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Track blog and RSS/Atom feed updates with the `blogwatcher` CLI.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Install（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Go: `go install github.com/Hyaxia/blogwatcher/cmd/blogwatcher@latest`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Quick start（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `blogwatcher --help`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Common commands（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Add a blog: `blogwatcher add "My Blog" https://example.com`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- List blogs: `blogwatcher blogs`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Scan for updates: `blogwatcher scan`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- List articles: `blogwatcher articles`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mark an article read: `blogwatcher read 1`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Mark all articles read: `blogwatcher read-all`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Remove a blog: `blogwatcher remove "My Blog"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Example output（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
$ blogwatcher blogs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Tracked blogs (1):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  xkcd（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    URL: https://xkcd.com（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
$ blogwatcher scan（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Scanning 1 blog(s)...（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  xkcd（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    Source: RSS | Found: 4 | New: 4（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Found 4 new article(s) total!（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `blogwatcher <command> --help` to discover flags and options.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）

---
name: clawhub
description: Search, install, update, sync, or publish agent skills with the ClawHub CLI and registry.
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["clawhub"] },
        "install":
          [
            {
              "id": "node",
              "kind": "node",
              "package": "clawhub",
              "bins": ["clawhub"],
              "label": "Install ClawHub CLI (npm)",
            },
          ],
      },
  }
---

# ClawHub CLI

安装

```bash
npm i -g clawhub
```

认证（发布）

```bash
clawhub login
clawhub whoami
```

搜索

```bash
clawhub search "postgres backups"
```

安装

```bash
clawhub install my-skill
clawhub install my-skill --version 1.2.3
```

更新（基于哈希的匹配 + 升级）

```bash
clawhub update my-skill
clawhub update my-skill --version 1.2.3
clawhub update --all
clawhub update my-skill --force
clawhub update --all --no-input --force
```

列表

```bash
clawhub list
```

发布

```bash
clawhub publish ./my-skill --slug my-skill --name "My Skill" --version 1.2.0 --changelog "Fixes + docs"
```

注意事项

- 默认注册表：https://clawhub.com（使用 CLAWHUB_REGISTRY 或 --registry 覆盖）
- 默认工作目录：cwd（回退到 OpenClaw workspace）；安装目录：./skills（使用 --workdir / --dir / CLAWHUB_WORKDIR 覆盖）
- Update 命令对本地文件进行哈希解析，解析匹配版本，并升级到最新版本，除非设置了 --version

# Runtime-installed packs

本目录是 **运行时安装目标**，Git 中保持空（仅 `.gitkeep`）。

| 用途              | 位置                                                             |
| ----------------- | ---------------------------------------------------------------- |
| Pack 源码唯一真源 | 与 `claworks/` 同级的 **`claworks-packs/`** 仓库                 |
| 开发指南          | `claworks-packs/PACK_DEVELOPMENT.md`                             |
| 分层 profile      | `claworks-packs/claworks.packs.json`                             |
| 安装后产物        | `~/.claworks/packs/` 或本目录（由 `claworks pack install` 写入） |

```bash
# 从 sibling 真源初始化
CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:init
pnpm claworks pack install --from ../claworks-packs/base
```

不要在 `contrib/packs/` 或本目录手写 YAML 真源；见 [contrib/packs/README.md](../contrib/packs/README.md)。

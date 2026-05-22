# Pack 已迁移

**唯一真源**：与 `claworks/` 同级的 **`claworks-packs/`** 仓库（例如 `~/Projects/claworks-packs`）。

- 开发指南：`claworks-packs/PACK_DEVELOPMENT.md`
- 分层配置：`claworks-packs/claworks.packs.json`
- 运行时安装目录：本仓 [`packs/`](../../packs/README.md)（git 空）或 `~/.claworks/packs/`

```bash
# 在 claworks 仓根目录执行
CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:init
```

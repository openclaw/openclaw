# ClaWorks 产品配置片段

本目录 **不含** Pack 源码。Pack 真源见 [`claworks-packs`](../../claworks-packs) sibling 仓与 [`packs/README.md`](../packs/README.md)。

| 文件 / 目录                           | 用途                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------- |
| `claworks-product.plugins.allow.json` | 产品 `plugins.allow` 白名单（core / extended / full）                      |
| `claworks-extensions-prune.json`      | Extension 裁剪策略                                                         |
| `examples/`                           | `openclaw.fragment.json`、starter pack、A2A mesh、personal-enterprise 示例 |
| `packs/README.md`                     | 指向 `claworks-packs`（历史路径，勿放 YAML）                               |

初始化时加载白名单：

```bash
CLAWORKS_PRODUCT_PROFILE=core pnpm claworks:init       # 默认核心插件
CLAWORKS_PRODUCT_PROFILE=extended pnpm claworks:init   # + 国内 LLM
CLAWORKS_PRODUCT_PROFILE=full pnpm claworks:init         # + 企业可选
CLAWORKS_DEMO_CONNECTORS=1 pnpm claworks:init            # 启用 echo/mqtt 演示连接器
CLAWORKS_PACKS_DIR=../claworks-packs pnpm claworks:init  # 绑定 sibling pack 真源
```

目录布局详见 [`docs/design/DIRECTORY-LAYOUT.md`](../docs/design/DIRECTORY-LAYOUT.md)。

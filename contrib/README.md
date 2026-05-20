# ClaWorks 产品配置片段

| 文件                                                  | 用途                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `claworks-product.plugins.allow.json`                 | 工业机器人 `plugins.allow` 白名单（core / extended / full） |
| `examples/claworks-production.openclaw.fragment.json` | 生产环境 Gateway 片段                                       |

初始化时加载白名单：

```bash
CLAWORKS_PRODUCT_PROFILE=core pnpm claworks:init    # 默认核心插件
CLAWORKS_PRODUCT_PROFILE=extended pnpm claworks:init # + 国内 LLM
CLAWORKS_PRODUCT_PROFILE=full pnpm claworks:init     # + 企业可选
CLAWORKS_DEMO_CONNECTORS=1 pnpm claworks:init        # 启用 echo/mqtt 演示连接器
```

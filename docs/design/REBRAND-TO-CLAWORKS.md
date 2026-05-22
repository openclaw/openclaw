# 包名迁移：openclaw → claworks

**状态**：规划（未改根 `package.json`，避免与上游同步冲突）  
**目标**：npm 包名 `claworks`，CLI 主名 `claworks`，`@claworks/runtime` 可公开发布。

---

## 阶段 A — 文档与 CLI（低风险）

- [x] 产品文档使用 ClaWorks 品牌
- [ ] 根 `package.json`: `"name": "claworks"`
- [ ] `description` / `repository` 指向 claworks 组织
- [ ] 保留 `"bin": { "claworks": "claworks.mjs", "openclaw": "openclaw.mjs" }` 别名 1–2 个版本周期

## 阶段 B — 发布面

- [ ] `@claworks/runtime` 取消 `publishConfig` 暂缓，发布 beta
- [ ] 安装文档：`npm i -g claworks`
- [ ] Docker/CI 镜像名 `claworks`

## 阶段 C — 代码引用（高成本）

- [ ] 环境变量：`OPENCLAW_*` 保留别名，`CLAWORKS_*` 优先（已部分存在）
- [ ] 内部 import 路径 `openclaw/plugin-sdk` 仍为上游兼容层，**不急于重命名**
- [ ] GitHub 远程：fork 与 upstream openclaw 合并策略文档化

## 破坏性变更沟通

| 项           | 迁移                                   |
| ------------ | -------------------------------------- |
| 配置目录     | 已用 `~/.claworks/claworks.json`       |
| Gateway 端口 | 18800（OpenClaw 个人 18789）           |
| 全局命令     | `claworks` 主命令，`openclaw` 过渡别名 |

## 建议执行顺序

1. 个人企业 profile 跑通（`personal_work`）
2. 发布 `@claworks/runtime@0.1.0-beta` 到私有 registry
3. 单 PR 改根 package name + changelog
4. 再考虑 extension 全量裁剪与 upstream 合并策略

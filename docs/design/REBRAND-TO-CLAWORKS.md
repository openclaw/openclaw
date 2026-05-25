# 包名迁移：openclaw → claworks

**状态**：阶段 A 已落地（根 `package.json` → `claworks`，全局 bin 仅 `claworks`）  
**目标**：npm 包名 `claworks`，CLI 主名 `claworks`，`@claworks/runtime` 可公开发布。

---

## 阶段 A — 文档与 CLI（低风险）

- [x] 产品文档使用 ClaWorks 品牌
- [x] 根 `package.json`: `"name": "claworks"`
- [x] `description` / `repository` 指向 claworks 组织
- [x] `"bin": { "claworks": "claworks.mjs" }`（**不再**发布 `openclaw` bin，避免与官方全局命令冲突）
- [x] `openclaw.mjs` 在 ClaWorks 发行版中拒绝裸 `openclaw` 入口
- [x] LaunchAgent / systemd 在 `CLAWORKS_PRODUCT=1` 时使用 `ai.claworks.*` / `claworks-gateway`

### Onboarding / configure / doctor（2026-05-24 审计）

| 路径                                    | 状态 | 说明                                                                                                               |
| --------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------ |
| `claworks.mjs`                          | ✅   | `CLAWORKS_PRODUCT=1`，`~/.claworks`，port 18800                                                                    |
| `wizardT` + `product-copy`              | ✅   | intro/outro/端口/CLI 名经 `applyClaworksWizardCopy` 重写                                                           |
| `formatCliCommand("openclaw …")`        | ✅   | 运行时替换为 `claworks`（含 setup.finalize next steps）                                                            |
| `configure` intro                       | ✅   | `resolveProductConfigureIntro`                                                                                     |
| `doctor` intro                          | ✅   | `resolveProductDoctorIntro` + ClaWorks 专项 health checks                                                          |
| `onboard-remote` 默认 WS                | ✅   | `resolveProductLocalGatewayWsUrl`（18800）                                                                         |
| `pnpm claworks:setup`                   | ✅   | doctor --fix → init → onboard，收尾提示 `claworks:start` + ClaWorks next steps（OT simulate / personal_work 警告） |
| `setup.finalize` ClaWorks 专项          | ✅   | `collectClaworksInitWarnings` + next steps（start/doctor/configure/repair）                                        |
| `mergeClaworksProductDefaults`          | ✅   | 交互/非交互 onboard 写配置前合并 18800 / claworks-robot / plugins.allow                                            |
| `doctor-core-checks` fixHint            | ✅   | `doctorFixHint` → `productizeUserCopy`（configure/doctor 命令产品化）                                              |
| `config config set/patch/schema`        | ✅   | `--dry-run` / `schema` 描述与 invalid-config 错误经 `productizeUserCopy`                                           |
| `dns-cli` / `hooks-cli` / `devices-cli` | ✅   | DNS-SD 提示、deprecated hooks 描述/警告、设备 re-approval 说明经 `productizeUserCopy` / `formatCliCommand`         |
| `--dev` profile 状态目录                | ✅   | `CLAWORKS_PRODUCT=1` → `~/.claworks-dev` + `claworks.json`（port 19001）                                           |
| non-interactive onboard 恢复提示        | ✅   | `local/output.ts` recovery hints 经 `formatCliCommand`                                                             |
| init OT simulate 提示                   | ✅   | `collectClaworksInitWarnings`：echo/simulate 非生产误导 + personal_work repair 指引                                |
| wizard.finalize whatNow/outro           | ✅   | 产品化 override → docs.claworks.ai/showcase                                                                        |
| 遗留（有意保留）                        | ⚠️   | 内部类型名 `OpenClawConfig`、`openclaw/plugin-sdk` import；harness-sync 检测并存 OpenClaw 安装                     |

## 阶段 B — 发布面

- [ ] `@claworks/runtime` 取消 `publishConfig` 暂缓，发布 beta
- [x] 安装文档（源码 + 共存）：[`docs/claworks/install.md`](../claworks/install.md)
- [ ] 根包 `npm i -g claworks`（`npm pack --dry-run` 验证 tarball）
- [ ] Docker/CI 镜像名 `claworks`

## 阶段 C — 代码引用（高成本）

- [ ] 环境变量：`OPENCLAW_*` 保留别名，`CLAWORKS_*` 优先（已部分存在）
- [ ] 内部 import 路径 `openclaw/plugin-sdk` 仍为上游兼容层，**不急于重命名**
- [ ] GitHub 远程：fork 与 upstream openclaw 合并策略文档化

## 破坏性变更沟通

| 项           | 迁移                                                                 |
| ------------ | -------------------------------------------------------------------- |
| 配置目录     | 已用 `~/.claworks/claworks.json`                                     |
| Gateway 端口 | 18800（OpenClaw 个人 18789）                                         |
| 全局命令     | **`claworks` 唯一**；`openclaw.mjs` 仅内部/upstream 兼容，不发布 bin |

## 建议执行顺序

1. 个人企业 profile 跑通（`personal_work`）
2. 发布 `@claworks/runtime@0.1.0-beta` 到私有 registry
3. 单 PR 改根 package name + changelog
4. 再考虑 extension 全量裁剪与 upstream 合并策略

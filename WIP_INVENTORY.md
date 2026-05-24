# ClaWorks WIP 清单（未提交）

> 生成目的：安全整理 WIP，**A 类**（文档/CI/示例）已分组提交；下列 **C 类**需继续审查后再合入。

## C 类 — 需审查（不提交）

| 路径                                                              | 说明                                            |
| ----------------------------------------------------------------- | ----------------------------------------------- |
| `claworks.mjs`                                                    | 产品 CLI 入口脚本，可能含 gateway/init 路由变更 |
| `extensions/claworks-robot/cw-tools-ops.ts`                       | 机器人运维 MCP 工具扩展                         |
| `extensions/codex/doctor-contract-api.ts`                         | Codex 插件 doctor 契约对齐                      |
| `extensions/discord/src/doctor-contract.ts`                       | Discord doctor 契约                             |
| `extensions/elevenlabs/doctor-contract.ts`                        | ElevenLabs doctor 契约                          |
| `extensions/google-meet/src/config-compat.ts`                     | Google Meet 配置兼容层                          |
| `extensions/googlechat/src/doctor-contract.ts`                    | Google Chat doctor 契约                         |
| `extensions/matrix/src/doctor-contract.ts`                        | Matrix doctor 契约                              |
| `extensions/matrix/src/doctor.ts`                                 | Matrix doctor 实现                              |
| `extensions/matrix/src/matrix/deps.ts`                            | Matrix 依赖注入                                 |
| `extensions/matrix/src/migration-config.ts`                       | Matrix 配置迁移                                 |
| `extensions/memory-wiki/src/config-compat.ts`                     | memory-wiki 配置兼容                            |
| `extensions/slack/src/doctor-contract.ts`                         | Slack doctor 契约                               |
| `extensions/telegram/src/doctor-contract.ts`                      | Telegram doctor 契约                            |
| `extensions/voice-call/index.ts`                                  | voice-call 插件入口（operator scope）           |
| `extensions/zalouser/src/doctor-contract.ts`                      | Zalo user doctor 契约                           |
| `packages/claworks-runtime/package.json`                          | runtime 包依赖/脚本调整                         |
| `packages/claworks-runtime/src/claworks/doctor.ts`                | ClaWorks doctor 检查项扩展                      |
| `packages/claworks-runtime/src/index.ts`                          | runtime 公共导出变更                            |
| `packages/claworks-runtime/src/interfaces/mcp/tools.ts`           | MCP 工具面注册                                  |
| `packages/claworks-runtime/src/kernel/autonomy-engine.ts`         | 自治引擎进化观测                                |
| `packages/claworks-runtime/src/kernel/capability-registry.ts`     | 能力注册表                                      |
| `packages/claworks-runtime/src/kernel/event-kernel.ts`            | 事件内核                                        |
| `packages/claworks-runtime/src/kernel/evolution-sync.ts`          | 离线进化同步管道                                |
| `packages/claworks-runtime/src/kernel/evolve-engine.ts`           | 自进化引擎文档/逻辑                             |
| `packages/claworks-runtime/src/kernel/scaffold-engine.ts`         | 弱模型脚手架引擎                                |
| `packages/claworks-runtime/src/kernel/types.ts`                   | 内核类型扩展                                    |
| `packages/claworks-runtime/src/planes/data/cbr-store.ts`          | CBR 案例库存储                                  |
| `packages/claworks-runtime/src/planes/data/mes-dispatch.ts`       | MES 派工 webhook/simulate                       |
| `packages/claworks-runtime/src/planes/orch/playbook-simulator.ts` | Playbook 干跑模拟器                             |
| `packages/claworks-runtime/dist/*`                                | **构建产物，勿提交**                            |
| `scripts/lib/claworks-pack-profiles.mjs`                          | Pack profile 脚本                               |
| `src/auto-reply/reply/*`                                          | OpenClaw 自动回复/诊断命令                      |
| `src/cli/*`                                                       | CLI 产品面、init 注册、doctor、wizard 文案      |
| `src/commands/*`                                                  | onboard/configure/doctor/status 等命令          |
| `src/config/*`                                                    | 配置 schema/校验/提示                           |
| `src/daemon/launchd.ts`                                           | macOS launchd 守护                              |
| `src/entry.ts`                                                    | 主入口                                          |
| `src/flows/search-setup.ts`                                       | 搜索设置流                                      |
| `src/gateway/*`                                                   | Gateway 连接/配置提示                           |
| `src/infra/*`                                                     | 出站通道选择、runtime guard                     |
| `src/plugins/*`                                                   | 插件发现/注册/compat                            |
| `src/storage/lancedb-adapter.ts`                                  | **已删除** — LanceDB 适配迁移                   |
| `src/storage/redis-adapter.ts`                                    | **已删除** — Redis 适配移除                     |
| `src/terminal/links.ts`                                           | 终端链接                                        |
| `src/wizard/*`                                                    | Setup Wizard 中英文文案与流程                   |
| `connectors/README.md`                                            | OT 连接器说明                                   |
| `connectors/database-poll/`                                       | **未跟踪** — 数据库轮询连接器                   |
| `docs/LOCAL-GIT.md`                                               | 本地 git 工作流说明                             |
| `docs/RELEASE-CHECKLIST.md`                                       | **未跟踪** — 发布检查清单                       |
| `docs/legacy/`                                                    | **未跟踪** — 旧版 compose 等归档                |
| `src/cli/cli-name.test.ts`                                        | **未跟踪** — CLI 名称测试                       |
| `src/cli/product/register-claworks-init-cli.ts`                   | **未跟踪** — init CLI 注册                      |

## B 类 — 明确不提交

| 路径                               | 说明               |
| ---------------------------------- | ------------------ |
| `packages/claworks-runtime/dist/*` | 构建输出           |
| `.env`                             | 本地密钥（若存在） |
| `~/.claworks/credentials/*`        | 运行时凭证         |

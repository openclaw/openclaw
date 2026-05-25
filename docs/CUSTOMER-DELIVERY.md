# ClaWorks 客户交付与签收指南

**版本**：`2026.5.19`（tag `v2026.5.19`，本地未 push）  
**更新**：2026-05-25  
**关联**：[RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md)、[DEPLOYMENT.md](../DEPLOYMENT.md)、[OPERATOR-CHECKLIST.md](OPERATOR-CHECKLIST.md)

---

## 1. 交付制品清单

| 制品                      | 路径 / 说明                                                   | 必须 |
| ------------------------- | ------------------------------------------------------------- | :--: |
| 主仓源码或镜像            | `claworks` git bundle / Docker 镜像 `claworks:TAG`            |  ✅  |
| Pack 仓                   | sibling `claworks-packs` 或 Nexus 只读挂载                    |  ✅  |
| 环境变量模板              | `.env.example`                                                |  ✅  |
| 生产 Compose              | `docker-compose.prod.yml`                                     |  ✅  |
| 生产配置片段              | `contrib/examples/claworks-production.openclaw.fragment.json` |  ✅  |
| API 规范                  | `docs/design/API-SPEC.md`                                     |  ✅  |
| 许可证                    | `LICENSE` + `LICENSE-COMMERCIAL.md`                           |  ✅  |
| 签收清单                  | 本文 + `docs/RELEASE-CHECKLIST.md`                            |  ✅  |
| OpenClaw 桥接扩展（可选） | `openclaw-claworks-extension`                                 | 按需 |

**Pack 仓最低要求**：`base`、`enterprise-foundation`、`process-industry`（enterprise profile）；完整列表见 `claworks-packs/claworks.packs.json`。

---

## 2. 环境要求矩阵

| 维度             | 开发 / 预发布                          | 生产签收                                       |
| ---------------- | -------------------------------------- | ---------------------------------------------- |
| **OS**           | macOS / Linux（Node 22+）              | Linux x86_64（推荐容器）                       |
| **Node**         | 22+                                    | 22+（镜像内 bundled）                          |
| **Pack 仓**      | `CLAWORKS_PACKS_DIR=../claworks-packs` | 挂载 `/opt/claworks-packs` 或 Nexus            |
| **状态目录**     | `~/.claworks/`                         | 持久卷 `claworks-state`                        |
| **数据库**       | SQLite（默认）                         | **PostgreSQL 强烈建议**（P1）                  |
| **Gateway 端口** | 18800                                  | 18800                                          |
| **认证**         | 可选（dev 开放）                       | `CLAWORKS_INIT_SECURE=1` + `require_api_key`   |
| **生产模式**     | 可选                                   | `production_mode: true`（fail-closed）         |
| **LLM**          | 可选 stub                              | 配置 `model_router` 或 `agents.defaults.model` |
| **通知**         | 可选                                   | 配置 `notify.targets`                          |
| **OT 连接器**    | `pnpm claworks:ot-dry-run`（simulate） | 关闭 `simulate`；现场联调（P1）                |
| **监控**         | 可选                                   | Prometheus scrape `/v1/metrics`（P1）          |

---

## 3. 签收验收脚本

以下命令在 **claworks 主仓根目录**执行。敏感输出已脱敏；API Key / Token 勿写入日志。

### 3.1 构建与 P0 质量门

```bash
cd claworks
pnpm install
pnpm claworks:runtime:build
pnpm build

pnpm lint:core -- packages/claworks-runtime
pnpm claworks:runtime:test
pnpm test extensions/claworks-robot
pnpm claworks:smoke
```

**期望**：runtime test 全绿；smoke 27/27；robot 插件契约全绿。

### 3.2 生产配置初始化（临时目录，不污染 ~/.claworks）

```bash
export CLAWORKS_PACKS_DIR=/path/to/claworks-packs   # sibling 或 Nexus 挂载
export OPENCLAW_STATE_DIR=/tmp/claworks-signoff/state
export CLAWORKS_INIT_SECURE=1
node scripts/claworks-init.mjs

# 生产模式下须禁用 echo 演示连接器（与 production fragment 一致）
node -e "
const fs=require('fs');
const p=process.env.OPENCLAW_STATE_DIR+'/claworks.json';
const c=JSON.parse(fs.readFileSync(p,'utf8'));
const e=c.plugins.entries['claworks-robot'].config;
if(e.connectors?.echo) e.connectors.echo.enabled=false;
fs.writeFileSync(p, JSON.stringify(c,null,2));
"
```

或合并 `contrib/examples/claworks-production.openclaw.fragment.json` 到 `claworks.json`（替换 `CHANGE_ME` API Key）。

### 3.3 运行态健康与认证（P0 #7–#9）

```bash
PORT=$(node -e "const n=require('net').createServer();n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})")
API_KEY=$(node -pe "JSON.parse(require('fs').readFileSync(process.env.OPENCLAW_STATE_DIR+'/claworks.json','utf8')).plugins.entries['claworks-robot'].config.api.api_key")

CLAWORKS_PRODUCT=1 OPENCLAW_STATE_DIR OPENCLAW_CONFIG_PATH="$OPENCLAW_STATE_DIR/claworks.json" \
  node --import tsx src/entry.ts gateway run --port "$PORT" --bind loopback &
GW_PID=$!

# 等待内核就绪（Gateway 冷启动约 60–100s）
for i in $(seq 1 120); do
  curl -sf "http://127.0.0.1:$PORT/v1/health" >/tmp/health.json && break
  sleep 1
done

# 健康（脱敏）
curl -s "http://127.0.0.1:$PORT/v1/health" | jq '{status, planes, packs: (.checks[]|select(.id=="packs")|.message)}'

# REST 认证
curl -s -o /dev/null -w "identity no token: %{http_code}\n" "http://127.0.0.1:$PORT/v1/identity"
curl -s -o /dev/null -w "identity wrong token: %{http_code}\n" -H "Authorization: Bearer wrong" "http://127.0.0.1:$PORT/v1/identity"
curl -s -o /dev/null -w "identity valid token: %{http_code}\n" -H "Authorization: Bearer $API_KEY" "http://127.0.0.1:$PORT/v1/identity"

kill $GW_PID
```

**期望（2026-05-25 签收实测）**：

| 检查项                        | 期望                                                        | 实测                         |
| ----------------------------- | ----------------------------------------------------------- | ---------------------------- |
| `GET /v1/health` 可达         | HTTP 200                                                    | ✅                           |
| `planes.kernel/data/orch`     | 均为 `ok`                                                   | ✅                           |
| 无 `error` 级 check           | 无 `unavailable`                                            | ✅（禁用 echo 后）           |
| `status`                      | `ok` 理想；`degraded` 可接受若仅 warn（LLM/Notify/PG 未配） | ⚠️ `degraded`（warn 项见下） |
| `/v1/identity` 无/错 token    | 401                                                         | ✅ 401 / 401                 |
| `/v1/identity` 正确 Bearer    | 200                                                         | ✅ 200                       |
| `/v1/health` 无 token         | 200（探针友好）                                             | ✅ 200                       |
| `production_mode` + echo 启用 | `connectors_echo_demo:error` → `unavailable`                | ✅ fail-closed               |
| 生产单测                      | step-executor / product-config-repair / auth                | ✅ 440/440（runtime 包）     |

**生产 `degraded` 常见 warn（非阻塞，P1 加固）**：`gateway_bridge_llm`、`gateway_bridge_notify`、`database_production`（SQLite）、`security_a2a_https`、`connectors`（无实机 OT）。

### 3.4 P1 加固项

```bash
# 进化链烟测（进程内，约 1–3 分钟）
CLAWORKS_PACKS_DIR=/path/to/claworks-packs pnpm claworks:evolution:smoke

# OT 模拟连接器（无实机）
pnpm claworks:ot-dry-run

# 真实 Gateway 闭环（约 2–5 分钟）
CLAWORKS_PACKS_DIR=/path/to/claworks-packs pnpm claworks:gateway:e2e

# 生产 Compose 语法
docker compose -f docker-compose.prod.yml config

# 依赖 audit（推荐官方 registry）
pnpm audit --registry=https://registry.npmjs.org
```

**2026-05-25 实测**：

| 命令                                               | 结果                                             |
| -------------------------------------------------- | ------------------------------------------------ |
| `pnpm claworks:evolution:smoke`                    | ✅ ALL EVOLUTION CHAIN CHECKS PASSED             |
| `pnpm claworks:ot-dry-run`                         | ✅ ALL OT DRY-RUN CHECKS PASSED                  |
| `docker compose -f docker-compose.prod.yml config` | ✅ 语法有效                                      |
| `pnpm claworks:gateway:e2e`                        | ✅（见 RELEASE-CHECKLIST P1 #8）                 |
| `pnpm audit --registry=https://registry.npmjs.org` | ⚠️ 2 moderate（`protobufjs`、`qs`， transitive） |

---

## 4. 已知限制

| 项                         | 说明                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Secure init 默认 echo**  | `CLAWORKS_INIT_SECURE=1` init 仍启用 echo；生产须手动禁用或使用 production fragment，否则 health `unavailable`               |
| **`pnpm claworks:repair`** | 当前 `@claworks/runtime` 导出 `defaultClaworksStateDir` 缺失会导致 repair 脚本失败；签收可用 init + fragment 或手动改 config |
| **Health `status=ok`**     | 任一 doctor `warn` 即为 `degraded`；完整 `ok` 需 LLM bridge、notify、PG、OT 等 P1 项齐备                                     |
| **npm audit**              | 2 个 moderate 为传递依赖；升级路径待 P2 跟踪                                                                                 |
| **npm 公开发布**           | `@claworks/runtime` 暂缓 npm publish                                                                                         |
| **Studio React 编辑器**    | 静态 `/studio` 已有；全功能编辑器未交付                                                                                      |
| **Extension 物理裁剪**     | `claworks:prune-extensions` 可选，非阻塞                                                                                     |

---

## 5. P2 路线图（签收后）

| 优先级 | 项                                  | 说明                                     |
| ------ | ----------------------------------- | ---------------------------------------- |
| P2     | Secure init 默认禁用 echo           | 与 production fragment 对齐              |
| P2     | 修复 `claworks:repair` runtime 导出 | 恢复 doctor --fix 一键路径               |
| P2     | PostgreSQL 默认迁移路径             | `DATABASE_URL` + `pnpm claworks:migrate` |
| P2     | OT 实机验收报告模板                 | mqtt/opcua/modbus 关闭 simulate          |
| P2     | Extension 白名单裁剪                | `pnpm claworks:prune-extensions:apply`   |
| P2     | 依赖 audit 清零                     | protobufjs / qs 升级或 override          |
| P2     | CI 默认 PR 路径                     | evolution / weak-model 保持 optional job |
| P2     | Studio 全功能编辑器                 | 产品路线图                               |

---

## 6. 签收签字

```
交付版本：claworks v2026.5.19 / commit ________________
Pack 版本：claworks-packs @ ________________
验收日期：________________
执行人：__________________

P0 检查项 1–10：通过 ☐  未通过 ☐
P1 检查项（evolution / ot-dry-run / compose / audit）：通过 ☐  部分 ☐

备注：

客户签字：________________
```

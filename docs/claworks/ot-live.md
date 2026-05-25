# OT 连接器实机联调 Runbook

> 预生产 / 现场签收：mqtt、opcua、modbus 真实设备，`simulate: false`。  
> 模拟验收（无实机）：[`pnpm claworks:ot-dry-run`](../../package.json) — 见 [`QUICKSTART.md`](../../QUICKSTART.md#ot-连接器实机验证预生产)。

---

## 1. 生产环境变量清单

按连接器复制对应示例到 `~/.claworks/` 或现场 `.env`，与 `claworks.json` 一并加载：

| 连接器     | 示例文件                                                                           | 关键变量                                                                        |
| ---------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| MQTT       | [`contrib/examples/mqtt.env.example`](../../contrib/examples/mqtt.env.example)     | `CLAWORKS_MQTT_URL`、`CLAWORKS_MQTT_TOPIC`；生产勿设 `CLAWORKS_MQTT_SIMULATE=1` |
| OPC-UA     | [`contrib/examples/opcua.env.example`](../../contrib/examples/opcua.env.example)   | `CLAWORKS_OPCUA_ENDPOINT`；需 `pip install asyncua`                             |
| Modbus TCP | [`contrib/examples/modbus.env.example`](../../contrib/examples/modbus.env.example) | `CLAWORKS_MODBUS_HOST`、`CLAWORKS_MODBUS_PORT`；需 `pip install pymodbus`       |

**生产模式 overlay**（剥离 simulate / echo demo）：

- [`contrib/examples/claworks-personal-production.env.example`](../../contrib/examples/claworks-personal-production.env.example) — 设 `CLAWORKS_PRODUCTION=1`

```bash
# 示例：合并 personal + production overlay
cp contrib/examples/claworks-personal.env.example ~/.claworks/personal.env
cat contrib/examples/claworks-personal-production.env.example >> ~/.claworks/personal.env
set -a; source ~/.claworks/personal.env; set +a
```

MQTT 实机还需：`npm install mqtt`（broker 侧或 connectors 目录，见示例注释）。

---

## 2. 推荐步骤（simulate → 实机对比）

### 2.1 基线：模拟 dry-run（CI / 本地，无需 Gateway）

```bash
pnpm claworks:ot-dry-run
# 期望最后一行：ALL OT DRY-RUN CHECKS PASSED
```

### 2.2 生产配置修复

```bash
export CLAWORKS_PRODUCTION=1
pnpm claworks:doctor --fix
# 或：pnpm claworks:doctor:fix
```

确认 doctor 无 `connectors_simulate` / `connectors_echo_demo` 类错误。

### 2.3 关闭 simulate，填写真实 endpoint

编辑 `~/.claworks/claworks.json` → `plugins.entries.claworks-robot.config.connectors`：

- 各连接器 `simulate: false`
- 填写 mqtt / opcua / modbus 真实 endpoint、topic、凭证（或对应 env 已注入）

加载 OT env（见 §1），重启 Gateway：

```bash
pnpm claworks:gateway
# 或 macOS LaunchAgent：ai.claworks.gateway
```

### 2.4 实机健康检查

```bash
curl -s http://127.0.0.1:18800/v1/connectors
curl -X POST 'http://127.0.0.1:18800/v1/doctor/run?fix=true'
```

期望：连接器状态 healthy；doctor 通过。

### 2.5 事件与 Playbook

1. 触发 OT 告警（MQTT publish / OPC-UA 节点变化 / Modbus 寄存器），或等待 poll。
2. 确认 `process-industry`（或现场 Pack）Playbook 匹配与工单创建。
3. 与 §2.1 dry-run 对比：dry-run 仅验证 ConnectorManager 模拟路径；实机需 §2.4–2.5 全绿。

---

## 3. 只读检查清单（不连真机）

打印现场签收前人工核对项：

```bash
pnpm claworks:ot-live-checklist
# 或：node scripts/claworks-ot-live-checklist.mjs
```

---

## 4. 故障排查

| 现象                 | 检查                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| 连接器 not ready     | endpoint 可达、防火墙、凭证；Python 依赖已装                                       |
| doctor 仍报 simulate | `CLAWORKS_PRODUCTION=1` + `doctor --fix`；检查 config 与 env 未残留 `*_SIMULATE=1` |
| 无 Playbook 匹配     | Pack 已加载、event type 与 connector 配置一致                                      |
| dry-run 绿、实机红   | 对比 `simulate: true/false` 与 env 清单 §1                                         |

相关：[`docs/RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md) P1 #2 · [`install.md`](install.md)

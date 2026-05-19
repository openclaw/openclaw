# ClaWorks 配置模式

> ClaWorks 继承 OpenClaw 的配置体系（`~/.openclaw/agents/<agentId>/agent.json`）。
> ClaWorks 特有的配置通过插件 `claworks-robot` 的 `config` 节注入，路径为：
> `plugins.entries.claworks-robot.config.*`
>
> 单独运行 ClaWorks 时，配置文件位于 `~/.claworks/robots/<robotId>/robot.json`（格式兼容）。

---

## 完整配置示例

```json
{
  "agent": {
    "id": "plant-a-robot",
    "name": "Plant A Robot"
  },
  "gateway": {
    "port": 8000,
    "host": "0.0.0.0"
  },
  "plugins": {
    "entries": {
      "claworks-robot": {
        "enabled": true,
        "config": {
          "robot": {
            "name": "plant-a-robot",
            "description": "Industrial robot for oil refinery Plant A",
            "role": "monolith",
            "port": 8000,
            "host": "0.0.0.0"
          },

          "data": {
            "database_url": "sqlite:///.claworks/plant-a/data.db",
            "kb_path": ".claworks/plant-a/kb",
            "kb_embed_model": "text-embedding-3-small"
          },

          "packs": {
            "auto_load": true,
            "paths": ["~/.claworks/packs", "./packs"],
            "installed": ["base@1.0.0", "process-industry@1.0.0"],
            "registry": "https://nexus.claworks.ai"
          },

          "kernel": {
            "event_queue_size": 10000,
            "playbook_concurrency": 20,
            "hitl_timeout_seconds": 86400,
            "scheduler_timezone": "Asia/Shanghai"
          },

          "a2a": {
            "enabled": true,
            "endpoint": "http://plant-a-robot.internal:8000",
            "trusted_agents": [
              "http://robot-b.internal:8000",
              "http://nexus.claworks.internal:8080"
            ]
          },

          "mcp": {
            "enabled": true,
            "port": 8002
          },

          "connectors": {
            "opcua": {
              "enabled": false,
              "endpoint": "opc.tcp://plc-001:4840"
            },
            "mqtt": {
              "enabled": false,
              "broker": "mqtt://mqtt-broker:1883",
              "topics": ["plant/+/alarm", "plant/+/telemetry"]
            },
            "modbus": {
              "enabled": false,
              "host": "plc-002",
              "port": 502
            }
          },

          "hitl": {
            "default_channel": "feishu",
            "approval_channels": ["feishu", "telegram"],
            "escalation_timeout_seconds": 3600,
            "escalation_channel": "telegram"
          },

          "observability": {
            "prometheus": { "enabled": true, "path": "/v1/metrics" },
            "otel": {
              "enabled": false,
              "endpoint": "http://otel-collector:4317"
            },
            "decision_log": { "enabled": true, "max_entries": 10000 }
          }
        }
      },

      "feishu": {
        "enabled": true,
        "config": {
          "appId": "${FEISHU_APP_ID}",
          "appSecret": "${FEISHU_APP_SECRET}"
        }
      },

      "memory-core": {
        "enabled": true,
        "config": {
          "provider": "lancedb"
        }
      }
    }
  }
}
```

---

## 配置字段说明

### `robot.*` — 机器人身份

| 字段   | 类型   | 默认值             | 说明                                     |
| ------ | ------ | ------------------ | ---------------------------------------- |
| `name` | string | `"claworks-robot"` | 机器人唯一名称，用于 A2A Agent Card      |
| `role` | enum   | `"monolith"`       | `monolith` \| `twin` \| `ops` \| `nexus` |
| `port` | number | `8000`             | HTTP 服务端口                            |
| `host` | string | `"0.0.0.0"`        | 监听地址                                 |

### `data.*` — 数据存储

| 字段             | 类型   | 默认值                          | 说明                                    |
| ---------------- | ------ | ------------------------------- | --------------------------------------- |
| `database_url`   | string | `"sqlite:///.claworks/data.db"` | ObjectStore 数据库（sqlite/postgresql） |
| `kb_path`        | string | `".claworks/kb"`                | 知识库向量存储路径                      |
| `kb_embed_model` | string | `"text-embedding-3-small"`      | KB 嵌入模型                             |

### `packs.*` — 扩展包

| 字段        | 类型     | 说明                                     |
| ----------- | -------- | ---------------------------------------- |
| `auto_load` | boolean  | 启动时自动加载 `installed` 列表中的 Pack |
| `paths`     | string[] | 本地 Pack 搜索路径（按顺序查找）         |
| `installed` | string[] | 已安装的 Pack（格式 `"id@version"`）     |
| `registry`  | string   | Nexus 注册中心 URL                       |

### `kernel.*` — 事件内核

| 字段                   | 类型   | 默认值  | 说明                                         |
| ---------------------- | ------ | ------- | -------------------------------------------- |
| `event_queue_size`     | number | `10000` | 事件队列容量                                 |
| `playbook_concurrency` | number | `20`    | 同时并发执行的 Playbook 实例上限             |
| `hitl_timeout_seconds` | number | `86400` | HITL 节点等待超时（秒），超时后自动 escalate |
| `scheduler_timezone`   | string | `"UTC"` | cron 表达式时区                              |

### `a2a.*` — Robot-to-Robot

| 字段             | 类型     | 说明                                        |
| ---------------- | -------- | ------------------------------------------- |
| `enabled`        | boolean  | 是否启用 A2A 服务器                         |
| `endpoint`       | string   | 本机对外可访问的 A2A URL（写入 Agent Card） |
| `trusted_agents` | string[] | 信任的其他机器人 URL（接受其 A2A Task）     |

### `connectors.*` — OT 连接器

每个 connector 都有 `enabled: boolean`，其余字段协议相关。

| Connector | 关键字段                       |
| --------- | ------------------------------ |
| `opcua`   | `endpoint` — OPC-UA 服务器地址 |
| `mqtt`    | `broker`, `topics`             |
| `modbus`  | `host`, `port`, `unit_id`      |

### `hitl.*` — 人工审批

| 字段                         | 说明                                            |
| ---------------------------- | ----------------------------------------------- |
| `default_channel`            | 默认 HITL 通知渠道（必须是已启用的 IM 插件 ID） |
| `approval_channels`          | 可接受审批回复的渠道列表                        |
| `escalation_timeout_seconds` | 超时后自动升级等待时间                          |
| `escalation_channel`         | 升级通知渠道                                    |

---

## Split 部署配置

当 `role: twin` 或 `role: ops` 时，只有对应平面的配置生效：

**Twin（数据面）**:

```json
{
  "robot": { "role": "twin", "port": 8000 },
  "data": { "database_url": "postgresql://...", "kb_path": "/data/kb" }
}
```

**Ops（编排面）**:

```json
{
  "robot": { "role": "ops", "port": 8001 },
  "kernel": { "playbook_concurrency": 50 },
  "hitl": { "default_channel": "feishu" }
}
```

---

## 环境变量

所有字符串配置支持 `${ENV_VAR}` 占位符，在运行时替换：

```json
{
  "data": { "database_url": "${DATABASE_URL}" },
  "a2a": { "endpoint": "${ROBOT_PUBLIC_URL}" }
}
```

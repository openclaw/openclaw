# ClaWorks 多实例部署 Runbook（单机 · OpenClaw 对接）

> **概念与命令总表**（单实例 / 知识库 / 弃用路径）：先读 **`contrib/examples/claworks-canonical-guide.zh.md`**。本文只讲多实例部署步骤。

目标：在一台机器上运行多个 ClaWorks 实例（monolith 或 twin+ops 拆分），用 **OpenClaw** 统一管理，并通过 `openclaw clawworks` 做健康检查与 doctor 诊断。

**隔离原则**：租户/部门隔离 = **独立进程 + 独立 PostgreSQL 数据库**。不在同一 schema 内做逻辑隔离。

---

## 一、架构选型

| 模式            | 适用场景                         | OpenClaw 配置                               |
| --------------- | -------------------------------- | ------------------------------------------- |
| **monolith**    | 单部门、开发/试点                | 一个 `instances.<name>`，`role: "monolith"` |
| **twin + ops**  | 生产拆分、数据面与编排面独立扩缩 | 两个实例，`twin`/`ops` 互链                 |
| **多 monolith** | 多部门同机、彼此完全隔离         | 多个 `role: "monolith"`，不同端口与 DB      |

OpenClaw 侧只需启用 **`claworks`** 插件；Agent 工具统一为 **`cw_*`**，可选 `instance=<名称>` 切换上下文。

---

## 二、前置条件

1. **PostgreSQL**（每个实例一个 database，例如 `claworks_mfg`、`claworks_supply`）
2. **ClaWorks 平台包**（Python CLI / 守护进程），例如：
   ```bash
   pip install claworks
   # 或设置
   export CLAWWORKS_BIN=/path/to/claworks
   ```
3. **OpenClaw** 已安装，Gateway 可正常启动
4. 合并配置片段：`contrib/examples/claworks-multi-instance.openclaw.fragment.json`

---

## 三、推荐启动顺序（单机三进程示例）

### 1. 创建数据库

```bash
createdb claworks_mfg
createdb claworks_supply
```

### 2. 启动进程（按依赖顺序）

**进程 A — 制造部 monolith（:8000）**

```bash
export DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/claworks_mfg
claworks start --port 8000
# 或：openclaw clawworks start   # monolith
# 或：openclaw clawworks twin start / openclaw clawworks ops start  # 拆分部署
```

**进程 B — 供应链 twin（:8100）**

```bash
export DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/claworks_supply
export CLAWWORKS_RUNTIME_PLANE=twin
claworks start --port 8100
```

**进程 C — 供应链 ops（:8101，与 twin 共用同一 DB）**

```bash
export DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/claworks_supply
export CLAWWORKS_RUNTIME_PLANE=ops
claworks start --port 8101
```

> **注意**：twin 与 ops 若共用业务数据，必须指向 **同一 `DATABASE_URL`**；制造 monolith 使用 **独立库**，实现部门级隔离。

### 3. 合并 OpenClaw 配置

将 `contrib/examples/claworks-multi-instance.openclaw.fragment.json` 合并进 `~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_DIR` 指定目录）：

```json
{
  "plugins": {
    "allow": ["claworks"],
    "entries": {
      "claworks": {
        "enabled": true,
        "config": {
          "instances": {
            "main": {
              "role": "monolith",
              "url": "http://localhost:8000",
              "label": "制造部"
            },
            "supply-twin": {
              "role": "twin",
              "url": "http://localhost:8100",
              "ops": "supply-ops",
              "label": "供应链 · 数据面"
            },
            "supply-ops": {
              "role": "ops",
              "url": "http://localhost:8101",
              "twin": "supply-twin",
              "label": "供应链 · 编排面"
            }
          },
          "default": "main"
        }
      }
    }
  }
}
```

重启 OpenClaw Gateway 使插件配置生效。

---

## 四、验证步骤（OpenClaw 侧）

以下命令 **不依赖** 额外脚本，直接读 `openclaw.json` 并探测 HTTP：

```bash
# 1. 列出全部实例 + 实时健康（推荐第一步）
openclaw clawworks

# 2. 表格列表（角色、URL、default、twin/ops 链接）
openclaw clawworks list

# 3. 单实例详细健康（含 version）
openclaw clawworks status supply-twin -v

# 4. 全实例 doctor（POST /v1/doctor/run）
openclaw clawworks doctor

# 5. 单实例 doctor 并尝试自动修复
openclaw clawworks doctor main --fix
```

**预期结果**：

- 三个实例均显示 `●` 绿色可达（或终端主题下的 success 标记）
- `supply-twin` 的 `ops=supply-ops`，`supply-ops` 的 `twin=supply-twin`
- `default` 指向 `main`
- Agent 调用 `cw_status` / `cw_instances` 与 CLI 观测一致

**与 OpenClaw 内置命令区分**：

| 命令                        | 检查对象                                   |
| --------------------------- | ------------------------------------------ |
| `openclaw doctor`           | OpenClaw 自身（Gateway、通道、配置）       |
| `openclaw clawworks doctor` | ClaWorks 各实例 HTTP `/v1/doctor/run`      |
| `openclaw status`           | OpenClaw Gateway / 通道                    |
| `openclaw clawworks status` | `plugins.entries.claworks.config` 中的实例 |

---

## 五、Agent 工具路由（自动）

配置完成后，**无需**在对话里手动指定 URL：

| 工具类型 | 示例                                     | 路由规则                                            |
| -------- | ---------------------------------------- | --------------------------------------------------- |
| 数据面   | `cw_query_objects`、`cw_kb_search`       | → twin 或 monolith；对 ops 实例自动跟随 `twin` 链接 |
| 编排面   | `cw_trigger_playbook`、`cw_hitl_pending` | → ops 或 monolith；对 twin 实例自动跟随 `ops` 链接  |
| 显式切换 | 任意 `cw_*` + `instance=supply-ops`      | 从指定实例出发再按上表路由                          |

---

## 六、故障排查

| 现象                               | 可能原因                             | 处理                                                        |
| ---------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| `No ClaWorks instances configured` | 未配置 `plugins.entries.claworks`    | 合并 fragment JSON，重启 Gateway                            |
| 实例 `●` 不可达                    | 进程未启动或端口错误                 | `openclaw clawworks twin start`（或 `ops start`）并检查端口 |
| twin 工具报「no twin link」        | ops 实例未配置 `twin`                | 在 ops 条目加 `"twin": "<twin-id>"`                         |
| playbook 工具报「no ops link」     | twin 实例未配置 `ops`                | 在 twin 条目加 `"ops": "<ops-id>"`                          |
| 多实例未指定 default 报错          | 配置了多个 instance 但未设 `default` | 增加 `"default": "main"` 或工具传 `instance=`               |
| doctor 超时                        | DB 迁移未完成或连接串错误            | 检查 `DATABASE_URL`、PostgreSQL 可达性                      |

---

## 七、生产建议

1. **不要随意重启** ClaWorks 企业进程；优先 `cw_reload_packs` / `openclaw clawworks doctor` 诊断。
2. **每部门独立 DB + 独立备份**；ops 与 twin 同部门可共库，跨部门禁止共库。
3. **apiKey**：生产环境在 `instances.<name>.apiKey` 配置 Bearer，与 ClaWorks 网关鉴权一致。
4. **监控**：cron 或外部探针定期执行 `openclaw clawworks status`，失败告警。
5. **文档**：英文插件指南见 [ClaWorks plugin](/plugins/claworks)；CLI 见 [ClawWorks CLI](/cli/clawworks)。

---

## 相关文件

- 配置片段：`contrib/examples/claworks-multi-instance.openclaw.fragment.json`
- OpenClaw 插件：`extensions/claworks/`
- 实例解析测试：`packages/claworks-client/src/instance-resolver.test.ts`
- CLI 集成测试：`src/cli/clawworks-cli.integration.test.ts`

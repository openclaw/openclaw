# ClaWorks 安装指南

> 源码安装（fork checkout）与 npm 全局安装说明。与 [`QUICKSTART.md`](../../QUICKSTART.md) 互补。

---

## 与官方 OpenClaw 共存

ClaWorks 与官方 [OpenClaw](https://github.com/openclaw/openclaw) **可同时安装**，互不覆盖：

| 项           | ClaWorks                    | 官方 OpenClaw               |
| ------------ | --------------------------- | --------------------------- |
| 全局 CLI     | **`claworks`**              | **`openclaw`**              |
| 配置目录     | `~/.claworks/claworks.json` | `~/.openclaw/openclaw.json` |
| Gateway 端口 | **18800**（默认）           | **18789**（默认）           |
| LaunchAgent  | `ai.claworks.gateway`       | `ai.openclaw.gateway`       |

ClaWorks 发行版**不**发布 `openclaw` bin（见 [`REBRAND-TO-CLAWORKS.md`](../design/REBRAND-TO-CLAWORKS.md)）。若已有 OpenClaw 并想远程操作 ClaWorks Gateway，安装桥接扩展 `@claworks/openclaw-extension`，在 `~/.openclaw/openclaw.json` 中配置 `plugins.entries.claworks`。

---

## 方式 A：源码安装（推荐开发 / 签收）

```bash
git clone https://github.com/claworks/claworks.git
cd claworks
pnpm install

# 可选：Pack 仓（sibling）
cd .. && git clone https://github.com/claworks/claworks-packs.git && cd claworks

# 首次一条龙：doctor --fix → init → repair → onboard
pnpm claworks:setup

# 启动（含 bootstrap，优先于裸 gateway run）
pnpm claworks:start

# 健康检查
pnpm claworks:doctor
curl -s http://127.0.0.1:18800/v1/health
```

**验收（发布前）：**

```bash
pnpm claworks:smoke
pnpm claworks:gateway:e2e
pnpm claworks:ot-dry-run    # OT 模拟连接器，无需实机
```

---

## 方式 B：npm 全局安装（预发布 / 私有 registry）

根包 `package.json` 已配置：

- `"name": "claworks"`
- `"bin": { "claworks": "claworks.mjs" }`

公开发布前见 [`REBRAND-TO-CLAWORKS.md`](../design/REBRAND-TO-CLAWORKS.md) 阶段 B。**当前策略**：`npm publish` 需人工审批；tarball 预览：

```bash
pnpm claworks:publish:dry-run              # 根包 claworks
pnpm claworks:runtime:publish:dry-run      # @claworks/runtime
```

```bash
# 待 registry 开放后
npm i -g claworks
claworks setup
claworks start
claworks doctor
```

全局安装后仍建议 sibling 挂载 `claworks-packs`，或通过 `CLAWORKS_PACKS_DIR` 指向 Pack 目录。

---

## 环境变量速查

| 变量                    | 默认                       | 说明         |
| ----------------------- | -------------------------- | ------------ |
| `CLAWORKS_STATE_DIR`    | `~/.claworks`              | 状态与配置根 |
| `CLAWORKS_CONFIG`       | `$STATE/claworks.json`     | 配置文件     |
| `CLAWORKS_GATEWAY_PORT` | `18800`                    | 网关端口     |
| `CLAWORKS_PACKS_DIR`    | `../claworks-packs`        | Pack 源目录  |
| `CLAWORKS_PRODUCT`      | （由 `claworks.mjs` 设置） | 产品模式     |

---

## 下一步

- [`QUICKSTART.md`](../../QUICKSTART.md) — 模型 / 飞书 / Pack 配置
- [`RELEASE-CHECKLIST.md`](../RELEASE-CHECKLIST.md) — 签收清单
- [`MULTI-INSTANCE-DEPLOYMENT.md`](../MULTI-INSTANCE-DEPLOYMENT.md) — 多实例与桥接

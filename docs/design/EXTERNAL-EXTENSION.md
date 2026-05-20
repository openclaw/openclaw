# openclaw-claworks-extension（独立外仓）

**本地路径**：`/Users/power/Projects/openclaw-claworks-extension`（与 `claworks` 同级）

## 用途

供**未 Fork** 的官方 OpenClaw 用户，通过 HTTP/MCP 连接远程 ClaWorks Gateway（默认 `http://127.0.0.1:18800`）。

不捆绑 `@claworks/runtime`（完整工业内核在 [claworks](https://github.com/claworks/claworks) Fork + `extensions/claworks-robot`）。

## npm 包

| 包名                               | 路径                               |
| ---------------------------------- | ---------------------------------- |
| `@claworks/openclaw-extension`     | `extensions/claworks/`             |
| `@claworks/openclaw-client`        | `packages/claworks-client/`        |
| `@claworks/openclaw-plugin-bridge` | `packages/claworks-plugin-bridge/` |

## 安装（OpenClaw）

```bash
openclaw plugins install -l /Users/power/Projects/openclaw-claworks-extension/extensions/claworks
# 或未来：openclaw plugins install @claworks/openclaw-extension
```

## 开发

```bash
cd /Users/power/Projects/openclaw-claworks-extension
pnpm install
pnpm test:client
pnpm test:extension
```

外仓 README：`../openclaw-claworks-extension/README.md`

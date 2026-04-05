1. 启动 UI 开发服务器：`pnpm ui:dev`
2. 打开类似以下的 URL：

```text
http://localhost:5173/?gatewayUrl=ws%3A%2F%2F<gateway-host>%3A18789
```

可选的一次性认证（如需要）：

```text
http://localhost:5173/?gatewayUrl=wss%3A%2F%2F<gateway-host>%3A18789#token=<gateway-token>
```

注意：

- `gatewayUrl` 在加载后存储在 localStorage 中并从 URL 中移除。
- 如果你通过 `gatewayUrl` 传入完整的 `ws://` 或 `wss://` 端点，请先进行 URL 编码，避免浏览器错误解析查询字符串。
- `token` 应尽量通过 URL 片段（`#token=...`）传递。片段不会发送到服务器，从而避免请求日志和 Referer 泄露。旧的 `?token=` 查询参数仍会出于兼容性被一次性导入，但仅作为回退方案，并会在引导后立即移除。
- `password` 仅保留在内存中。
- 当 Gateway 网关位于 TLS 后面时（Tailscale Serve、HTTPS 代理等），使用 `wss://`。

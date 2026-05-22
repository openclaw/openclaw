# OrioSearch（自托管）与 OpenClaw `web_search` 对接说明

**OrioSearch** 是常见的 **Tavily 兼容** 自托管搜索 API（HTTP **`/search`**、**`/extract`**）。OpenClaw 不内置「Orio」专用字段，而是通过已打包的 **`tavily` 插件**，把 **API 基址** 指到你的 Orio 实例即可。

**端口**：官方 Docker 编排里 **`orio-search-api` 通常监听 `8000`**（见上游 **`docker-compose.yml`**）；**`8080`** 一般是 **SearXNG**，不要把 `baseUrl` 指到 SearXNG。

**谁负责启动 Orio**：OpenClaw Gateway **不会**替你拉起 Python/Redis/SearXNG 栈；你在本机用 **`docker compose`**、或 **`contrib/scripts/oriosearch-docker-up.sh`**（可选）先起 Orio，再配置 **`OPENCLAW_OPTIMIZE_ORIOSEARCH_BASE_URL=http://127.0.0.1:8000`** 与网关。

实现细节见仓库代码 **`extensions/tavily/src/config.ts`**（支持 **`plugins.entries.tavily.config.webSearch.baseUrl`** 与 **`TAVILY_BASE_URL` 环境变量**）。

---

## 1. 一键合并（推荐）

在**本机终端**（勿在 IDE 里写含密钥的 `openclaw.json`）：

```bash
export OPENCLAW_OPTIMIZE_ORIOSEARCH_BASE_URL="http://127.0.0.1:8000"
# 若 Orio 要求与 Tavily 相同的 Bearer，再设（按 Orio 文档）：
# export TAVILY_API_KEY="your-key-or-dummy"

cd /path/to/openclaw
node scripts/optimize-personal-two-channel-config.mjs --dry-run
node scripts/optimize-personal-two-channel-config.mjs --apply
```

脚本会合并：

- **`tools.web.search.enabled: true`**
- **`tools.web.search.provider: "tavily"`**（插件 id）
- **`plugins.allow`** 含 **`tavily`**
- **`plugins.entries.tavily.config.webSearch.baseUrl`** 为你的 Orio 根地址（**无**路径后缀，与 Tavily 客户端拼接 `/search` 的方式一致）

若你曾显式 **`plugins.entries.tavily.enabled: false`**，脚本会跳过；要覆盖请设 **`OPENCLAW_OPTIMIZE_FORCE_TAVILY_WEB_SEARCH_MERGE=1`**。

---

## 2. 手工配置（等价 JSON 思路）

在 **`openclaw.json`** 中保证：

1. **`plugins.allow`** 包含 **`tavily`**，且 **`plugins.entries.tavily.enabled`** 为 **`true`**。
2. **`plugins.entries.tavily.config.webSearch.baseUrl`** = Orio 根 URL。
3. **`tools.web.search.enabled: true`**，**`tools.web.search.provider: "tavily"`**。

密钥：按 Orio 与网关实现，通常与 Tavily 一样走 **`TAVILY_API_KEY`**，或写在 **`plugins.entries.tavily.config.webSearch.apiKey`**（支持 SecretRef，见 **`docs/gateway/secrets.md`**）。

**重要**：即便 Orio 日志里 **`auth=disabled`**，OpenClaw 侧 **`tavily` 客户端仍会校验「已配置 API Key」**（见 **`extensions/tavily/src/tavily-client.ts`**）。若 Orio 不校验 Bearer，可在网关环境设 **任意非空占位符**，例如 **`export TAVILY_API_KEY="orio-local"`**，避免搜索请求在 OpenClaw 内被直接拒绝。

### Orio 的 rerank 模型能否给 OpenClaw 别处用？

**不能「直接复用」**。**`ms-marco-MiniLM-L-12-v2`** 由 Orio 在进程内加载，用于其 **搜索流水线中的重排**；OpenClaw 的 **`memory_search`**、嵌入与其它能力走**另一套配置**（见 **`docs/concepts/memory-search.md`**），与 Orio 的 ONNX/模型目录无自动共享。若要在 OpenClaw 里做向量检索重排，需单独选模型与管线，与 Orio 无绑定关系。

---

## 3. 自检

1. Orio 进程在本机/内网可访问（`curl` 根或文档里的 health）。
2. **`pnpm openclaw gateway restart`**。
3. 在会话里触发需要 **`web_search`** 的任务，或查看 **`openclaw doctor`** 与网关日志中 **tavily** 插件是否加载。
4. **与 `memory_search` 无关**：`memory_search` 是 **记忆嵌入 + BM5**；**`web_search`** 是 **联网检索工具**。两者都要强，需分别配置 **embedding** 与 **Orio + tavily 插件**。

---

## 4. 仍不工作时的排查

| 现象         | 可能原因                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 工具未出现   | **`group:web`** 未被 `tools.profile`/`allow` 放行；或 **`tools.web.search.enabled`** 未生效。                           |
| 请求 401/403 | Orio 需要 **API Key**，补 **`TAVILY_API_KEY`** 或 Orio 文档中的头部。                                                   |
| 连接拒绝     | **baseUrl** 错端口/未监听；Docker 网络未映射到宿主机。                                                                  |
| 404          | Orio 版本与 Tavily 路径不一致；升级到文档声称 **Tavily-compatible** 的版本或核对 **`/search`** 是否在根路径下拼接正确。 |

更多：`extensions/tavily/src/tavily-client.ts`（端点拼装逻辑）。

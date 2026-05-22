# 极简：`飞书 + 微信` + `Qwen（自建接口）` + `本机 Orio`

目标：只保留 **飞书（工作）**、**微信插件 `openclaw-weixin`（生活）**，模型走你 **OpenAI 兼容网关上的 Qwen**，联网搜索走 **本机 Orio（Tavily 兼容）**；其余通道、多余智能体、无关插件由你**手工收敛**。

**依据**：同一套逻辑已由 **`scripts/optimize-personal-two-channel-config.mjs`** 实现大半（bindings、关通道、tavily+Orio、可选 memory/wiki）；本页说明「四件套」下你还要**删掉什么**。

---

## 一、一次性环境变量（终端里执行）

在**本仓库根目录**的普通终端执行（按需改 **`OPENCLAW_CONFIG_PATH`**、`ORIO_URL`）。

```bash
export OPENCLAW_OPTIMIZE_ORIOSEARCH_BASE_URL="http://127.0.0.1:8000"
# OpenClaw 侧 tavily 客户端仍会校验非空 key；Orio auth=disabled 时可占位：
export TAVILY_API_KEY="orio-local"

cd /path/to/openclaw
node scripts/optimize-personal-two-channel-config.mjs --dry-run
node scripts/optimize-personal-two-channel-config.mjs --apply
```

**`--dry-run`** 时请确认：**`bindings`** 只有 **feishu → main**、**openclaw-weixin → personal-life**；**`tools.web.search`** 为 **`provider: "tavily"`** 且 **`plugins.entries.tavily.config.webSearch.baseUrl`** 为上述 Orio 根地址。**不要**再在 JSON 里写 **`"provider": "orio"`**（无效 id）。

---

## 二、Qwen：保留 `models.providers` + 设默认主模型

在 **`openclaw.json`** 里保留你的 **`models.providers`**（例如 **`custom-39-170-37-25-63000`** 与 **`Qwen3.6-35B-A3B`** 等），并让 **`agents.defaults.model`** 指向其中一个 **`provider/model`**，例如：

```json5
{
  agents: {
    defaults: {
      models: {
        "custom-39-170-37-25-63000/Qwen3.6-35B-A3B": {
          alias: "Qwen3.6-35B-A3B",
        },
      },
      model: {
        primary: "custom-39-170-37-25-63000/Qwen3.6-35B-A3B",
      },
    },
  },
}
```

**provider id / 模型 id 须与 `models.providers.*.models[].id` 完全一致**；若你关掉其它 provider，可把 **`models.mode`** 与多余 **`providers`** 条目一并删减（注意不要误删网关仍解析中的键）。详见 **`docs/gateway/config-agents.md`**（**`agents.defaults.model`**）。

---

## 三、手工裁剪：`agents.list`（必做）

脚本**不会删除**你已存在的 **`finance-agent` / `office-agent` / `service-*` 等**条目。你只要 **飞书→`main`**、**微信→`personal-life`**，请只保留 **`id` 为 `main` 与 `personal-life` 的两条**（或等价重命名但必须与 **`bindings`** 一致），删掉其余 agent 整块；若有 **`model: "Claude …"`**，删 agent 后即不再要求 Anthropic 密钥。

可选：为两条 agent 收窄 **`tools`**（保留 **`tools.profile`** 如 **`coding`** / **`messaging`** 时，对齐 **`docs/gateway/config-tools.md`**）。

---

## 四、插件白名单：`plugins.allow`（建议收紧）

脚本会为 **memory、tavily** 等做 **uniquePush**。若你要 **极简、且不使用记忆/wiki**：可先令 **`plugins.entries.memory-core`、`memory-wiki` 为 `enabled: false`**；此时脚本默认**跳过**重新启用这两项（除非你设 **`OPENCLAW_OPTIMIZE_FORCE_MEMORY_CORE=1` / `OPENCLAW_OPTIMIZE_FORCE_MEMORY_WIKI=1`**，见 **`contrib/operator-playbooks/personal-gateway-optimization.zh.md`**）。然后**手动从 **`plugins.allow` 删掉\*\*你不想加载的 id。

**极简通常至少保留**：**`feishu`**、**`openclaw-weixin`**、**`tavily`**（网页搜索）。

其它如 **`acpx`、`copilot-proxy`、`device-pair`、`diffs`、`diagnostics-otel`**：未接业务则建议 **`enabled: false`** 并从 **`allow`** 去掉，避免 doctor 与加载噪音。

---

## 五、`plugins.entries` 与通道对齐

优化脚本已将 **WhatsApp / Telegram / Discord / Google Chat / Slack / Signal / iMessage / Line** 的 **`channels.*.enabled`** 设为 **`false`**，并把这些通道对应插件条目 **`enabled: false`**。请确认 **`plugins.entries.feishu`、`openclaw-weixin`、`tavily`** 为 **`enabled: true`**；**`tavily`** 下的 **`webSearch.baseUrl`、`apiKey`（占位）** 与 **`tools.web.search.enabled: true`** 一致。**`orio` 不是合法的 `tools.web.search.provider`**，必须使用 **`tavily`** + **Orio HTTP 地址**。

---

## 六、网关与 Control UI（建议）

若 **`gateway.controlUi.root`** 仍指向全局 **`node_modules/openclaw`**，脚本在满足条件时会改到仓库 **`dist/control-ui`**；否则请 **`pnpm ui:build`** 后对齐路径或仅用 CLI。

---

## 七、发布后自检顺序

```bash
pnpm openclaw doctor
pnpm openclaw gateway restart
```

在会话中各测一次：**飞书、`main`**；**微信、`personal-life`**；并触发一次 **`web_search`**（应命中本机 Orio）。

---

## 八、本页不覆盖的内容

- **飞书 / 微信** 的 appId、密钥、租户：仍须在通道侧与安全存储完成；见 **`docs/channels/feishu.md`** 等与插件自述。
- **Orio**：须先 **`http://127.0.0.1:8000`**（或你的端口）可访问；Compose 可参考 **`contrib/scripts/oriosearch-docker-up.sh`**。
- **自建 Qwen**：**base URL、密钥**若在 provider 表里，勿提交 git。

更完整的环境变量表仍以 **`contrib/operator-playbooks/personal-gateway-optimization.zh.md`** 为准；**Orio + tavily** 接线见 **`contrib/examples/oriosearch-web-search.zh.md`**。

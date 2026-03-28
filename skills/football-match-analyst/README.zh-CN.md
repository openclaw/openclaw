# 足球比赛分析技能（Football match analyst）

面向 **OpenClaw** 的 bundled 技能：在宿主机用 Node 运行 `match-context.mjs`，从 **API-Football**、**Sportmonks**、**纳米数据（Nami）**、**Opta / Stats Perform（可配置 REST）** 或 **本地 Football-Data.co.uk 赛季 CSV（`--provider football-data`，无 API Key）** 拉取比赛与球队数据，输出 **`llmPack`**（精炼 JSON），供大模型做赛前情报与结构化分析，而无需把整段原始 API 响应塞进上下文。

---

## 它能做什么

| 能力                         | 说明                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| **比赛与球队上下文**         | 按 **日期 + 主客队名称**，或直接使用 **`--fixture` 比赛 ID**，解析场次并聚合数据。      |
| **近期战绩与基本面**         | 可配置 **`--last`（5–100 场）** 窗口，汇总胜平负、进球/失球、主客场拆分等。             |
| **交锋（H2H）**              | 从历史对阵中抽取双方直接对话摘要。                                                      |
| **技术指标（视数据源而定）** | 例如近 5 场的 **xG、控球率** 等（取决于联赛与套餐是否提供）。                           |
| **赛程负荷**                 | 赛前一段时间内的比赛密度（如「近 7 天场次」类指标），辅助判断体能周期。                 |
| **伤停与赔率（视数据源）**   | 伤停列表、赔率快照等（以各 API 实际返回为准）。                                         |
| **给模型用的统一输出**       | 主产物为 **`llmPack`**（`schemaVersion` 2）；**`--verbose`** 时才附带大体积 **`raw`**。 |

脚本负责 **量化与结构化**；**战意、德比叙事、停赛传闻、长途客场、天气** 等仍需模型结合 **联网搜索** 补充，并在 SKILL 中按「五维分析」组织回答。

---

## 有什么优势

1. **省 token**：输出以 `llmPack` 为主，避免把完整 API 树塞进对话。
2. **多数据源**：同一套 CLI，用 **`--provider`** 选单一来源，或用 **`--providers a,b,c`** **并行**拉取多个来源；多源模式下返回 **`bySource`**（各家的 `llmPack`），并可用 **`--primary-provider`** 指定顶层 `llmPack` 以哪家为准。
3. **灵活窗口**：`--last` 可在 5–100 之间调节，平衡样本量与请求量。
4. **两种定位方式**：队名解析或 **`--fixture` ID**（适合已知官方 ID 的流程）；CSV 模式下可用 **`csv-N`**（N 为数据行序号，从 0 起）。
5. **CSV 历史数据**：配合 **`football-local-data`** 技能（`local-data-fetch.mjs`）下载赛季 CSV，即可**无密钥**生成与 API 管线一致的 **`llmPack`**（伤停为空；技术指标以 HST/AST 等为 proxy）。
6. **纳米侧可配置**：路径与查询参数可通过 **`NAMI_*` 环境变量** 对齐合同（无球队搜索时可用 **`NAMI_HOME_TEAM_ID` / `NAMI_AWAY_TEAM_ID`**）。
7. **Opta 侧可配置**：通过 **`OPTA_API_BASE`**、**`OPTA_API_KEY`** 与 **`OPTA_PATH_*`** 对齐你与 Stats Perform / 集成商签订的 REST 合同（无球队搜索时用 **`OPTA_HOME_TEAM_ID` / `OPTA_AWAY_TEAM_ID`**）。
8. **与 OpenClaw 配置集成**：密钥可放在 **`~/.openclaw/openclaw.json`** 的 **`skills.entries`** 里，由网关注入宿主机技能进程环境，不必写进提示词（CSV 路径可设 **`FOOTBALL_DATA_CSV`**）。

---

## 怎么接入 OpenClaw

### 前置条件

- 宿主机已安装 **Node.js**（技能元数据要求 `node` 在 PATH 中）。
- 若使用 API 数据源：已购买并配置相应 **API 密钥**（见下表）；若仅用 **Football-Data CSV**，则只需本机有下载好的 CSV 文件路径。

### 技能本身

本仓库已 **bundled** 该技能，技能名为 **`football_match_analyst`**，入口说明见同目录下的 **`SKILL.md`**（英文，供 Agent 行为约束与合规条款）。

### 在 `openclaw.json` 里注入密钥（推荐）

不要把密钥粘贴到聊天里。将对应环境变量写在配置中，例如 **`~/.openclaw/openclaw.json`**：

```json
{
  "skills": {
    "entries": {
      "football_match_analyst": {
        "env": {
          "API_FOOTBALL_KEY": "你的_key"
        }
      }
    }
  }
}
```

**多源并行**时在同一 `env` 对象里写入所有会用到的密钥，例如：

```json
{
  "skills": {
    "entries": {
      "football_match_analyst": {
        "env": {
          "API_FOOTBALL_KEY": "你的_key",
          "SPORTMONKS_TOKEN": "你的_token"
        }
      }
    }
  }
}
```

按你实际使用的 **`--provider`** 或 **`--providers`** 填齐所需变量（**多源时需同时配置所有启用来源的密钥**，例如同时有 `API_FOOTBALL_KEY` 与 `SPORTMONKS_TOKEN`）：

| 数据源                     | 环境变量                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| API-Football（默认）       | `API_FOOTBALL_KEY`                                                                                 |
| Sportmonks                 | `SPORTMONKS_TOKEN` 或 `SPORTMONKS_API_TOKEN`                                                       |
| 纳米数据                   | `NAMI_USER` + `NAMI_SECRET`                                                                        |
| Opta / Stats Perform       | `OPTA_API_BASE` + `OPTA_API_KEY`（并按需配置 `OPTA_PATH_*`、`OPTA_AUTH_MODE` 等）                  |
| Football-Data.co.uk（CSV） | 无 API Key；用 **`--csv`** 或 **`FOOTBALL_DATA_CSV`** / **`FOOTBALL_DATA_CSV_PATH`** 指定 CSV 路径 |

纳米若需固定球队 ID（套餐无搜索时常见），可同域增加：`NAMI_HOME_TEAM_ID`、`NAMI_AWAY_TEAM_ID`，可选 `NAMI_HOME_TEAM_NAME`、`NAMI_AWAY_TEAM_NAME` 作展示名。

Opta 若合同未开放球队搜索，请在 `env` 中设置 `OPTA_HOME_TEAM_ID`、`OPTA_AWAY_TEAM_ID`，可选 `OPTA_HOME_TEAM_NAME`、`OPTA_AWAY_TEAM_NAME`。

全局说明与更多选项见官方文档：[Skills 配置](https://docs.openclaw.ai/tools/skills-config)。

---

## 命令行参数（怎么使用）

脚本路径（相对仓库根目录）：

`skills/football-match-analyst/scripts/match-context.mjs`

### 参数一览

| 参数                 | 含义                                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--provider`         | 单一来源：`api-football`（默认）\|`sportmonks`\|`nami`\|`opta`（或 `statsperform`）\|`football-data`（或 `fd`、`football-data-co-uk`、`football-local-data`） |
| `--providers`        | 多源，逗号或分号分隔，例如 `api-football,sportmonks`（≥2 个时输出 `bySource`）                                                                                |
| `--primary-provider` | 多源时可选，指定哪家作为顶层 **`llmPack`** 的镜像（须出现在 `--providers` 中）                                                                                |
| `--date`             | 比赛日，`YYYY-MM-DD`（与 `--home` / `--away` 一起用）                                                                                                         |
| `--home`             | 主队名称（字符串）                                                                                                                                            |
| `--away`             | 客队名称（字符串）                                                                                                                                            |
| `--fixture`          | 比赛 ID（数字）；指定后走 ID 解析，通常不再要求日期队名                                                                                                       |
| `--last`             | 历史样本场数，**5–100**，默认 **50**                                                                                                                          |
| `--verbose`          | 输出中带大体积 **`raw`**（调试用）                                                                                                                            |
| `--csv`              | 与 **`football-data`** 配合：指定 CSV 文件路径（也可用环境变量代替）                                                                                          |
| `-h` / `--help`      | 打印用法                                                                                                                                                      |

### 示例

**API-Football（默认）：**

```bash
export API_FOOTBALL_KEY="你的_key"
node skills/football-match-analyst/scripts/match-context.mjs \
  --date 2026-03-30 \
  --home "Manchester United" \
  --away "Liverpool" \
  --last 80
```

**Sportmonks：**

```bash
export SPORTMONKS_TOKEN="你的_token"
node skills/football-match-analyst/scripts/match-context.mjs \
  --provider sportmonks \
  --date 2026-03-30 \
  --home "Manchester United" \
  --away "Liverpool" \
  --last 80
```

**纳米数据：**

```bash
export NAMI_USER="合同_user"
export NAMI_SECRET="合同_secret"
node skills/football-match-analyst/scripts/match-context.mjs \
  --provider nami \
  --date 2026-03-30 \
  --home "主队名" \
  --away "客队名" \
  --last 50
```

**Opta / Stats Perform（须将网关与路径配成与你的合同一致）：**

```bash
export OPTA_API_BASE="https://你的合同网关"
export OPTA_API_KEY="你的密钥"
export OPTA_HOME_TEAM_ID="12345"
export OPTA_AWAY_TEAM_ID="67890"
node skills/football-match-analyst/scripts/match-context.mjs \
  --provider opta \
  --date 2026-03-30 \
  --home "主队名" \
  --away "客队名" \
  --last 50
```

**Football-Data.co.uk 本地 CSV（无 API Key）：**

先下载赛季文件（示例：英格兰各级联赛 bundle）：

```bash
node skills/football-local-data/scripts/local-data-fetch.mjs \
  --out skills/football-local-data/data/latest \
  --preset england
```

再生成 `llmPack`（示例路径为相对仓库根目录）：

```bash
node skills/football-match-analyst/scripts/match-context.mjs \
  --provider football-data \
  --csv skills/football-local-data/data/latest/E0.csv \
  --date 2025-08-16 \
  --home "Arsenal" \
  --away "Wolves" \
  --last 50
```

**多源并行（示例：API-Football + Sportmonks，需在环境中同时配置两种密钥）：**

```bash
export API_FOOTBALL_KEY="你的_key"
export SPORTMONKS_TOKEN="你的_token"
node skills/football-match-analyst/scripts/match-context.mjs \
  --providers api-football,sportmonks \
  --primary-provider api-football \
  --date 2026-03-30 \
  --home "Manchester United" \
  --away "Liverpool" \
  --last 50
```

**已知比赛 ID：**

```bash
node skills/football-match-analyst/scripts/match-context.mjs --fixture 12345678 --last 50
node skills/football-match-analyst/scripts/match-context.mjs --provider sportmonks --fixture 12345678
node skills/football-match-analyst/scripts/match-context.mjs --provider opta --fixture 12345678 --last 50
# CSV 模式（行号 0 = 第一行数据）：--provider football-data --csv .../E0.csv --fixture 0
# 多源（需各源密钥）：并行拉取多场详情后再看 bySource
export API_FOOTBALL_KEY="..." SPORTMONKS_TOKEN="..."
node skills/football-match-analyst/scripts/match-context.mjs --providers api-football,sportmonks --fixture 12345678 --last 50
```

### 输出说明

**单源（仅 `--provider` 或 `--providers` 里只有一个）**

- **`llmPack`**：给模型分析的主输入。
- **`meta.warnings`**：队名歧义、当日未匹配到场次等提示。
- **`raw`**：仅 **`--verbose`** 时出现。

**多源（`--providers` 中含至少两个）**

- **`multiSource: true`**，**`bySource`**：键为 `api-football` / `sportmonks` / `nami` / `opta`，值为各家完整结果（含各自的 `llmPack`）。
- **`primaryProvider`** 与顶层 **`llmPack`**：便于快速阅读；完整对比请以 **`bySource`** 为准。
- **`meta.combinedWarnings`**：带来源前缀的合并告警。
- 某一源缺密钥或失败时，**其它源仍可能成功**，不会整批失败。

---

## 纳米数据（Nami）进阶：环境变量

默认网关与路径对齐纳米「足球资料库」常见 **v5** 接口；若与你的合同不一致，可通过环境变量覆盖（也可写入 `skills.entries.football_match_analyst.env`）。

| 变量                                            | 作用                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `NAMI_API_BASE`                                 | API 根地址，默认 `https://open.sportnanoapi.com`                                       |
| `NAMI_PATH_MATCH_LIST` 等                       | 各接口 HTTP 路径覆盖（如 `NAMI_PATH_TEAM_MATCHES`、`NAMI_PATH_MATCH_DETAIL` 等）       |
| `NAMI_PARAM_START_TIME` / `NAMI_PARAM_END_TIME` | 按日筛选时的时间参数名，默认 `start_time` / `end_time`（UTC 当日 Unix 范围由脚本计算） |
| `NAMI_MATCH_LIST_EXTRA`                         | JSON 字符串，合并到比赛列表请求的查询参数                                              |
| `NAMI_STATUS_FINISHED_IDS`                      | 视为「已完赛」的状态 ID 列表，逗号分隔                                                 |
| `NAMI_SEASON_ID` + `NAMI_PARAM_SEASON_ID`       | 赛季类接口需要显式赛季时                                                               |

完整列表与官方接口说明以 **`SKILL.md`** 中 **Nami path and parameter overrides** 小节及纳米文档为准：[足球资料库接口说明](https://www.nami.com/zh/details/7j8gxi0to7inrql#interface)。

---

## Opta / Stats Perform 进阶：环境变量

Opta 数据通常经 **Stats Perform** 等合同以 REST 交付，**基址与路径没有全局统一默认值**；脚本提供占位默认路径，**你必须按合同设置 `OPTA_PATH_*`**，否则请求会 404 或解析失败。

| 变量                                                                          | 作用                                                                                      |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `OPTA_API_BASE`                                                               | 网关根 URL（必填），勿带末尾 `/`                                                          |
| `OPTA_API_KEY`                                                                | 密钥（必填）                                                                              |
| `OPTA_AUTH_MODE`                                                              | `subscription`（默认，Azure APIM 风格 `Ocp-Apim-Subscription-Key`）、`bearer` 或 `apikey` |
| `OPTA_AUTH_HEADER`                                                            | `apikey` 模式下的请求头名（默认 `X-API-Key`）                                             |
| `OPTA_PATH_MATCH_BY_ID`                                                       | 单场详情，默认 `/matches/{matchId}`                                                       |
| `OPTA_PATH_TEAM_FIXTURES`                                                     | 球队赛程，默认 `/teams/{teamId}/fixtures`                                                 |
| `OPTA_PATH_FIXTURES_BY_DATE`                                                  | 按日赛程，默认 `/fixtures` + `OPTA_PARAM_DATE`                                            |
| `OPTA_PATH_H2H`                                                               | 历史交锋；失败时脚本会回退为合并两队历史并筛选                                            |
| `OPTA_PATH_TEAM_SEARCH`                                                       | 可选；球队搜索                                                                            |
| `OPTA_JSON_MATCHES_KEY`                                                       | 可选；点号路径，指向响应中的比赛数组                                                      |
| `OPTA_PATH_MATCH_STATS` / `OPTA_PATH_MATCH_INJURIES` / `OPTA_PATH_MATCH_ODDS` | 可选；支持 `{matchId}` 模板                                                               |

英文完整说明见 **`SKILL.md`** 中 **Opta / Stats Perform** 小节。

---

## 合规与风险提示（摘要）

- **博彩**：仅可在合法前提下讨论「假设性」角度，不得引导违法投注。
- **非投资建议**：赔率与数据不保证未来结果。
- **配额**：一次运行可能对单场比赛发起多次子请求（尤其统计/详情）；免费档注意限额，可适当减小 `--last`。
- **密钥**：勿在对话中泄露；用环境变量或 `skills.entries.*.env`。

更完整的 Agent 行为、分析维度与输出结构见 **`SKILL.md`**。

---

## 相关链接

- OpenClaw Skills 配置：<https://docs.openclaw.ai/tools/skills-config>
- API-Football：<https://www.api-football.com/>
- Sportmonks：<https://my.sportmonks.com/>
- 纳米数据：<https://www.nami.com/zh>
- 纳米足球资料库接口说明：<https://www.nami.com/zh/details/7j8gxi0to7inrql#interface>
- Stats Perform（Opta 数据常见交付方）：<https://www.statsperform.com/>

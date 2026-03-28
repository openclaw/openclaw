# 足球比赛实时解说词（Opta / 纳米事件）技能

把 **原子事件流**（Opta 风格或 **纳米「足球实时数据」**）转成 **`commentaryPack`**：先做 **重要性分级** 与 **合并**，再交给大模型写解说，避免把整包事件直接塞进上下文。

## 脚本入口

| 脚本                                                         | 说明                                                                                                                       |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `skills/football-live-commentary/scripts/opta-live-pack.mjs` | 通用 JSON/NDJSON（偏英文字段）                                                                                             |
| `skills/football-live-commentary/scripts/nami-live-pack.mjs` | **纳米**：先规范化字段，再走同一套分级逻辑；接口说明见 [足球实时数据 API](https://www.nami.com/zh/details/j3ry6iztqltnwe0) |

**纳米拉流（可选）：** 配置 `NAMI_USER`、`NAMI_SECRET` 后使用 `--fetch --match-id <id>`；路径与查询参数用 `NAMI_PATH_LIVE_EVENTS`、`NAMI_PARAM_LIVE_MATCH_ID`、`NAMI_LIVE_EXTRA` 与合同对齐（默认路径仅为占位，务必按文档修改）。

## 四个维度（与 SKILL 一致）

1. **重要性分级**
   - 高：进球、红黄牌、点球、换人、VAR → 立即解说（`immediate`）。
   - 中：射正、门框、连续传球 ≥15（可调）、禁区附近关键动作 → 延时合并（`deferredWindows`）。
   - 低：常规传球、界外球等 → 默认略过；仅在短时间大量堆积时合并成一句「场面节奏」。

2. **上下文记忆**  
   `matchContext` 提供比分、领先/落后、比赛阶段（开场/尾声/补时等）与 **时间敏感度** 提示（同样犯规，开场与补时语气不同）。

3. **人格**  
   `--persona data|passion|poetic|neutral`，别名：`zhanjun`→数据流，`huang`/`huangjianxiang`→激情流，`hewei`→诗人流。

4. **省 Token**  
   模型侧只消费 **`commentaryPack`**，不要复读原始事件数组。

## 示例

```bash
node skills/football-live-commentary/scripts/opta-live-pack.mjs \
  --file skills/football-live-commentary/scripts/examples/sample-opta-events.json \
  --persona data \
  --home-name "主队" \
  --away-name "客队"
```

## OpenClaw

可将脚本与密钥放在宿主机，通过 `skills.entries.football_live_commentary.env` 注入环境变量（若后续接 HTTP 拉流，与 `football-match-analyst` 共用 Opta 合同变量思路一致）。详见 [Skills 配置](https://docs.openclaw.ai/tools/skills-config)。

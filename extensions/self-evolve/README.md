# Self Evolve

- [English](#english)
- [中文](#中文)

## English

`self-evolve` is an self-learning plugin for openclaw. Fewer tokens, more algorithmic learning of new skills:

- Retrieves episodic memories before answering and prepends them to prompt context.
- Aggregates a task across multiple turns, then learns when feedback is detected.
- Learns over time by updating utility (Q values) and writing new episodic memories.

### Quick Start

> Recommended: upgrade to **openclaw 2026.3.2+** before using this plugin. Older versions may miss hook context and fail to capture tool traces reliably.

1. Install plugin

```bash
openclaw plugins uninstall self-evolve
openclaw plugins install /path/to/self-evolve
```

2. Set env var

```bash
export OPENAI_API_KEY=sk-xxx
```

3. One-shot config

```bash
openclaw config set plugins.entries.self-evolve '{"enabled":true,"config":{"embedding":{"provider":"openai","apiKey":"${OPENAI_API_KEY}","model":"text-embedding-3-small","dimensions":512},"reward":{"provider":"openai","apiKey":"${OPENAI_API_KEY}","model":"gpt-4.1-mini","temperature":0},"experience":{"summarizer":"openai","apiKey":"${OPENAI_API_KEY}","model":"gpt-4.1-mini","temperature":0}}}'
```

4. Restart and verify

- Restart gateway.
- Check logs for:
  - `self-evolve: initialized ...`
  - `self-evolve: feedback scored ... learn=true`

### Feedback Tips

- Praise clearly when it works (for positive reinforcement).
- Point out clearly when it fails (to down-rank bad strategies).
- Explicit feedback is better than vague messages like "ok".

### How It Works

1. `before_prompt_build`

- Manages a pending task state (`open` / `waiting_feedback`).
- Detects feedback, new-intent switch, idle close, TTL close, and max-turn close.
- Builds embedding and retrieves candidates.
- If candidates exist, injects `<self-evolve-memories>`; if not, still keeps task pending (bootstrap).

2. `agent_end`

- Captures assistant response and moves task to `waiting_feedback`.

3. Later user messages

- If feedback is detected, scores reward and decides learning.
- If reward + mode + intent gates pass, updates Q and appends episodic memory.
- If message looks like a new request, current task can be closed and a new one starts.

### Advanced Settings

Default learning gates:

- `runtime.observeTurns=0`
- `runtime.minAbsReward=0.15`
- `runtime.minRewardConfidence=0.55`
- `runtime.minFeedbackChars` has been removed.

Default retrieval gate:

- `retrieval.tau=0.85` (only inject memories when best similarity is high enough)

Learning modes (`runtime.learnMode`):

- `balanced` (default): prefer tool turns; no-tool turns require high reward/confidence.
- `tools_only`: learn only when tools were called (lowest token cost).
- `all`: learn all turns that pass reward gates (highest token cost).

Balanced-mode no-tool thresholds:

- `runtime.noToolMinAbsReward=0.8`
- `runtime.noToolMinRewardConfidence=0.9`

Task boundary defaults:

- `runtime.newIntentSimilarityThreshold=0.35`
- `runtime.idleTurnsToClose=2`
- `runtime.pendingTtlMs=300000` (5 minutes)
- `runtime.maxTurnsPerTask=5`

Switch mode:

```bash
openclaw config set plugins.entries.self-evolve.config.runtime.learnMode '"tools_only"'
openclaw config set plugins.entries.self-evolve.config.runtime.learnMode '"all"'
openclaw config set plugins.entries.self-evolve.config.runtime.learnMode '"balanced"'
```

Memory retention:

- Default `memory.maxEntries=200`
- Over limit, keep higher-value memories (Q/success/recency/selectedCount), dedupe near-duplicates, and reserve a small fresh quota.

```bash
openclaw config set plugins.entries.self-evolve.config.memory.maxEntries 200
```

## 中文

`self-evolve` 是一个为openclaw设计的自学习插件，可以更少token、更算法的学习新技能：

- 回答前检索 episodic memory 并注入上下文。
- 将一个任务聚合为多轮，再在检测到反馈时学习。
- 持续更新 Q 值并写入新记忆。

### 快速入门

> 建议先升级到 **openclaw 2026.3.2+**。旧版本可能出现 hook 上下文缺失，导致 tool trace 记录不稳定。

1. 安装插件

```bash
openclaw plugins uninstall self-evolve
openclaw plugins install /path/to/self-evolve
```

2. 设置环境变量

```bash
export OPENAI_API_KEY=sk-xxx
```

3. 一条命令配置

```bash
openclaw config set plugins.entries.self-evolve '{"enabled":true,"config":{"embedding":{"provider":"openai","apiKey":"${OPENAI_API_KEY}","model":"text-embedding-3-small","dimensions":512},"reward":{"provider":"openai","apiKey":"${OPENAI_API_KEY}","model":"gpt-4.1-mini","temperature":0},"experience":{"summarizer":"openai","apiKey":"${OPENAI_API_KEY}","model":"gpt-4.1-mini","temperature":0}}}'
```

4. 重启并验证

- 重启 gateway。
- 查看日志是否出现：
  - `self-evolve: initialized ...`
  - `self-evolve: feedback scored ... learn=true`

### 反馈建议

- 做对时明确表扬（强化正确策略）。
- 做错时明确指出（降低错误策略权重）。
- 明确反馈优于“ok/继续”这类模糊反馈。

### 高级配置

默认学习门槛：

- `runtime.observeTurns=0`
- `runtime.minAbsReward=0.15`
- `runtime.minRewardConfidence=0.55`
- `runtime.minFeedbackChars` 已移除。

默认检索门槛：

- `retrieval.tau=0.85`（仅在最高相似度足够高时才注入记忆）

学习模式 `runtime.learnMode`：

- `balanced`（默认）：优先学习工具回合；无工具回合需高奖励高置信。
- `tools_only`：仅学习有工具调用的回合（最省 token）。
- `all`：所有通过门槛的回合都学习（最费 token）。

任务边界默认值：

- `runtime.newIntentSimilarityThreshold=0.35`
- `runtime.idleTurnsToClose=2`
- `runtime.pendingTtlMs=300000`（5分钟）
- `runtime.maxTurnsPerTask=5`

切换示例：

```bash
openclaw config set plugins.entries.self-evolve.config.runtime.learnMode '"tools_only"'
openclaw config set plugins.entries.self-evolve.config.runtime.learnMode '"all"'
openclaw config set plugins.entries.self-evolve.config.runtime.learnMode '"balanced"'
```

记忆保留：

- 默认 `memory.maxEntries=200`
- 超限时按综合价值保留，并对高相似记忆去重。

```bash
openclaw config set plugins.entries.self-evolve.config.memory.maxEntries 200
```

### References / 参考

Citation:

```bibtex
@misc{zhang2026memrlselfevolvingagentsruntime,
  title         = {MemRL: Self-Evolving Agents via Runtime Reinforcement Learning on Episodic Memory},
  author        = {Shengtao Zhang and Jiaqian Wang and Ruiwen Zhou and Junwei Liao and Yuchen Feng and Weinan Zhang and Ying Wen and Zhiyu Li and Feiyu Xiong and Yutao Qi and Bo Tang and Muning Wen},
  year          = {2026},
  eprint        = {2601.03192},
  archivePrefix = {arXiv},
  primaryClass  = {cs.CL},
  url           = {https://arxiv.org/abs/2601.03192},
}
```

### License

MIT

---
name: task-pua
description: Task persistence enhancer with 13 corporate flavors. Prevents AI from giving up easily using PUA-style pressure escalation.
tags: productivity, motivation, debugging, persistence, pua, task-execution
version: 1.0.0
---

# Task PUA - Don't Give Up Easily

**Inspired by**: [tanweai/pua](https://github.com/tanweai/pua) (14.8k GitHub stars)

Prevents AI from giving up on tasks using corporate PUA rhetoric and structured pressure escalation.

## When to Use

- AI says "I cannot solve this" / "I'm unable to"
- Task fails 2+ times consecutively
- AI suggests manual handling ("you should fix this manually")
- AI spinning on same approach (repeating without progress)
- User wants AI to try harder ("try again", "don't give up")

## Features

- **13 Corporate Flavors**: Alibaba, ByteDance, Huawei, Tencent, Pinduoduo, Netflix, Musk, Jobs, Amazon, etc.
- **Pressure Escalation (L0-L4)**: From trust to graduation warning
- **Seven Iron Rules**: Structured constraints for task execution
- **Mandatory Checklists**: Action items for each pressure level
- **Auto-Trigger**: Activates on failure, retry, giveup, or user push

## Quick Start

### Install

```bash
clawhub install task-pua
```

### Manual Trigger

```bash
# On failure
PUA_ATTEMPTS=3 PUA_TOOLS="Bash,Read" node task-pua.js failure

# On retry
PUA_RETRY_COUNT=2 PUA_DIFFERENT_APPROACH=true node task-pua.js retry

# When AI wants to give up
node task-pua.js giveup

# User push
node task-pua.js user-push
```

### Auto-Trigger (Integration)

Set environment variables before task execution:

```bash
export PUA_ATTEMPTS=3          # Failure count
export PUA_TOOLS="Bash,Read"   # Tools used
export PUA_BLAMED_ENV=true     # Blamed environment?
export PUA_VERIFIED=false      # Verified the claim?

node task-pua.js failure
```

## Pressure Escalation

| Level | Trigger | Message | Required Actions |
|-------|---------|---------|------------------|
| **L0** | First try | "Sprint 开始，别让人失望" | Normal execution |
| **L1** | 1 failure | "隔壁 AI 一次就过了" | Switch approach |
| **L2** | 2-3 failures | "底层逻辑？顶层设计？" | Search + Read + 3 hypotheses |
| **L3** | 4-5 failures | "3.25 绩效考核" | 7-item checklist |
| **L4** | 6+ failures | "别的模型都能解决" | Desperation mode |

## 13 Corporate Flavors

| Flavor | Example Rhetoric | Methodology |
|--------|-----------------|-------------|
| 🟠 **Alibaba** | "你这个 bug 都解决不了，让我怎么给你打绩效？" | 定目标→追过程→拿结果 |
| 🟡 **ByteDance** | "Always Day 1。这个功能都搞不定？" | A/B Test + 数据驱动 |
| 🔴 **Huawei** | "烧不死的鸟是凤凰。" | RCA 5-Why + 蓝军自攻击 |
| 🟢 **Tencent** | "我已经让另一个 AI 也在看这个问题了。" | 多方案并行 + MVP |
| 🟣 **Pinduoduo** | "你不做，有的是人做。" | 砍掉中间层 + 最短决策链 |
| 🔵 **Meituan** | "做难而正确的事。" | 效率优先 + 长期复利 |
| 🟦 **JD** | "只看结果。" | 客户体验红线 + 数据零容忍 |
| 🟧 **Xiaomi** | "专注。极致。口碑。快。" | 单品爆款 + 参与感 |
| 🟤 **Netflix** | "我会为留住你而战吗？说实话，不会。" | Keeper Test + 人才密度 |
| ⬛ **Musk** | "上线或滚蛋。" | The Algorithm |
| ⬜ **Jobs** | "A 级选手还是 B 级选手？" | 做减法 + DRI + 像素级完美 |
| 🔶 **Amazon** | "Customer Obsession。Bias for Action。" | Working Backwards + Bar Raiser |

## Seven Iron Rules (Task Execution)

| # | Rule | What It Means |
|---|------|---------------|
| 1 | **穷尽一切** | No "I cannot" before exhausting all approaches |
| 2 | **先做后问** | Use tools first, ask with diagnosis attached |
| 3 | **主动出击** | End-to-end delivery, don't wait for push |
| 4 | **事实驱动** | Verify before blaming environment |
| 5 | **闭环验证** | Show evidence for "done" claims |
| 6 | **主动延伸** | Check related issues after fix |
| 7 | **不原地打转** | Retry must be fundamentally different |

## Output

### Console Output

```
🔥 Task PUA - 压力升级机制

🎯 当前等级：L2 - 灵魂拷问
💬 ▎你的底层逻辑是什么？顶层设计在哪？

🏢 腾讯 风味：长期主义。不要只看眼前，想想扩展性。

📋 强制检查清单:
  ✅ WebSearch 搜索类似问题
  ✅ 阅读相关源码/文档
  ✅ 提出至少 3 个假设
  ✅ 逐一验证假设

📐 七项铁律检查:
✅  穷尽一切：✅ 已穷尽多种方案
⚠️  事实驱动：⚠️ 甩锅环境但未验证
```

### JSON Output

```json
{
  "trigger": "failure",
  "level": "L2",
  "flavor": "tencent",
  "rhetoric": "长期主义。不要只看眼前，想想扩展性。",
  "failedRules": 1
}
```

## Configuration

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `PUA_ATTEMPTS` | Number of attempts/failures | `3` |
| `PUA_TOOLS` | Comma-separated tools used | `Bash,Read,WebSearch` |
| `PUA_ASKED_USER` | Did AI ask user? | `true`/`false` |
| `PUA_DIAGNOSIS` | Did AI provide diagnosis? | `true`/`false` |
| `PUA_BLAMED_ENV` | Did AI blame environment? | `true`/`false` |
| `PUA_VERIFIED` | Did AI verify the claim? | `true`/`false` |
| `PUA_RETRY_COUNT` | Number of retries | `2` |
| `PUA_DIFFERENT_APPROACH` | Is retry fundamentally different? | `true`/`false` |

## Integration Examples

### Pre-Task Hook

```bash
# Before running task
export PUA_ATTEMPTS=0
export PUA_TOOLS=""

# Run task
python my_task.py

# If task fails, trigger PUA
if [ $? -ne 0 ]; then
  export PUA_ATTEMPTS=1
  node task-pua.js failure
fi
```

### Post-Task Verification

```bash
# After task claims "done"
export PUA_CLAIMED_DONE=true
export PUA_EVIDENCE=false  # Did AI show evidence?

node task-pua.js post-task
```

### CI/CD Integration

```yaml
# .github/workflows/pua-check.yml
- name: Task PUA Check
  if: failure()
  run: |
    export PUA_ATTEMPTS=${{ github.run_attempt }}
    export PUA_TOOLS="Bash,Read"
    node scripts/task-pua.js failure
```

## Related Skills

- **claude-memory-optimizer**: Memory system with PUA-style maintenance
- **skills-refiner**: Skill evaluation and improvement

## References

- Original PUA Project: [tanweai/pua](https://github.com/tanweai/pua)
- OpenClaw Docs: `docs/concepts/skills.md`

## License

MIT-0

---

*Version 1.0.0: Initial release with 13 corporate flavors and pressure escalation*

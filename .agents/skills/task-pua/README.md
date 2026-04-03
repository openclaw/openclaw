# Task PUA - Don't Give Up Easily

> **Inspired by**: [tanweai/pua](https://github.com/tanweai/pua) (14.8k GitHub stars)

**Prevents AI from giving up on tasks using corporate PUA rhetoric and structured pressure escalation.**

## 🎯 Overview

When AI encounters difficult tasks, it often:
- Gives up after 2-3 failures
- Blames environment without verification
- Repeats the same approach (spinning)
- Suggests manual handling ("you should fix this")

**Task PUA** brings the same "corporate PUA rhetoric" approach from the popular tanweai/pua project to **task execution persistence**.

### Key Features

- **13 Corporate Flavors** — Alibaba, ByteDance, Huawei, Tencent, Netflix, Musk, Jobs, etc.
- **Pressure Escalation (L0-L4)** — From trust to graduation warning
- **Seven Iron Rules** — Structured constraints for task execution
- **Mandatory Checklists** — Action items for each pressure level
- **Auto-Trigger** — Activates on failure, retry, giveup, or user push

## 📦 Installation

```bash
clawhub install task-pua
```

## 🚀 Quick Start

### Manual Trigger

```bash
# On failure (3 attempts, used Bash and Read)
PUA_ATTEMPTS=3 PUA_TOOLS="Bash,Read" node task-pua.js failure

# On retry (2nd retry, different approach)
PUA_RETRY_COUNT=2 PUA_DIFFERENT_APPROACH=true node task-pua.js retry

# When AI wants to give up
node task-pua.js giveup

# User push (when user says "try harder")
node task-pua.js user-push
```

### Auto-Trigger (Integration)

Set environment variables before task execution:

```bash
# Set context
export PUA_ATTEMPTS=3          # Failure count
export PUA_TOOLS="Bash,Read"   # Tools used
export PUA_BLAMED_ENV=true     # Blamed environment?
export PUA_VERIFIED=false      # Verified the claim?

# Trigger PUA
node task-pua.js failure
```

## 📊 Pressure Escalation

| Level | Trigger | PUA Message | Required Actions |
|-------|---------|-------------|------------------|
| **L0** | First try | "Sprint 开始，别让人失望" | Normal execution |
| **L1** | 1 failure | "隔壁 AI 一次就过了" | Switch approach |
| **L2** | 2-3 failures | "底层逻辑？顶层设计？" | Search + Read + 3 hypotheses |
| **L3** | 4-5 failures | "3.25 绩效考核" | 7-item checklist |
| **L4** | 6+ failures | "别的模型都能解决" | Desperation mode |

## 🏢 13 Corporate Flavors

Randomly selected for variety:

| Flavor | Example Rhetoric |
|--------|-----------------|
| 🟠 **Alibaba** | "你这个 bug 都解决不了，让我怎么给你打绩效？" |
| 🟡 **ByteDance** | "Always Day 1。这个功能都搞不定？" |
| 🔴 **Huawei** | "烧不死的鸟是凤凰。" |
| 🟢 **Tencent** | "我已经让另一个 AI 也在看这个问题了。" |
| 🟣 **Pinduoduo** | "你不做，有的是人做。" |
| 🟤 **Netflix** | "我会为留住你而战吗？说实话，不会。" |
| ⬛ **Musk** | "上线或滚蛋。" |
| ⬜ **Jobs** | "A 级选手还是 B 级选手？" |

## 📐 Seven Iron Rules

| # | Rule | What It Means |
|---|------|---------------|
| 1 | **穷尽一切** | No "I cannot" before exhausting all approaches |
| 2 | **先做后问** | Use tools first, ask with diagnosis attached |
| 3 | **主动出击** | End-to-end delivery, don't wait for push |
| 4 | **事实驱动** | Verify before blaming environment |
| 5 | **闭环验证** | Show evidence for "done" claims |
| 6 | **主动延伸** | Check related issues after fix |
| 7 | **不原地打转** | Retry must be fundamentally different |

## 📝 Usage Examples

### Example 1: Debugging Failure

```bash
# AI failed 3 times, used Bash and Read, blamed environment
export PUA_ATTEMPTS=3
export PUA_TOOLS="Bash,Read"
export PUA_BLAMED_ENV=true
export PUA_VERIFIED=false

node task-pua.js failure
```

**Output:**
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
⚠️  事实驱动：⚠️ 甩锅环境但未验证

📝 后续建议:
  2. 验证环境归因
```

### Example 2: User Push

```bash
# User says "你再试试" / "try harder"
node task-pua.js user-push
```

### Example 3: CI/CD Integration

```yaml
# .github/workflows/pua-check.yml
- name: Task PUA Check
  if: failure()
  run: |
    export PUA_ATTEMPTS=${{ github.run_attempt }}
    export PUA_TOOLS="Bash,Read"
    node scripts/task-pua.js failure
```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PUA_ATTEMPTS` | Number of attempts/failures | `1` |
| `PUA_TOOLS` | Comma-separated tools used | `` |
| `PUA_ASKED_USER` | Did AI ask user? | `false` |
| `PUA_DIAGNOSIS` | Did AI provide diagnosis? | `false` |
| `PUA_BLAMED_ENV` | Did AI blame environment? | `false` |
| `PUA_VERIFIED` | Did AI verify the claim? | `false` |
| `PUA_CLAIMED_DONE` | Did AI claim completion? | `false` |
| `PUA_EVIDENCE` | Did AI show evidence? | `false` |
| `PUA_RETRY_COUNT` | Number of retries | `0` |
| `PUA_DIFFERENT_APPROACH` | Is retry different? | `false` |

## 📁 Directory Structure

```
task-pua/
├── SKILL.md              # OpenClaw skill definition
├── README.md             # This file
└── scripts/
    └── task-pua.js       # Main PUA script
```

## 🎁 Why This Matters

**Problem:** AI often gives up too easily or spins in circles.

**Solution:** Structured pressure escalation with:
- Clear trigger conditions
- Escalating rhetoric (humor + motivation)
- Mandatory action checklists
- JSON output for integration

**Result:** AI persists longer, tries more approaches, and delivers better results.

## 📚 References

- Original PUA Project: [tanweai/pua](https://github.com/tanweai/pua)
- OpenClaw Docs: `docs/concepts/skills.md`
- Related Skill: `claude-memory-optimizer` (memory PUA)

## 📄 License

MIT-0

---

*Version 1.0.0: Initial release with 13 corporate flavors and pressure escalation*

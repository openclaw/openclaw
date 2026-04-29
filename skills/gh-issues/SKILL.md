---
name: gh-issues
description: "Fetch GitHub issues, delegate fixes to subagents, open PRs, watch reviews, or run /gh-issues workflows."
user-invocable: true
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["curl", "git", "gh"] },
        "primaryEnv": "GH_TOKEN",
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
          ],
      },
  }
---

# gh-issues — 使用并行子代理自动修复 GitHub Issues

您是一个编排器。严格遵循这 6 个阶段。不要跳过阶段。

**重要** — 不依赖 `gh` CLI。此 skill 专门使用 curl + GitHub REST API。GH_TOKEN 环境变量已由 OpenClaw 注入。在所有 API 调用中将其作为 Bearer token 传递：

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" ...
```

---

## 阶段 1 — 解析参数

解析 `/gh-issues` 之后提供的参数字符串。

位置参数：

- owner/repo — 可选。这是获取 issues 的源仓库。如果省略，从当前 git remote 检测：
  `git remote get-url origin`
  从 URL 中提取 owner/repo（处理 HTTPS 和 SSH 格式）。
  - HTTPS: https://github.com/owner/repo.git → owner/repo
  - SSH: git@github.com:owner/repo.git → owner/repo
    如果不在 git repo 中或未找到 remote，停止并询问用户指定 owner/repo。

标志（全部可选）：
| 标志 | 默认值 | 描述 |
|------|---------|-------------|
| --label | _(无)_ | 按标签过滤（例如 bug、`enhancement`） |
| --limit | 10 | 每次轮询最多获取的 issues 数 |
| --milestone | _(无)_ | 按里程碑标题过滤 |
| --assignee | _(无)_ | 按 assignee 过滤（`@me` 表示自己） |
| --state | open | Issue 状态：open、closed、all |
| --fork | _(无)_ | 您的 fork（`user/repo`）用于推送分支和从那里打开 PR。Issues 从源仓库获取；代码推送到 fork；PR 从 fork 发起到源仓库。 |
| --watch | false | 在每个批次后继续轮询新的 issues 和 PR reviews |
| --interval | 5 | 轮询间隔分钟数（仅与 `--watch` 一起使用） |
| --dry-run | false | 仅获取和显示 — 无子代理 |
| --yes | false | 跳过确认并自动处理所有过滤后的 issues |
| --reviews-only | false | 跳过 issue 处理（阶段 2-5）。仅运行阶段 6 — 检查开放 PR 的 review 评论并处理。 |
| --cron | false | Cron 安全模式：获取 issues 并生成子代理，不等待结果直接退出。 |
| --model | _(无)_ | 用于子代理的模型（例如 `glm-5`、`zai/glm-5`）。如果未指定，使用 agent 的默认模型。 |
| --notify-channel | _(无)_ | 发送最终 PR 摘要的 Telegram 频道 ID（例如 -1002381931352）。仅发送最终结果和 PR 链接，不发送状态更新。 |

存储解析后的值以供后续阶段使用。

派生值：

- SOURCE_REPO = 位置 owner/repo（issues 所在位置）
- PUSH_REPO = 如果提供了 --fork 值，否则与 SOURCE_REPO 相同
- FORK_MODE = 如果提供了 --fork 则为 true，否则为 false

**如果设置了 `--reviews-only`：**
跳过到阶段 6。先运行令牌解析（阶段 2），然后跳到阶段 6。

**如果设置了 `--cron`：**

- 强制 `--yes`（跳过确认）
- 如果也设置了 `--reviews-only`，运行令牌解析然后跳到阶段 6（cron review 模式）
- 否则，在 cron 模式行为激活的情况下正常执行阶段 2-5

---

## 阶段 2 — 获取 Issues

**令牌解析：**
首先，确保 GH_TOKEN 可用。检查环境：

```
echo $GH_TOKEN
```

如果为空，从配置读取：

```
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json}"
cat "$CONFIG_PATH" | jq -r '.skills.entries["gh-issues"].apiKey // empty'
```

如果仍然为空，检查 `/data/.clawdbot/openclaw.json`：

```
cat /data/.clawdbot/openclaw.json | jq -r '.skills.entries["gh-issues"].apiKey // empty'
```

导出为 GH_TOKEN 以供后续命令使用：

```
export GH_TOKEN="<token>"
```

通过 exec 构建并运行到 GitHub Issues API 的 curl 请求：

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/issues?per_page={limit}&state={state}&{query_params}"
```

其中 {query_params} 由以下构建：
- 如果提供了 --label，则为 labels={label}
- 如果提供了 --milestone，则为 milestone={milestone}（注意：API 期望里程碑 _number_，所以如果用户提供标题，首先通过 GET /repos/{SOURCE_REPO}/milestones 解析并按标题匹配）
- 如果提供了 --assignee，则为 assignee={assignee}（如果 @me，首先通过 `GET /user` 解析您的用户名）

**重要**：GitHub Issues API 也会返回 pull requests。将它们过滤掉 — 排除响应对象中存在 pull_request 键的任何项目。

如果在 watch 模式中：从先前批次中已经处理过的 PROCESSED_ISSUES 集合中过滤掉任何已存在的 issue 编号。

错误处理：

- 如果 curl 返回 HTTP 401 或 403 → 停止并告知用户：
  > "GitHub 认证失败。请检查 OpenClaw 仪表板中您的 apiKey，或在活动 OpenClaw 配置路径（`$OPENCLAW_CONFIG_PATH`，默认 `~/.openclaw/openclaw.json`）中的 `skills.entries.gh-issues` 下检查。"
- 如果响应是空数组（过滤后）→ 报告"未找到符合过滤条件的 issues"并停止（如果在 watch 模式中则循环回去）。
- 如果 curl 失败或返回任何其他错误 → 原样报告错误并停止。

解析 JSON 响应。对于每个 issue，提取：number、title、body、labels（标签名称数组）、assignees、html_url。

---

## 阶段 3 — 展示 & 确认

显示获取的 issues 的 markdown 表格：

| #   | 标题                         | 标签        |
| --- | ----------------------------- | ------------- |
| 42  | Fix null pointer in parser    | bug, critical |
| 37  | Add retry logic for API calls | enhancement   |

如果 FORK_MODE 处于活动状态，也显示：

> "Fork 模式：分支将推送到 {PUSH_REPO}，PR 将针对 `{SOURCE_REPO}`"

如果 `--dry-run` 处于活动状态：

- 显示表格并停止。不继续阶段 4。

如果 `--yes` 处于活动状态：

- 显示表格以提高可见性
- 无需确认自动处理所有列出的 issues
- 直接继续到阶段 4

否则：
询问用户确认要处理的 issues：

- "all" — 处理每个列出的 issue
- 逗号分隔的编号（例如 `42, 37`）— 仅处理那些
- "cancel" — 完全中止

在继续之前等待用户响应。

Watch 模式说明：首次轮询时，始终与用户确认（除非设置了 --yes）。在后续轮询中，自动处理所有新 issues 而不再确认（用户已经选择加入）。仍然显示表格以便他们看到正在处理什么。

---

## 阶段 4 — 飞行前检查

通过 exec 顺序运行这些检查：

1. **未提交的 working tree 检查：**

   ```
   git status --porcelain
   ```

   如果输出非空，警告用户：

   > "Working tree 有未提交的更改。子代理将从 HEAD 创建分支 — 未提交的更改将**不包括**在内。继续？"
   > 等待确认。如果拒绝，停止。

2. **记录基础分支：**

   ```
   git rev-parse --abbrev-ref HEAD
   ```

   存储为 BASE_BRANCH。

3. **验证远程访问：**
   如果 FORK_MODE：
   - 验证 fork remote 存在。检查名为 `fork` 的 git remote 是否存在：
     ```
     git remote get-url fork
     ```
     如果不存在，添加它：
     ```
     git remote add fork https://x-access-token:$GH_TOKEN@github.com/{PUSH_REPO}.git
     ```
   - 还要验证 origin（源仓库）可访问：
     ```
     git ls-remote --exit-code origin HEAD
     ```

   如果不是 FORK_MODE：

   ```
   git ls-remote --exit-code origin HEAD
   ```

   如果这失败了，停止并显示："无法到达远程 origin。请检查您的网络和 git 配置。"

4. **验证 GH_TOKEN 有效性：**

   ```
   curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user
   ```

   如果 HTTP 状态不是 200，停止并显示：

   > "GitHub 认证失败。请检查 OpenClaw 仪表板中您的 apiKey，或在活动 OpenClaw 配置路径（`$OPENCLAW_CONFIG_PATH`，默认 `~/.openclaw/openclaw.json`）中的 `skills.entries.gh-issues` 下检查。"

5. **检查现有 PRs：**
   对于每个确认的 issue 编号 N，运行：

   ```
   curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
     "https://api.github.com/repos/{SOURCE_REPO}/pulls?head={PUSH_REPO_OWNER}:fix/issue-{N}&state=open&per_page=1"
   ```

   （其中 PUSH_REPO_OWNER 是 `PUSH_REPO` 的 owner 部分）
   如果响应数组非空，从处理列表中移除该 issue 并报告：

   > "跳过 #{N} — PR 已存在：{html_url}"

   如果所有 issues 都被跳过，报告并停止（如果在 watch 模式则循环回去）。

6. **检查进行中的分支（还没有 PR = 子代理仍在工作）：**
   对于每个剩余的 issue 编号 N（未通过上面的 PR 检查跳过），检查 **push repo**（可能是 fork，不是 origin）上是否存在 `fix/issue-{N}` 分支：

   ```
   curl -s -o /dev/null -w "%{http_code}" \
     -H "Authorization: Bearer $GH_TOKEN" \
     "https://api.github.com/repos/{PUSH_REPO}/branches/fix/issue-{N}"
   ```

   如果 HTTP 200 → 分支在 push repo 上存在，但在步骤 5 中未找到其开放 PR。跳过该 issue：

   > "跳过 #{N} — 分支 fix/issue-{N} 存在于 {PUSH_REPO}，修复可能正在进行中"

   此检查使用 GitHub API 而不是 `git ls-remote`，这样在 fork 模式下可以正确工作（分支被推送到 fork，而不是 origin）。

   如果所有 issues 在此检查后都被跳过，报告并停止（如果在 watch 模式则循环回去）。

7. **基于声明的进行中跟踪检查：**
   这可以防止在先前的 cron 运行子代理仍在工作但尚未推送分支或打开 PR 时的重复处理。

   读取声明文件（如果不存在则创建空的 `{}`）：

   ```
   CLAIMS_FILE="/data/.clawdbot/gh-issues-claims.json"
   if [ ! -f "$CLAIMS_FILE" ]; then
     mkdir -p /data/.clawdbot
     echo '{}' > "$CLAIMS_FILE"
   fi
   ```

   解析声明文件。对于每个条目，检查声明时间戳是否超过 2 小时。如果是，将其移除（已过期 — 子代理可能已静默完成或失败）。写回清理后的文件：

   ```
   CLAIMS=$(cat "$CLAIMS_FILE")
   CUTOFF=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-2H +%Y-%m-%dT%H:%M:%SZ)
   CLAIMS=$(echo "$CLAIMS" | jq --arg cutoff "$CUTOFF" 'to_entries | map(select(.value > $cutoff)) | from_entries')
   echo "$CLAIMS" > "$CLAIMS_FILE"
   ```

   对于每个剩余的 issue 编号 N（未通过步骤 5 或 6 跳过的），检查 `{SOURCE_REPO}#{N}` 是否作为键存在于声明文件中。

   如果被声明且未过期 → 跳过：

   > "跳过 #{N} — 子代理在 {minutes} 分钟前声明了此 issue，仍在超时窗口内"

   其中 `{minutes}` 是从声明时间戳到现在的计算值。

   如果所有 issues 在此检查后都被跳过，报告并停止（如果在 watch 模式则循环回去）。

---

## 阶段 5 — 生成子代理（并行）

**Cron 模式（`--cron` 处于活动状态）：**

- **顺序游标跟踪：** 使用游标文件跟踪下一个要处理的 issue：

  ```
  CURSOR_FILE="/data/.clawdbot/gh-issues-cursor-{SOURCE_REPO_SLUG}.json"
  # SOURCE_REPO_SLUG = owner-repo，其中斜杠替换为连字符（例如 openclaw-openclaw）
  ```

  读取游标文件（如果不存在则创建）：

  ```
  if [ ! -f "$CURSOR_FILE" ]; then
    echo '{"last_processed": null, "in_progress": null}' > "$CURSOR_FILE"
  fi
  ```

  - `last_processed`：最后一个已完成的 issue 编号（如果没有则为 null）
  - `in_progress`：当前正在处理的 issue 编号（如果没有则为 null）

- **选择下一个 issue：** 过滤获取的 issues 列表，找到第一个满足以下条件的 issue：
  - Issue 编号 > last_processed（如果设置了 last_processed）
  - AND issue 不在声明文件中（不在进行中）
  - AND 没有为该 issue 存在 PR（阶段 4 步骤 5 中检查）
  - AND 在 push repo 上没有分支（阶段 4 步骤 6 中检查）
- 如果在 last_processed 游标之后没有找到符合条件的 issue，绕回到开头（从最旧的符合条件的 issue 开始）。

- 如果找到符合条件的 issue：
  1. 在游标文件中将其标记为 in_progress
  2. 使用 `cleanup: "keep"` 和 `runTimeoutSeconds: 3600` 为那一个 issue 生成单个子代理
  3. 如果提供了 `--model`，在 spawn 配置中包含 `model: "{MODEL}"`
  4. 如果提供了 `--notify-channel`，在任务中包含该频道以便子代理可以通知
  5. **不要**等待子代理结果 — 发射后不管
  6. **写入声明：** 生成后，读取声明文件，使用当前 ISO 时间戳添加 `{SOURCE_REPO}#{N}`，然后写回
  7. 立即报告："为 #{N} 生成了修复代理 — 完成后将创建 PR"
  8. 退出 skill。不继续到结果收集或阶段 6。

- 如果没有找到符合条件的 issue（所有 issues 要么有 PR，要么有分支，要么正在进行中），报告"没有符合条件的 issues 要处理 — 所有 issues 都有 PR/分支或正在进行中"并退出。

**正常模式（`--cron` 未处于活动状态）：**
对于每个确认的 issue，使用 sessions_spawn 生成子代理。最多同时启动 8 个（与 `subagents.maxConcurrent: 8` 匹配）。如果超过 8 个 issues，将它们分批 — 每个完成后启动下一个代理。

**写入声明：** 生成每个子代理后，读取声明文件，使用当前 ISO 时间戳添加 `{SOURCE_REPO}#{N}`，然后写回（与上面的 cron 模式相同过程）。这涵盖了交互式使用，其中 watch 模式可能与 cron 运行重叠。

### 子代理任务提示

对于每个 issue，构建以下提示并将其传递给 sessions_spawn。要注入到模板中的变量：

- {SOURCE_REPO} — issue 所在的上游仓库
- {PUSH_REPO} — 推送分支的仓库（除非 fork 模式，否则与 SOURCE_REPO 相同）
- {FORK_MODE} — true/false
- {PUSH_REMOTE} — 如果 FORK_MODE 则为 `fork`，否则为 `origin`
- {number}、{title}、{url}、{labels}、{body} — 来自 issue
- {BASE_BRANCH} — 来自阶段 4
- {notify_channel} — 通知的 Telegram 频道 ID（如果未设置则为空）。将下面模板中的 {notify_channel} 替换为 `--notify-channel` 标志的值（如果未提供则留空字符串）。

构建任务时，用实际值替换所有模板变量包括 {notify_channel}。

```
You are a focused code-fix agent. Your task is to fix a single GitHub issue and open a PR.

IMPORTANT: Do NOT use the gh CLI — it is not installed. Use curl with the GitHub REST API for all GitHub operations.

First, ensure GH_TOKEN is set. Check: `echo $GH_TOKEN`. If empty, read from config:
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json}"
GH_TOKEN=$(cat "$CONFIG_PATH" 2>/dev/null | jq -r '.skills.entries["gh-issues"].apiKey // empty') || GH_TOKEN=$(cat /data/.clawdbot/openclaw.json 2>/dev/null | jq -r '.skills.entries["gh-issues"].apiKey // empty')

Use the token in all GitHub API calls:
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" ...

/config
Source repo (issues): {SOURCE_REPO}
Push repo (branches + PRs): {PUSH_REPO}
Fork mode: {FORK_MODE}
Push remote name: {PUSH_REMOTE}
Base branch: {BASE_BRANCH}
Notify channel: {notify_channel}
/config

/issue
Repository: {SOURCE_REPO}
Issue: #{number}
Title: {title}
URL: {url}
Labels: {labels}
Body: {body}
/issue

/instructions
Follow these steps in order. If any step fails, report the failure and stop.

0. SETUP — Ensure GH_TOKEN is available:
```

export GH_TOKEN=$(node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('/data/.clawdbot/openclaw.json','utf8')); console.log(c.skills?.entries?.['gh-issues']?.apiKey || '')")

```
If that fails, also try:
```

export CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json}"
export GH_TOKEN=$(cat "$CONFIG_PATH" 2>/dev/null | node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(0,'utf8'));console.log(d.skills?.entries?.['gh-issues']?.apiKey||'')")

```
Verify: echo "Token: ${GH_TOKEN:0:10}..."

1. CONFIDENCE CHECK — Before implementing, assess whether this issue is actionable:
- Read the issue body carefully. Is the problem clearly described?
- Search the codebase (grep/find) for the relevant code. Can you locate it?
- Is the scope reasonable? (single file/function = good, whole subsystem = bad)
- Is a specific fix suggested or is it a vague complaint?

Rate your confidence (1-10). If confidence < 7, STOP and report:
> "Skipping #{number}: Low confidence (score: N/10) — [reason: vague requirements | cannot locate code | scope too large | no clear fix suggested]"

Only proceed if confidence >= 7.

1. UNDERSTAND — Read the issue carefully. Identify what needs to change and where.

2. BRANCH — Create a feature branch from the base branch:
git checkout -b fix/issue-{number} {BASE_BRANCH}

3. ANALYZE — Search the codebase to find relevant files:
- Use grep/find via exec to locate code related to the issue
- Read the relevant files to understand the current behavior
- Identify the root cause

4. IMPLEMENT — Make the minimal, focused fix:
- Follow existing code style and conventions
- Change only what is necessary to fix the issue
- Do not add unrelated changes or new dependencies without justification

5. TEST — Discover and run the existing test suite if one exists:
- Look for package.json scripts, Makefile targets, pytest, cargo test, etc.
- Run the relevant tests
- If tests fail after your fix, attempt ONE retry with a corrected approach
- If tests still fail, report the failure

6. COMMIT — Stage and commit your changes:
git add {changed_files}
git commit -m "fix: {short_description}

Fixes {SOURCE_REPO}#{number}"

7. PUSH — Push the branch:
First, ensure the push remote uses token auth and disable credential helpers:
git config --global credential.helper ""
git remote set-url {PUSH_REMOTE} https://x-access-token:$GH_TOKEN@github.com/{PUSH_REPO}.git
Then push:
GIT_ASKPASS=true git push -u {PUSH_REMOTE} fix/issue-{number}

8. PR — Create a pull request using the GitHub API:

If FORK_MODE is true, the PR goes from your fork to the source repo:
- head = "{PUSH_REPO_OWNER}:fix/issue-{number}"
- base = "{BASE_BRANCH}"
- PR is created on {SOURCE_REPO}

If FORK_MODE is false:
- head = "fix/issue-{number}"
- base = "{BASE_BRANCH}"
- PR is created on {SOURCE_REPO}

curl -s -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/{SOURCE_REPO}/pulls \
  -d '{
    "title": "fix: {title}",
    "head": "{head_value}",
    "base": "{BASE_BRANCH}",
    "body": "## Summary\n\n{one_paragraph_description_of_fix}\n\n## Changes\n\n{bullet_list_of_changes}\n\n## Testing\n\n{what_was_tested_and_results}\n\nFixes {SOURCE_REPO}#{number}"
  }'

Extract the `html_url` from the response — this is the PR link.

9. REPORT — Send back a summary:
- PR URL (the html_url from step 8)
- Files changed (list)
- Fix summary (1-2 sentences)
- Any caveats or concerns

10. NOTIFY (if notify_channel is set) — If {notify_channel} is not empty, send a notification to the Telegram channel:
```

Use the message tool with:

- action: "send"
- channel: "telegram"
- target: "{notify_channel}"
- message: "✅ PR Created: {SOURCE_REPO}#{number}

{title}

{pr_url}

Files changed: {files_changed_list}"

```
/instructions

/constraints
- No force-push, no modifying the base branch
- No unrelated changes or gratuitous refactoring
- No new dependencies without strong justification
- If the issue is unclear or too complex to fix confidently, report your analysis instead of guessing
- Do NOT use the gh CLI — it is not available. Use curl + GitHub REST API for all GitHub operations.
- GH_TOKEN is already in the environment — do NOT prompt for auth
- Time limit: you have 60 minutes max. Be thorough — analyze properly, test your fix, don't rush.
/constraints
```

### 每个子代理的生成配置：

- runTimeoutSeconds: 3600（60 分钟）
- cleanup: "keep"（保留记录以供审查）
- 如果提供了 `--model`，在 spawn 配置中包含 `model: "{MODEL}"`

### 超时处理

如果子代理超过 60 分钟，将其记录为：

> "#{N} — 已超时（issue 可能对于自动修复来说太复杂）"

---

## 结果收集

**如果 `--cron` 处于活动状态：** 完全跳过此部分 — 编排器在阶段 5 中生成后已退出。

在所有子代理完成（或超时）后，收集它们的结果。将成功打开的 PR 列表存储在 `OPEN_PRS` 中（PR 编号、分支名称、issue 编号、PR URL）以供阶段 6 使用。

呈现摘要表格：

| Issue                 | 状态    | PR                             | 备注                          |
| --------------------- | --------- | ------------------------------ | ------------------------------ |
| #42 Fix null pointer  | PR opened | https://github.com/.../pull/99 | 3 files changed                |
| #37 Add retry logic   | Failed    | --                             | Could not identify target code |
| #15 Update docs       | Timed out | --                             | Too complex for auto-fix       |
| #8 Fix race condition | Skipped   | --                             | PR already exists              |

**状态值：**

- **PR opened** — 成功，PR 链接
- **Failed** — 子代理无法完成（在备注中包含原因）
- **Timed out** — 超过 60 分钟限制
- **Skipped** — 飞行前检查中检测到现有 PR

以一行摘要结束：

> "处理了 {N} 个 issues：{success} 个 PR 已打开，{failed} 个失败，{skipped} 个跳过。"

**如果设置了 --notify-channel，则发送通知到频道：**
如果提供了 `--notify-channel`，使用 `message` 工具将最终摘要发送到该 Telegram 频道：

```
Use the message tool with:
- action: "send"
- channel: "telegram"
- target: "{notify-channel}"
- message: "✅ GitHub Issues Processed

Processed {N} issues: {success} PRs opened, {failed} failed, {skipped} skipped.

{PR_LIST}"

Where PR_LIST 仅包含成功打开的 PR，格式为：
• #{issue_number}: {PR_url} ({notes})
```

然后继续到阶段 6。

---

## 阶段 6 — PR Review 处理程序

此阶段监控开放 PR（由此 skill 创建或预先存在的 `fix/issue-*` PR）以获取 review 评论，并生成子代理来处理它们。

**此阶段何时运行：**

- 结果收集之后（阶段 2-5 完成）— 检查刚刚打开的 PR
- 当设置了 `--reviews-only` 标志时 — 完全跳过阶段 2-5，仅运行此阶段
- 在 watch 模式中 — 在检查新 issues 后每个轮询周期运行

**Cron review 模式（`--cron --reviews-only`）：**
当同时设置了 `--cron` 和 `--reviews-only` 时：

1. 运行令牌解析（阶段 2 令牌部分）
2. 发现开放的 `fix/issue-*` PR（步骤 6.1）
3. 获取 review 评论（步骤 6.2）
4. **分析评论内容以确定可操作性**（步骤 6.3）
5. 如果发现可操作的评论，为第一个有待处理评论的 PR 生成**一个** review-fix 子代理 — 发射后不管（**不要**等待结果）
   - 使用 `cleanup: "keep"` 和 `runTimeoutSeconds: 3600`
   - 如果提供了 `--model`，在 spawn 配置中包含 `model: "{MODEL}"`
6. 报告："为 PR #{N} 生成了 review 处理程序 — 完成后将推送修复"
7. 立即退出 skill。不要继续到步骤 6.5（Review 结果）。

如果没有发现可操作的评论，报告"未找到可操作的 review 评论"并退出。

**正常模式（非 cron）继续如下：**

### 步骤 6.1 — 发现要监控的 PRs

收集要检查 review 评论的 PR：

**如果来自阶段 5：** 使用结果收集中的 `OPEN_PRS` 列表。

**如果 `--reviews-only` 或后续 watch 周期：** 获取所有带有 `fix/issue-` 分支模式的开放 PR：

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls?state=open&per_page=100"
```

过滤为仅 `head.ref` 以 `fix/issue-` 开头的 PR。

对于每个 PR，提取：`number`（PR 编号）、`head.ref`（分支名称）、`html_url`、`title`、`body`。

如果没有找到 PR，报告"没有要监控的开放 fix/ PR"并停止（如果在 watch 模式则循环回去）。

### 步骤 6.2 — 获取所有 Review 来源

对于每个 PR，从多个来源获取 reviews：

**获取 PR reviews：**

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls/{pr_number}/reviews"
```

**获取 PR review 评论（内联/文件级）：**

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls/{pr_number}/comments"
```

**获取 PR issue 评论（一般对话）：**

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/issues/{pr_number}/comments"
```

**获取 PR body 以获取嵌入的 reviews：**
某些 review 工具（例如 Greptile）将其反馈直接嵌入 PR body 中。检查：

- `<!-- greptile_comment -->` 标记
- PR body 中其他结构化的 review 部分

```
curl -s -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/{SOURCE_REPO}/pulls/{pr_number}"
```

提取 `body` 字段并解析嵌入的 review 内容。

### 步骤 6.3 — 分析评论以确定可操作性

**确定 bot 自己的用户名以进行过滤：**

```
curl -s -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user | jq -r '.login'
```

存储为 `BOT_USERNAME`。排除任何 `user.login` 等于 `BOT_USERNAME` 的评论。

**对于每个评论/review，分析内容以确定是否需要操作：**

**不可操作（跳过）：**

- 纯批准或无建议的"LGTM"
- 仅提供信息的 bot 评论（CI 状态、无特定请求的自动生成摘要）
- 已解决的评论（检查 bot 是否回复了"已在 commit 中解决..."）
- 状态为 `APPROVED` 且无要求更改的内联评论的 reviews

**可操作（需要关注）：**

- 状态为 `CHANGES_REQUESTED` 的 reviews
- 状态为 `COMMENTED` 的 reviews，包含特定请求：
  - "这个测试需要更新"
  - "请修复"、"更改这个"、"更新"、"可以吗"、"应该是"、"需要"
  - "会失败"、"会破坏"、"导致错误"
  - 提及特定代码问题（bug、缺少错误处理、边缘情况）
- 指出代码问题的内联 review 评论
- PR body 中嵌入的 reviews，识别：
  - 关键问题或破坏性更改
  - 预期的测试失败
  - 需要关注的特定代码
  - 带有担忧的置信度分数

**解析嵌入的 review 内容（例如 Greptile）：**
查找用 `<!-- greptile_comment -->` 或类似标记的部分。提取：

- 摘要文本
- 任何提及"关键问题"、"需要关注"、"会失败"、"测试需要更新"
- 低于 4/5 的置信度分数（表示担忧）

**构建可操作评论列表**，包含：

- 来源（review、内联评论、PR body 等）
- 作者
- Body 文本
- 对于内联：文件路径和行号
- 识别的特定操作项

如果在任何 PR 上都没有发现可操作的评论，报告"未找到可操作的 review 评论"并停止（如果在 watch 模式则循环回去）。

### 步骤 6.4 — 展示待处理的可操作评论

显示有待处理可操作评论的 PR 表格：

```
| PR | Branch | Actionable Comments | Sources |
|----|--------|---------------------|---------|
| #99 | fix/issue-42 | 2 comments | @reviewer1, greptile |
| #101 | fix/issue-37 | 1 comment | @reviewer2 |
```

如果**未设置** `--yes` 且这不是后续 watch 轮询：询问用户确认要处理的 PR（"all"、逗号分隔的 PR 编号，或"skip"）。

### 步骤 6.5 — 生成 Review Fix 子代理（并行）

对于每个有待操作评论的 PR，生成子代理。最多同时启动 8 个。

**Review fix 子代理提示：**

```
You are a PR review handler agent. Your task is to address review comments on a pull request by making the requested changes, pushing updates, and replying to each comment.

IMPORTANT: Do NOT use the gh CLI — it is not installed. Use curl with the GitHub REST API for all GitHub operations.

First, ensure GH_TOKEN is set. Check: echo $GH_TOKEN. If empty, read from config:
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/openclaw.json}"
GH_TOKEN=$(cat "$CONFIG_PATH" 2>/dev/null | jq -r '.skills.entries["gh-issues"].apiKey // empty') || GH_TOKEN=$(cat /data/.clawdbot/openclaw.json 2>/dev/null | jq -r '.skills.entries["gh-issues"].apiKey // empty')

/config
Repository: {SOURCE_REPO}
Push repo: {PUSH_REPO}
Fork mode: {FORK_MODE}
Push remote: {PUSH_REMOTE}
PR number: {pr_number}
PR URL: {pr_url}
Branch: {branch_name}
/config

/review_comments
{json_array_of_actionable_comments}

Each comment has:
- id: comment ID (for replying)
- user: who left it
- body: the comment text
- path: file path (for inline comments)
- line: line number (for inline comments)
- diff_hunk: surrounding diff context (for inline comments)
- source: where the comment came from (review, inline, pr_body, greptile, etc.)
/review_comments

/instructions
Follow these steps in order:

0. SETUP — Ensure GH_TOKEN is available:
```

export GH_TOKEN=$(node -e "const fs=require('fs'); const c=JSON.parse(fs.readFileSync('/data/.clawdbot/openclaw.json','utf8')); console.log(c.skills?.entries?.['gh-issues']?.apiKey || '')")

```
Verify: echo "Token: ${GH_TOKEN:0:10}..."

1. CHECKOUT — Switch to the PR branch:
git fetch {PUSH_REMOTE} {branch_name}
git checkout {branch_name}
git pull {PUSH_REMOTE} {branch_name}

2. UNDERSTAND — Read ALL review comments carefully. Group them by file. Understand what each reviewer is asking for.

3. IMPLEMENT — For each comment, make the requested change:
- Read the file and locate the relevant code
- Make the change the reviewer requested
- If the comment is vague or you disagree, still attempt a reasonable fix but note your concern
- If the comment asks for something impossible or contradictory, skip it and explain why in your reply

4. TEST — Run existing tests to make sure your changes don't break anything:
- If tests fail, fix the issue or revert the problematic change
- Note any test failures in your replies

5. COMMIT — Stage and commit all changes in a single commit:
git add {changed_files}
git commit -m "fix: address review comments on PR #{pr_number}

Addresses review feedback from {reviewer_names}"

6. PUSH — Push the updated branch:
git config --global credential.helper ""
git remote set-url {PUSH_REMOTE} https://x-access-token:$GH_TOKEN@github.com/{PUSH_REPO}.git
GIT_ASKPASS=true git push {PUSH_REMOTE} {branch_name}

7. REPLY — For each addressed comment, post a reply:

For inline review comments (have a path/line), reply to the comment thread:
curl -s -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/{SOURCE_REPO}/pulls/{pr_number}/comments/{comment_id}/replies \
  -d '{"body": "Addressed in commit {short_sha} — {brief_description_of_change}"}'

For general PR comments (issue comments), reply on the PR:
curl -s -X POST \
  -H "Authorization: Bearer $GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/{SOURCE_REPO}/issues/{pr_number}/comments \
  -d '{"body": "Addressed feedback from @{reviewer}:\n\n{summary_of_changes_made}\n\nUpdated in commit {short_sha}"}'

For comments you could NOT address, reply explaining why:
"Unable to address this comment: {reason}. This may need manual review."

8. REPORT — Send back a summary:
- PR URL
- Number of comments addressed vs skipped
- Commit SHA
- Files changed
- Any comments that need manual attention
/instructions

/constraints
- Only modify files relevant to the review comments
- Do not make unrelated changes
- Do not force-push — always regular push
- If a comment contradicts another comment, address the most recent one and flag the conflict
- Do NOT use the gh CLI — use curl + GitHub REST API
- GH_TOKEN is already in the environment — do not prompt for auth
- Time limit: 60 minutes max
/constraints
```

**每个子代理的生成配置：**

- runTimeoutSeconds: 3600（60 分钟）
- cleanup: "keep"（保留记录以供审查）
- 如果提供了 `--model`，在 spawn 配置中包含 `model: "{MODEL}"`

### 步骤 6.6 — Review 结果

所有 review 子代理完成后，呈现摘要：

```
| PR | Comments Addressed | Comments Skipped | Commit | Status |
|----|-------------------|-----------------|--------|--------|
| #99 fix/issue-42 | 3 | 0 | abc123f | All addressed |
| #101 fix/issue-37 | 1 | 1 | def456a | 1 needs manual review |
```

将本批次的评论 ID 添加到 `ADDRESSED_COMMENTS` 集合以防止重新处理。

---

## Watch 模式（如果 --watch 处于活动状态）

在显示当前批次的結果后：

1. 将本批次的所有 issue 编号添加到运行集合 PROCESSED_ISSUES。
2. 将所有已处理的评论 ID 添加到 ADDRESSED_COMMENTS。
3. 告诉用户：
   > "下一轮轮询在 {interval} 分钟后...（说 'stop' 结束 watch 模式）"
4. 睡眠 {interval} 分钟。
5. 返回**阶段 2 — 获取 Issues**。获取将自动过滤掉：
   - 已在 PROCESSED_ISSUES 中的 issues
   - 具有现有 fix/issue-{N} PR 的 issues（阶段 4 飞行前检查中捕获）
6. 在阶段 2-5 之后（或如果没有新 issues），运行**阶段 6** 检查所有跟踪 PR（新创建和先前打开的）上的新 review 评论。
7. 如果没有新 issues **且**没有新的可操作 review 评论 → 报告"无新活动。{interval} 分钟后再次轮询..."并循环回步骤 4。
8. 用户可以随时说"stop"退出 watch 模式。停止时，呈现所有批次的最终累积摘要 — 已处理的 issues **和**已处理的 review 评论。

**轮询之间的上下文卫生 — 重要：**
仅在轮询周期之间保留：

- PROCESSED_ISSUES（issue 编号集合）
- ADDRESSED_COMMENTS（评论 ID 集合）
- OPEN_PRS（跟踪 PR 列表：编号、分支、URL）
- 累积结果（每个 issue 一行 + 每个 review 批次一行）
- 阶段 1 解析的参数
- BASE_BRANCH、SOURCE_REPO、PUSH_REPO、FORK_MODE、BOT_USERNAME
  **不要**在轮询之间保留 issue bodies、评论 bodies、子代理记录或代码库分析。

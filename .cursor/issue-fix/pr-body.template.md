# PR 正文模板 — Real behavior proof 字段名要求

⚠️ **Real behavior proof 检查脚本逐字匹配以下字段名，格式必须完全一致！**
用简化格式或不同字段名会导致检查失败，需要重新 commit 触发 CI。

## Real behavior proof (required for external PRs)

- **Behavior or issue addressed:** （修复了什么行为/数据问题）
- **Real environment tested:** （测试环境描述，如 commit SHA + 运行方式）
- **Exact steps or command run after this patch:**
  ```
  （复现命令，放 fenced code block 内）
  ```
- **Evidence after fix:**
  ```
  （Live 日志、终端输出，放 fenced code block 内）
  ```
  ![证据截图](截图URL)（用 Markdown 图片语法，不要用 HTML `<img>`）
- **Observed result after fix:** （修复后观察到的结果）
- **What was not tested:** （未测试的路径/场景）
- **Proof limitations:** （证据局限，诚实说明）
- **Before evidence (optional):** （修复前行为，可选）

## 注意事项

1. `- **字段名:**` 格式必须严格一致：`- ` + `**` + 字段名 + `:**` + 空格 + 值
2. `Evidence after fix` 字段同时放日志（fenced code block）和截图（Markdown 图片）
3. 截图用 `![alt](url)` 格式，HTML `<img>` 不会被脚本识别
4. 字段值不要包含 "not tested" / "vitest" / "mock" 等触发 mock-only 检测的关键词
5. 脚本检查字段名列表（按匹配顺序）：
   - Behavior: `Behavior or issue addressed` / `Issue addressed` / `Behavior addressed`
   - Environment: `Real environment tested` / `Environment tested` / `Real setup tested`
   - Steps: `Exact steps or command run after this patch` / ...（5 个变体）
   - Evidence: `Evidence after fix` / `After-fix evidence` / `Evidence link or embedded proof` / `Evidence`
   - ObservedResult: `Observed result after fix` / `Observed result after the fix` / `Observed result`
   - NotTested: `What was not tested` / `Not tested`（允许值: `none` / `no known gaps`）

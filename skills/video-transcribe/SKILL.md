---
name: video-transcribe
description: "将视频/音频文件转录为带标点的文字，并以 Word 文档保存。适用场景：用户要求将视频内容提取为文字、整理成 docx 文件。 Usage: /video-transcribe <视频文件路径> 或描述视频位置"
user-invocable: true
metadata: { "openclaw": { "requires": { "bins": ["python"], "pythonPkgs": ["openai-whisper", "python-docx"] } } }
---

# video-transcribe — 视频转文字 · Whisper + Word

将视频（或音频）文件自动转录为带标点、已断句的文字，并保存为 `.docx` 格式到桌面。

---

## 工作流程（4步）

### Step 1：定位视频文件

在用户桌面及子目录递归搜索常见视频格式：

```powershell
Get-ChildItem "C:\Users\Administrator\Desktop" -Include *.mp4,*.avi,*.mkv,*.mov,*.wmv,*.flv -Recurse | Select-Object FullName, @{N="Size(MB)";E={[math]::Round($_.Length/1MB,2)}}, LastWriteTime | Format-Table -AutoSize
```

或用 ffprobe 快速确认视频时长：

```powershell
ffprobe -v quiet -print_format json -show_format <视频路径> 2>&1 | Select-String "duration"
```

### Step 2：确认 Whisper 模型状态

检查已下载的 Whisper 模型（存放在 `~/.cache/whisper/`）：

```python
import whisper, os
whisper_dir = os.path.dirname(whisper.__file__)
models_dir = os.path.join(whisper_dir, 'models')
# 检查 whisper\models 目录
for f in os.listdir(models_dir): print(f)
# 检查缓存
import glob
cache_files = glob.glob(os.path.expanduser("~/.cache/whisper/*.pt"))
for f in cache_files: print(f, os.path.getsize(f)/1024/1024, "MB")
```

**模型优先级（降序）：**
| 模型 | 大小 | 说明 |
|------|------|------|
| large-v3 | ~2880 MB | 准确率最高，下载慢 |
| **medium** | ~1530 MB | **优先用这个**（通常已下载） |
| base | ~139 MB | 速度最快，准确率较低 |

> ⚠️ 如果 large 模型缓存 < 100MB，说明下载不完整（真实需要 2.88GB），不要使用。fallback 到 medium。

### Step 3：执行转录（Python 脚本）

写一个独立 Python 脚本 `transcribe_work.py` 到工作区，然后执行：

```python
import whisper
from docx import Document

model = whisper.load_model("medium")   # 优先 medium
result = model.transcribe("<视频完整路径>", language="zh")
text = result["text"]

doc = Document()
doc.add_heading("视频转写文字", 0)
doc.add_paragraph(text)
doc.save("<输出路径>")
```

> ⚠️ 直接在 PowerShell 中用 `python -c "..."` 传入多行脚本容易遇到引号转义问题。**务必写到 .py 文件再运行**，不要用 `-c` 传多行代码。

### Step 4：标点恢复 + 格式化（AI 处理）

Whisper ASR 输出是纯汉字，无标点。需要用 AI 做「标点恢复 + 合理断句」：

**方法 A（推荐）：用 sub-agent**
```python
sessions_spawn(
    task=f"""以下是一段视频转录的原始文字，没有任何标点符号。
请为这段文字添加恰当的标点符号，进行合理断句，整理成通顺易读的文章。
直接返回整理后的完整文字，不要任何说明。

原文：
{raw_text}""",
    runtime="subagent",
    runTimeoutSeconds=120
)
```

**方法 B：用 Gateway OpenAI 兼容接口**（需先确认 endpoint 开启）
```
POST http://127.0.0.1:18789/v1/chat/completions
Authorization: Bearer <gateway_token>
```

### Step 5：生成最终 Word 文档

将标点处理后的文字写入 `.docx`，带格式：

```python
from docx import Document
from docx.shared import Pt
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document()
title = doc.add_heading('标题', 0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER

for para in punctuated_text.strip().split('\n\n'):
    p = doc.add_paragraph(para.strip())
    p.paragraph_format.line_spacing = 1.5
    p.paragraph_format.first_line_indent = Pt(24)

doc.save("<桌面路径>")
```

---

## 关键经验教训

### 🔴 本次踩的坑

1. **Whisper large 模型下载速度极慢**
   - 症状：下载速度 5~10 KB/s，100+ 小时也无法完成
   - 根因：网络问题，模型实际 2.88GB
   - 解决：检查 `~/.cache/whisper/` 中已下载的模型文件大小，优先用 medium.pt（1.5GB）

2. **PowerShell 多行 Python 脚本引号问题**
   - 症状：`python -c "..."` 传入多行脚本时，PowerShell 报语法错误
   - 解决：写 `.py` 文件，用 `python script.py` 执行，**不要用 `-c`**

3. **Whisper 转录结果无标点**
   - 症状：ASR 直接输出纯汉字，无逗号句号
   - 解决：必须用 AI（sub-agent 或 LLM API）做标点恢复

4. **Gateway OpenAI 接口 404**
   - 症状：POST `/v1/chat/completions` 返回 404
   - 根因：接口未开启或路径不对
   - 解决：用 sub-agent 绕开，sub-agent 不受此影响

### 🟢 提速技巧

- **先确认 medium 模型已下载**（`medium.pt` ~1.5GB），直接使用，完全省去下载时间
- ** Whisper medium CPU 转录速度**：~10 分钟视频约 30~50 分钟（medium），比 large 快 3~5 倍
- 如果经常处理长视频，提前手动下载模型到缓存：
  ```python
  whisper.load_model("medium")  # 首次运行自动下载
  ```

---

## 文件路径规范

```
输出文件 → 用户桌面（桌面路径固定为 C:\Users\Administrator\Desktop）
临时文件 → 工作区（C:\Users\Administrator\.openclaw\workspace）
日志/记录 → memory/YYYY-MM-DD.md
```

---

## 工作准则（来自用户指令）

> "如果需要超过20分钟以上时间才能处理完，请在处理过程中，请每隔10分钟给我汇报下进度，以免让我认为你卡在运行过程中。"

**处理方式：**
- 预计 < 20 分钟：直接执行，完成后告知
- 预计 >= 20 分钟：启动处理，每 10 分钟中间汇报进度（可用 `sessions_send` 发消息到主会话）
- 预计 >= 60 分钟：建议先告知用户，由用户决定是否继续

---

_本 Skill 来自 2026-03-22 实际任务总结（视频：1.mp4，时长 10 分钟，转录 + 标点 + docx 全流程）_

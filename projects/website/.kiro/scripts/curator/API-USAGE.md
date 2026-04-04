# Curator 分析 API 使用指南

## 概述

`curator-analyze-api.sh` 將 Curator 的圖片分析功能封裝成 API 形式，輸出純 JSON 格式，方便其他程式調用。

## 核心設計

### 輸出分離
- **stdout**: 純 JSON 結果（可被管道處理）
- **stderr**: 執行日誌和狀態訊息

### 特點
- ✅ 純 JSON 輸出，無其他文字
- ✅ 可直接用 `jq` 處理
- ✅ 可當作 API 被其他腳本調用
- ✅ 符合 Unix 哲學（do one thing well）

---

## 使用方式

### 1. 基本用法

```bash
# 分析課程 5
.kiro/scripts/curator/curator-analyze-api.sh 5
```

輸出範例：
```json
{
  "course_id": 5,
  "course_title": "AI 溝通術 - 90 分鐘掌握AI Prompt 工程技巧",
  "analyzed_at": "2025-11-02T09:00:00.000Z",
  "total_images": 8,
  "images": [
    {
      "type": "main_image",
      "title": "課程主圖",
      "downloaded_path": "/tmp/curator_images/123456.png",
      "analysis": {
        "dominant_colors": ["#FF6B6B", "#4ECDC4", "#45B7D1"],
        "theme": "現代科技風格，專業且具未來感",
        "mood": "創新、專業、充滿活力",
        "key_elements": ["AI 圖標", "漸層背景", "課程標題文字"],
        "content_type": "product",
        "confidence": 0.95
      }
    }
  ]
}
```

---

### 2. 存成檔案

```bash
# 存成 JSON 檔案
.kiro/scripts/curator/curator-analyze-api.sh 5 > course-5-analysis.json

# 驗證 JSON 格式
cat course-5-analysis.json | jq '.'
```

---

### 3. 用 jq 處理

```bash
# 取得總圖片數
.kiro/scripts/curator/curator-analyze-api.sh 5 | jq '.total_images'

# 取得第一張圖的主色調
.kiro/scripts/curator/curator-analyze-api.sh 5 | jq '.images[0].analysis.dominant_colors'

# 取得所有圖片的類型
.kiro/scripts/curator/curator-analyze-api.sh 5 | jq '.images[].type'

# 只看 highlight 圖片
.kiro/scripts/curator/curator-analyze-api.sh 5 | jq '.images[] | select(.type | startswith("highlight"))'

# 計算平均信心度
.kiro/scripts/curator/curator-analyze-api.sh 5 | jq '[.images[].analysis.confidence] | add / length'
```

---

### 4. 當作 API 使用

#### 在其他 Shell 腳本中調用

```bash
#!/bin/bash

# 呼叫 Curator API
RESULT=$(./curator-analyze-api.sh 5 2>/dev/null)

# 解析結果
TOTAL_IMAGES=$(echo "$RESULT" | jq '.total_images')
FIRST_THEME=$(echo "$RESULT" | jq -r '.images[0].analysis.theme')

echo "課程共有 $TOTAL_IMAGES 張圖片"
echo "主圖風格: $FIRST_THEME"
```

#### 在 TypeScript/JavaScript 中調用

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function analyzeCourse(courseId: number) {
  const { stdout, stderr } = await execAsync(
    `.kiro/scripts/curator/curator-analyze-api.sh ${courseId}`
  );

  // stdout 是純 JSON
  const result = JSON.parse(stdout);

  console.log(`分析了 ${result.total_images} 張圖片`);
  console.log('主色調:', result.images[0].analysis.dominant_colors);

  return result;
}

// 使用
analyzeCourse(5).then(result => {
  console.log(result);
});
```

#### 在 Python 中調用

```python
import subprocess
import json

def analyze_course(course_id):
    result = subprocess.run(
        ['.kiro/scripts/curator/curator-analyze-api.sh', str(course_id)],
        capture_output=True,
        text=True
    )

    # stdout 是純 JSON
    data = json.loads(result.stdout)

    print(f"分析了 {data['total_images']} 張圖片")
    print(f"主色調: {data['images'][0]['analysis']['dominant_colors']}")

    return data

# 使用
result = analyze_course(5)
```

---

### 5. 批次處理

```bash
#!/bin/bash

# 分析所有課程
for course_id in 2 3 4 5 6; do
  echo "分析課程 $course_id..." >&2

  ./curator-analyze-api.sh $course_id > "analysis_${course_id}.json"

  # 取得主色調
  COLORS=$(cat "analysis_${course_id}.json" | jq -r '.images[0].analysis.dominant_colors[0]')
  echo "課程 $course_id 主色: $COLORS" >&2
done

# 合併所有結果
jq -s '.' analysis_*.json > all_analyses.json
```

---

### 6. 整合進 CI/CD

```yaml
# .github/workflows/analyze-courses.yml
name: Analyze Course Images

on:
  schedule:
    - cron: '0 0 * * *'  # 每天執行

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: pnpm install

      - name: Analyze course 5
        run: |
          .kiro/scripts/curator/curator-analyze-api.sh 5 > course-5.json

      - name: Upload results
        uses: actions/upload-artifact@v3
        with:
          name: analysis-results
          path: course-5.json
```

---

## 輸出格式

### 完整結構

```typescript
interface AnalysisResult {
  course_id: number;
  course_title: string;
  analyzed_at: string; // ISO 8601
  total_images: number;
  images: ImageAnalysis[];
}

interface ImageAnalysis {
  type: string; // "main_image" | "content_video" | "highlight1" | ...
  title: string;
  downloaded_path: string;
  analysis: {
    dominant_colors: string[]; // Hex 格式 ["#RRGGBB"]
    theme: string;
    mood: string;
    key_elements: string[];
    content_type: "product" | "highlight" | "banner" | "video" | "icon";
    confidence: number; // 0-1
  };
  error?: string; // 如果分析失敗
}
```

---

## 錯誤處理

### 檢查退出碼

```bash
if .kiro/scripts/curator/curator-analyze-api.sh 5 > result.json; then
  echo "成功！"
  cat result.json | jq '.'
else
  echo "失敗！退出碼: $?"
fi
```

### 處理無效 JSON

```bash
OUTPUT=$(.kiro/scripts/curator/curator-analyze-api.sh 5 2>&1)

if echo "$OUTPUT" | jq empty 2>/dev/null; then
  echo "有效的 JSON"
  echo "$OUTPUT" | jq '.'
else
  echo "無效的 JSON，原始輸出:"
  echo "$OUTPUT"
fi
```

---

## 效能考量

### 快取結果

```bash
#!/bin/bash

CACHE_FILE=".cache/course-5-analysis.json"
CACHE_TTL=3600  # 1 小時

if [ -f "$CACHE_FILE" ]; then
  AGE=$(($(date +%s) - $(stat -f %m "$CACHE_FILE")))

  if [ $AGE -lt $CACHE_TTL ]; then
    echo "使用快取..." >&2
    cat "$CACHE_FILE"
    exit 0
  fi
fi

# 重新分析
echo "重新分析..." >&2
mkdir -p .cache
./curator-analyze-api.sh 5 | tee "$CACHE_FILE"
```

### 平行處理

```bash
#!/bin/bash

# 同時分析多個課程
for course_id in 2 3 4 5 6; do
  ./curator-analyze-api.sh $course_id > "analysis_${course_id}.json" &
done

# 等待所有完成
wait

echo "所有分析完成！"
```

---

## 與其他工具整合

### 配合 n8n 使用

```javascript
// n8n Execute Command Node
const courseId = $input.item.json.courseId;
const command = `.kiro/scripts/curator/curator-analyze-api.sh ${courseId}`;

const result = await $exec(command);
return JSON.parse(result.stdout);
```

### 配合 Make.com 使用

使用 HTTP Module 調用包裝過的 API endpoint：

```bash
# 建立簡單的 HTTP wrapper
# server.js
const express = require('express');
const { exec } = require('child_process');

app.get('/analyze/:courseId', (req, res) => {
  const { courseId } = req.params;

  exec(`.kiro/scripts/curator/curator-analyze-api.sh ${courseId}`, (err, stdout) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json(JSON.parse(stdout));
    }
  });
});
```

---

## 最佳實踐

### 1. 永遠驗證 JSON

```bash
OUTPUT=$(./curator-analyze-api.sh 5)

if echo "$OUTPUT" | jq empty 2>/dev/null; then
  # 處理 JSON
  echo "$OUTPUT" | jq '.images[0]'
else
  echo "錯誤：無效的 JSON"
  exit 1
fi
```

### 2. 記錄執行日誌

```bash
# 日誌輸出到檔案
./curator-analyze-api.sh 5 \
  > result.json \
  2> execution.log
```

### 3. 使用 timeout

```bash
# 避免卡住
timeout 300 ./curator-analyze-api.sh 5 > result.json
```

---

## 常見問題

### Q: 為什麼輸出中有執行訊息？

A: 執行訊息在 stderr，純 JSON 在 stdout。請使用重定向分離：
```bash
./curator-analyze-api.sh 5 > result.json 2> log.txt
```

### Q: 如何只取得 JSON 不顯示日誌？

A: 重定向 stderr 到 /dev/null：
```bash
./curator-analyze-api.sh 5 2>/dev/null
```

### Q: 可以指定輸出檔案位置嗎？

A: 腳本只輸出到 stdout，請用重定向：
```bash
./curator-analyze-api.sh 5 > /path/to/output.json
```

---

## 進階應用

### 建立 Dashboard

```bash
#!/bin/bash

# 生成所有課程的分析 Dashboard
echo "# 課程視覺分析 Dashboard" > dashboard.md
echo "生成時間: $(date)" >> dashboard.md
echo "" >> dashboard.md

for course_id in {2..6}; do
  RESULT=$(./curator-analyze-api.sh $course_id 2>/dev/null)

  TITLE=$(echo "$RESULT" | jq -r '.course_title')
  TOTAL=$(echo "$RESULT" | jq '.total_images')
  COLORS=$(echo "$RESULT" | jq -r '.images[0].analysis.dominant_colors | join(", ")')

  echo "## 課程 $course_id: $TITLE" >> dashboard.md
  echo "- 圖片數: $TOTAL" >> dashboard.md
  echo "- 主色調: $COLORS" >> dashboard.md
  echo "" >> dashboard.md
done
```

---

## 相關文件

- [Curator Persona README](.kiro/personas/curator/README.md)
- [Curator API 文件](.kiro/api/curator.ts)
- [執行腳本對比](./README-ANALYZE.md)

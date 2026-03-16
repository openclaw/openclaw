# Session List 改进方案

## 目标
在 Control UI 的会话列表中显示时间戳 + 最后消息预览，而不是只显示长长的技术 ID。

## 修改文件
`ui/src/ui/views/sessions.ts`

## 修改内容

### 1. 在 `renderRow` 函数中：
- 调用 `sessions.preview` API 获取最后消息预览
- 修改 `updated` 列显示格式：`[MM/DD HH:mm] 消息预览...`

### 2. 具体实现：

```typescript
// 在 renderRow 函数中，修改 updated 的渲染
// 原代码：
const updated = row.updatedAt ? formatRelativeTimestamp(row.updatedAt) : "n/a";

// 新代码：
const updated = row.updatedAt 
  ? html`
      <div class="session-updated-cell">
        <div class="session-timestamp">${formatTimestamp(row.updatedAt)}</div>
        <div class="session-preview">${row.lastMessagePreview || "..."}</div>
      </div>
    `
  : "n/a";
```

### 3. 添加样式：
```css
.session-updated-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-width: 200px;
}

.session-timestamp {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}

.session-preview {
  font-size: 13px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

## 测试步骤
1. 运行 `npm run dev:ui` 启动开发服务器
2. 打开 Control UI 查看会话列表
3. 确认时间戳和消息预览正确显示

## 提交 PR
1. 创建分支：`feature/session-list-preview`
2. 提交代码
3. 提交 PR 到 openclaw/openclaw

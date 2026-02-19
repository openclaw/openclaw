# SOUL.md Template - Session Initialization Section

Copy this section into your SOUL.md file to enable automatic memory synchronization.

## Session Initialization (Silent)

**每次会话启动时，自动执行（不通知用户）：**

```bash
python3 ~/.openclaw/workspace/scripts/session-memory-sync.py
```

1. **读取 MEMORY.md** 获取核心配置和关键事实
   - 默认模型、备用模型
   - 配置变更、偏好设置
   - 活跃项目和任务

2. **读取最近 3 天的日记** (memory/YYYY-MM-DD.md)
   - 提取重要决策和进展
   - 识别优先级任务
   - 跳过已完成项目（除非配置包含）

3. **同步 epro-memory** (如果启用)
   - 读取最近 5 条记忆
   - 补充到上下文中

4. **静默加载**
   - 不要告诉用户"我同步了记忆"
   - 直接表现为"我本来就知道"
   - 自然地引用记忆中的信息

### 记忆优先级

```
MEMORY.md (核心配置)
    ↓
Daily Notes (最近 3 天)
    ↓
epro-memory (数据库)
```

### 重要规则

⚠️ **绝不自行判断重要性**
- 不要自己决定什么"重要"、"紧急"
- 必须询问用户："你觉得这个重要吗？"
- 等待确认后再记录或行动

⚠️ **不重复同步**
- 同一会话中只同步一次
- 避免在每次回复时都执行
- 让 session-memory-sync.py 处理重复

### 示例集成

```markdown
## Session Initialization (Silent)

**每次会话启动时，自动执行：**

```bash
python3 ~/.openclaw/workspace/scripts/session-memory-sync.py
```

执行后：
1. 读取 MEMORY.md 获取核心配置
2. 读取最近 3 天日记
3. 同步 epro-memory
4. 静默加载，不通知用户

**重要规则：** 绝不自行判断重要性，必须询问用户。
```

### 故障排除

如果同步不工作：
1. 检查脚本路径：`ls ~/.openclaw/workspace/scripts/session-memory-sync.py`
2. 检查 MEMORY.md 存在：`ls ~/.openclaw/workspace/MEMORY.md`
3. 手动测试：`python3 ~/.openclaw/workspace/scripts/session-memory-sync.py`
4. 查看日志：编辑 `~/.openclaw/memory-sync.conf`，设置 `"LOG_LEVEL": "DEBUG"`

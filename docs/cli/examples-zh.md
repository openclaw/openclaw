# OpenClaw CLI 常用命令示例

## 基础操作

### 查看状态
```bash
openclaw status
openclaw status --json  # JSON格式输出
```

### Gateway 管理
```bash
openclaw gateway start     # 启动
openclaw gateway stop      # 停止
openclaw gateway restart   # 重启
openclaw gateway status    # 状态
```

### 配置
```bash
openclaw config show       # 显示当前配置
openclaw config edit       # 编辑配置
openclaw onboard           # 运行向导
```

## 记忆管理

### 搜索记忆
```bash
openclaw memory search "关键词"
openclaw memory search --query "deployment notes"
openclaw memory search "关键词" --max-results 10
```

### 索引管理
```bash
openclaw memory status     # 查看索引状态
openclaw memory index      # 更新索引
openclaw memory index --force  # 强制重建
```

## 会话管理

### 查看会话
```bash
openclaw sessions list
openclaw sessions list --active  # 只看活跃的
```

### 发送消息
```bash
openclaw sessions send --session-key "xxx" "消息内容"
```

## Skills

### 安装Skills
```bash
openclaw skills install <skill-name>
openclaw skills list
openclaw skills update <skill-name>
```

## 调试

### 日志
```bash
openclaw logs
openclaw logs --follow    # 实时日志
openclaw logs --tail 100  # 最后100行
```

### 调试模式
```bash
openclaw --verbose
openclaw status --verbose
```

## 设备管理

### 配对设备
```bash
openclaw devices list
openclaw devices pair
openclaw devices revoke <device-id>
```

## 贡献

发现bug或有改进建议？[提交Issue](https://github.com/openclaw/openclaw/issues)

---

🦞 OpenClaw - Your personal AI assistant

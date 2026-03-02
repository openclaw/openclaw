# 故障排查指南

## 常见问题

### Gateway 启动失败

**症状**: `openclaw gateway start` 报错

**检查**:
```bash
# 查看端口占用
lsof -i :3000

# 查看日志
openclaw logs --tail 100

# 检查配置
openclaw config show
```

**解决**:
- 确保端口未被占用
- 检查配置文件语法
- 重启 gateway

---

### Token/Context Overflow

**症状**: `prompt is too long` 错误

**解决**:
```bash
# 清理会话历史
openclaw sessions cleanup

# 使用更大context的模型
openclaw config edit
```

---

### 记忆搜索无结果

**症状**: `openclaw memory search` 返回空

**检查**:
```bash
# 查看索引状态
openclaw memory status

# 检查memory文件
ls -la ~/.openclaw/workspace/memory/
```

**解决**:
```bash
# 重建索引
openclaw memory index --force
```

---

### Telegram/WhatsApp 连接问题

**症状**: 消息不送达

**检查**:
1. Token是否有效
2. Channel配置是否正确
3. Gateway是否运行

**解决**:
```bash
# 重新配置channel
openclaw onboard --install-daemon

# 检查日志
openclaw logs --follow
```

---

### 模型API错误

**症状**: 401/429/500 错误

**检查**:
```bash
# 查看当前模型配置
openclaw status

# 测试API连接
curl https://api.openai.com/v1/models \
  -H "Authorization: Bearer YOUR_KEY"
```

**解决**:
- 验证API Key
- 检查配额
- 配置fallback模型

---

### 依赖问题

**症状**: npm install 失败

**解决**:
```bash
# 清理缓存
npm cache clean --force

# 重新安装
rm -rf node_modules package-lock.json
npm install
```

---

## 获取帮助

1. **日志**: `openclaw logs --tail 200`
2. **状态**: `openclaw status`
3. **Discord**: https://discord.gg/clawd
4. **GitHub Issues**: https://github.com/openclaw/openclaw/issues

提交Issue时请附上:
- OpenClaw版本 (`openclaw --version`)
- 操作系统
- 错误日志
- 复现步骤

---

🦞 OpenClaw - We're here to help!

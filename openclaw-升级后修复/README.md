# openclaw 升级后修复

本目录汇总 OpenClaw 升级后的统一修复资产，便于在新版本安装后快速回放修复并核验结果。

## 包含文件

1. `OpenClaw_升级后统一修复手册_heartbeat_toolMsg_20260329.md`
   - 升级后统一修复手册（heartbeat 污染、toolMsg 防护、WebChat 重复显示问题）
   - 包含官方 issue 状态、执行顺序、核验命令

2. `openclaw-reapply-heartbeat-fix.sh`
   - 源码级复打修复脚本
   - 包含 heartbeat 污染修复、toolMsg 防护、WebChat 重复发送/显示防护补丁、回归测试与健康检查

3. `openclaw-safe-upgrade.sh`
   - 安全升级脚本
   - 先升级官方版本，再自动调用复打脚本，最后做二次核验与日志诊断

## 推荐使用顺序

1. 执行安全升级

```bash
./openclaw-升级后修复/openclaw-safe-upgrade.sh 2026.3.28
```

2. 若需仅回放修复

```bash
./openclaw-升级后修复/openclaw-reapply-heartbeat-fix.sh 2026.3.28
```

## 目标

- 避免 heartbeat 污染主会话上下文再次出现
- 防止 `toolMsg.content.filter` 类型错误导致会话中断
- 降低 WebChat 在重连场景下“输入一次显示两次”的复发概率

# Openclaw Fork 同步与自用改动流程

本文档适用于：
- 你已经在 GitHub 上 fork 了 `openclaw/openclaw` 到自己的账号
- 你在本地需要做一些自用改动
- 同时希望持续跟进原作者的更新

## 一次性配置（只需要做一次）

1) 进入本地仓库
```bash
cd /root/code/openclaw
```

2) 检查远程
```bash
git remote -v
```

3) 配置远程（已在本机完成，可跳过）
- `origin` 指向你的 fork
- `upstream` 指向原作者仓库

```bash
# 如果当前 origin 是原作者仓库，则先改名为 upstream
# git remote rename origin upstream

# 添加自己的 fork 为 origin
# git remote add origin https://github.com/你的账号/openclaw.git
```

最终应看到：
```
origin   https://github.com/你的账号/openclaw.git (fetch)
origin   https://github.com/你的账号/openclaw.git (push)
upstream https://github.com/openclaw/openclaw.git (fetch)
upstream https://github.com/openclaw/openclaw.git (push)
```

## 日常使用流程

### 1) 拉取原作者更新（推荐定期做）
```bash
git checkout main
git fetch upstream
git merge upstream/main
# 或者更干净的历史：git rebase upstream/main
```

### 2) 推回你自己的 fork（可选）
```bash
git push origin main
```

### 3) 自用改动（建议单独分支）
```bash
git checkout -b my-changes
# 修改代码
git add .
git commit -m "my tweaks"
git push origin my-changes
```

### 4) 让你的改动跟上最新主线
```bash
git checkout my-changes
git rebase main
# 或者 git merge main
```

## 常见问题

### Q1: 不加 upstream 会怎样？
A: 你只会看到自己 fork 的更新，看不到原作者的更新。

### Q2: 只想自用，不想提交回原项目？
A: 不需要开 PR。只要在自己的 fork 和本地维护即可。

### Q3: 我什么时候需要开 PR？
A: 当你希望把改动贡献给原作者时，从你的分支发起 PR 即可。

## 快速查看更新差异
```bash
git fetch upstream
git log --oneline --decorate --graph --all -n 20
```

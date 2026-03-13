# OpenClaw Windows 与 Linux 部署说明

该文档为项目交付版部署指南，适合非专业人员按步骤执行。

完整说明请查看项目根目录文件：
- `DEPLOYMENT_WINDOWS_LINUX.md`

推荐部署产物：
- `release/openclaw-2026.3.11-windows.zip`
- `release/openclaw-2026.3.11-linux.tar.gz`
- `release/SHA256SUMS.txt`

快速开始（Windows）：

```powershell
cd D:\deploy\openclaw-2026.3.11
npm install --omit=dev
node .\openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force
```

快速开始（Linux）：

```bash
cd /opt/openclaw/openclaw-2026.3.11
npm install --omit=dev
node ./openclaw.mjs gateway run --bind 0.0.0.0 --port 18789 --force
```

说明：
- 如需 systemd/NSSM 自启、升级回滚、常见问题排查，请使用根目录完整文档。

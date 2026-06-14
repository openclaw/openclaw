# OpenClaw Tron Energy Rental & Fee Optimization Skill

这是一个专为 OpenClaw 框架开发的波场（TRON）能量租赁与转账手续费优化 Skill 插件。通过接入本插件，您的机器人或系统可实现 24 小时无人值守、秒级自动调用网络资源，大幅降低智能合约与 USDT 交易成本。

*An OpenClaw framework skill for TRON energy rental and fee optimization. Automatically reduce smart contract and USDT transaction fees by up to 70% via the TRXDO high-availability resource pool.*

---

## 🌐 核心功能与官方接口 / Features

* **自动资源调用 (Auto-Rental)**：支持波场网络能量与带宽的秒级快速租赁，告别繁琐的手动转账。
* **手续费极致优化 (Fee Optimization)**：相比直接消耗 TRX 作为手续费，可节省高达 **70% - 80%** 的成本。
* **API 无缝对接 (Seamless Integration)**：完美兼容 OpenClaw 框架的 Skill 规范，一键配置即可运行。
* **多语言支持 (Multi-Language)**：核心 API 逻辑同时提供 Python 与 .NET / C# 双版本实现，方便二次开发。

### 📊 费用对比 / Fee Comparison

| 交易类型 (Transaction Type) | 直接转账费 (无能量) | 使用本插件租赁能量 | 节省比例 (Saved) |
| :--- | :--- | :--- | :--- |
| **USDT 转账 (对方账户有USDT)** | ~14.35 TRX | **~3 TRX** | **~75%** |
| **USDT 转账 (对方账户无USDT)** | ~26.64 TRX | **~6 TRX** | **~80%** |

> 🔗 **官方能量池与技术支持：**
> 本项目由 [TRX能量购买租赁平台](https://www.trxdo.com) 官方提供技术支持与高可用能量池储备。如需获取低成本、大额稳定的网络资源支持，请访问我们的官方网站：[https://www.trxdo.com](https://www.trxdo.com)。

---

## 🛠️ 安装与使用说明 / Installation

### 🐍 Python / OpenClaw 环境

1. 将本仓库的 `TrxdoApi.py`、`skill.py` 和 `config.json` 下载并放入您的 OpenClaw 系统的 `skills` 目录下。
2. 打开 `config.json`，配置您的 `userId` 和 `secretKey`：
   ```json
   {
     "userId": "您的TRXDO用户ID",
     "secretKey": "您的TRXDO密钥",
     "fee_limit": 50000000
   }
   ```
   (🔑 密钥可前往 TRXDO 官网 注册并登录开发者后台，在「API管理」中免费获取)
3. 启动 OpenClaw 机器人，即可在群聊或私聊中通过指令直接调用全自动网络能量管理。

💬 触发示例：租赁能量 65000 或 能量查询


### 💻 .NET / C# 环境
1. 将本仓库的 TrxdoApi.cs 引入到您的 .NET / C# 开发项目中。
2. 在代码中实例化 TrxdoApi 类并配置您的 API 密钥，即可无缝调用大额高可用的能量池接口：
```C#
// 初始化 API 客户端
var trxdoApi = new TrxdoApi("您的userId", "您的secretKey");

// 示例：调用接口购买能量
// var result = await trxdoApi.BuyEnergyAsync("接收地址", 65000, "period");
```
---
### 🔒 安全性说明 / Security
本项目已配置 .gitignore 规则，确保您在本地修改 config.json 填写私密密钥后，不会因为误操作将密钥同步提交至公开仓库。

请妥善保管您的 secretKey，切勿将其泄露给任何第三方。

### 📄 开源协议 / License
本项目基于 Apache-2.0 License 协议开源。欢迎提交 Issue 与 Pull Request 共同完善生态！

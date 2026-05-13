# 钉钉扫码登录验证指南

> 适用范围：改动 [`extensions/dingtalk-connector`](../../extensions/dingtalk-connector)
> 的扫码链路（[`device-auth.ts`](../../extensions/dingtalk-connector/src/device-auth.ts)、
> onboarding 向导、`qrcode-terminal` 集成）后，证明 QR 登录仍然可用。
>
> 英文主本：[`dingtalk-qr-verification.md`](./dingtalk-qr-verification.md)（source of truth）。

## 1. 背景

钉钉设备授权握手三步：`init → begin → poll`；CLI 把
`verification_uri_complete` 通过 `qrcode-terminal` 渲染为终端二维码。已知回归：

- `renderQrCodeText` 曾解构 `qr.generate`，导致 `this` 丢失。`qrcode-terminal`
  内部用 `this.error` 读取纠错等级，变成 `undefined` 后 `generate` 抛错被
  `catch` 吞掉，向导悄悄降级成纯 URL。

## 2. 单元测试（最快，约 8 秒）

```bash
pnpm test extensions/dingtalk-connector/src/device-auth.test.ts
```

期望：2 passed。测试
（见 [`device-auth.test.ts`](../../extensions/dingtalk-connector/src/device-auth.test.ts)）
断言 `renderQrCodeText` 返回非 null、包含方块字符的字符串，并且两次不同入参产出不同矩阵。

反证（可选）：把 `qr.generate` 改回解构形式，两条用例都应报
`expected null not to be null`；提交前改回方法调用。

## 3. 端到端脚本（真连钉钉，对齐向导体验）

```bash
pnpm build
node scripts/verify-dingtalk-qr.mjs
```

> 注意：`node scripts/...` 是相对路径，必须先 `cd` 到 openclaw 仓根目录。
> 如果在 `dingtalk-openclaw-connector` 等别的仓里执行，会抛 `Cannot find module`。

脚本（见 [`scripts/verify-dingtalk-qr.mjs`](../../scripts/verify-dingtalk-qr.mjs)）
调用 `beginDingtalkRegistration` 输出 `userCode` / `verification_uri_complete`，
渲染二维码到 stdout，随后**持续 poll 直到用户真正扫码完成**——对齐 onboarding
向导与飞书 `pollAppRegistration` 的体验。凭证返回后只打印脱敏值，**不落盘**；`Ctrl+C`
随时可以优雅中止。

通过标准：

- `beginDingtalkRegistration()` 约 1 秒内返回带有 `userCode`（如 `QUJ2-2DUY-Y3PG`）。
- `renderQrCodeText()` 打出约 39 列、由 `▀▄█` 组成的二维码块。
- 移动端扫码授权后，`[4/4] authorized!` 输出脱敏的 `clientId` / `clientSecret`
  和总耗时。

失败信号：

- HTTP 错误 → 检查是否能访问 `api.dingtalk.com`。
- 输出 `(QR rendering returned empty...)` → `renderQrCodeText` 返回 null，
  排查 `device-auth.ts` 的 `this` 绑定并重新 build。
- `authorization timeout` → `device_code` 在扫码前已过期，重跑脚本即可。

## 4. 真实 CLI 扫码（完整路径）

```bash
OPENCLAW_HOME=/tmp/openclaw-dingtalk-qa node openclaw.mjs configure --section channels
```

在向导里选 **`DingTalk (钉钉)`**（展示名，其 plugin id 是 `dingtalk-connector`），终端会渲染二维码；用钉钉 App 扫码授权后，
CLI 自动写入 `$OPENCLAW_HOME/credentials/dingtalk-connector/<accountId>.json`。

随后执行 `node openclaw.mjs gateway restart` 与
`node openclaw.mjs channels probe dingtalk-connector` 确认新凭证能连通。
注意：`channels login --channel dingtalk-connector` **不可用**，本插件未实现
`auth.login`，扫码路径只在 `configure` 向导里提供。

## 5. 回归清单

改动 `extensions/dingtalk-connector/src/device-auth.ts` 落地前：

- [ ] `pnpm test extensions/dingtalk-connector/src/device-auth.test.ts` 通过。
- [ ] `pnpm build` 成功；`dist/extensions/dingtalk-connector/api.js` 含 `renderQrCodeText`。
- [ ] `node scripts/verify-dingtalk-qr.mjs` 打出真实二维码。
- [ ] `pnpm test:changed` 命中本 lane 且为绿。

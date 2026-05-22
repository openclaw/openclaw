# ClaWorks Extension 物理裁剪

工业 Fork 保留 `contrib/claworks-product.plugins.allow.json` 白名单内的扩展；其余消费级/娱乐/迁移类扩展从 `extensions/` **物理删除**以减小仓体积。

## 执行

```bash
pnpm claworks:prune-extensions          # 预览
pnpm claworks:prune-extensions:apply    # 删除目录（幂等）
```

清单：`contrib/claworks-extensions-prune.json`（Phase 1: **14**；Phase 2 累计 **27**，另 **deferred** 2 个待确认）。

## 已裁剪

**Phase 1（14）**：`comfy`, `imessage`, `inworld`, `line`, `migrate-claude`, `migrate-hermes`, `nostr`, `phone-control`, `qqbot`, `tlon`, `twitch`, `zalo`, `zalouser`, `video-generation-core`

**Phase 2（+13，Feishu-first 个人企业）**：`discord`, `telegram`, `slack`, `msteams`, `matrix`, `nextcloud-talk`, `mattermost`, `signal`, `whatsapp`, `bluebubbles`, `irc`, `google-chat`, `voice-call`

**Deferred（暂不删）**：`wechat`, `google-meet` — 若你后续要接微信或 Google Meet 插件则保留目录。

## 保留（工业核心）

见 `FORK-MODIFICATION-PLAN.md` §2.1：`claworks-robot`, `feishu`, `telegram`, `discord`, `webhooks`, `memory-core`, `memory-lancedb`, `skill-workshop`, LLM 提供商, `file-transfer`, `document-extract`, 诊断, `qa-*` 等。

## 测试适配

- `message-turn-guardrails.test.ts` 仅检查**仍存在于磁盘**的 channel 文件
- `vitest.extension-zalo-paths.mjs` 置空（zalo 已删）
- `vitest.extension-media-paths.mjs` 去掉 `video-generation-core`

从上游同步 OpenClaw 时，勿把已裁剪扩展目录无审查地合并回来；需要时在 `claworks-extensions-prune.json` 中维护清单后重跑 `--apply`。

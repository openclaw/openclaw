# DingTalk QR Login – Verification Guide

> Scope: prove the DingTalk QR device-auth path (`extensions/dingtalk-connector`)
> still works after bug fixes. Use this when touching
> [`device-auth.ts`](../../extensions/dingtalk-connector/src/device-auth.ts),
> the onboarding wizard, or the `qrcode-terminal` integration.
>
> A Chinese mirror is available at [`dingtalk-qr-verification.zh-CN.md`](./dingtalk-qr-verification.zh-CN.md).

## 1. Background

DingTalk registration uses a three-step handshake: `init` → `begin` → `poll`.
The CLI renders the `verification_uri_complete` as a terminal QR code via
`qrcode-terminal`. Past regressions:

- `renderQrCodeText` destructured `qr.generate`, losing the `this` binding.
  `qrcode-terminal` reads `this.error` internally, so the error-correct level
  becomes `undefined`, `generate` throws, the `catch` swallows it, and the
  wizard silently falls back to a plain URL.

## 2. Unit tests (fastest, ~8s)

```bash
pnpm test extensions/dingtalk-connector/src/device-auth.test.ts
```

Expected: 2 passed. The suite (see
[`device-auth.test.ts`](../../extensions/dingtalk-connector/src/device-auth.test.ts))
asserts `renderQrCodeText` returns a non-null, block-character-containing
string and that repeated calls with different payloads produce different
matrices.

Negative proof (optional): temporarily destructure `qr.generate` again; both
tests must fail with `expected null not to be null`. Restore the method call
before committing.

## 3. End-to-end script (real DingTalk, mirrors the wizard)

```bash
pnpm build
node scripts/verify-dingtalk-qr.mjs
```

> Note: `node scripts/...` is a relative path — run it from the `openclaw`
> repo root. Running it from a sibling checkout such as
> `dingtalk-openclaw-connector` raises `Cannot find module`.

The script (see [`scripts/verify-dingtalk-qr.mjs`](../../scripts/verify-dingtalk-qr.mjs))
calls `beginDingtalkRegistration`, prints the returned `userCode` /
`verification_uri_complete`, renders the QR to stdout, then **polls until the
user actually scans** — identical to the onboarding wizard path and the
Feishu `pollAppRegistration` experience. Credentials are printed masked and
are **not persisted**; `Ctrl+C` aborts cleanly.

Pass criteria:

- `beginDingtalkRegistration()` returns within ~1s with a `userCode`
  (e.g. `QUJ2-2DUY-Y3PG`).
- `renderQrCodeText()` prints a ~39-column QR block made of `▀▄█`.
- After a mobile scan + authorize, `[4/4] authorized!` prints a masked
  `clientId` / `clientSecret` pair and the total elapsed time.

Failure signals:

- HTTP errors → check outbound access to `api.dingtalk.com`.
- `(QR rendering returned empty...)` → `renderQrCodeText` returned null;
  inspect `device-auth.ts` for the `this` binding and rebuild.
- `authorization timeout` → the `device_code` expired before a scan;
  rerun the script.

## 4. Real CLI scan (full path)

```bash
OPENCLAW_HOME=/tmp/openclaw-dingtalk-qa node openclaw.mjs configure --section channels
```

In the wizard, pick **`DingTalk (钉钉)`** (display name — the underlying
plugin id is `dingtalk-connector`). The wizard renders a QR in the terminal. Scan with
the DingTalk mobile app, approve the application, and the CLI writes
`$OPENCLAW_HOME/credentials/dingtalk-connector/<accountId>.json`.

Then run `node openclaw.mjs gateway restart` and
`node openclaw.mjs channels probe dingtalk-connector` to confirm the new
credentials connect. `channels login --channel dingtalk-connector` is **not**
supported — the plugin does not implement `auth.login` and the QR path lives
inside the `configure` wizard.

## 5. Regression checklist

Before landing changes to `extensions/dingtalk-connector/src/device-auth.ts`:

- [ ] `pnpm test extensions/dingtalk-connector/src/device-auth.test.ts` passes.
- [ ] `pnpm build` succeeds; `dist/extensions/dingtalk-connector/api.js` contains `renderQrCodeText`.
- [ ] `node scripts/verify-dingtalk-qr.mjs` prints a real QR block.
- [ ] `pnpm test:changed` picks up the touched test lane and stays green.

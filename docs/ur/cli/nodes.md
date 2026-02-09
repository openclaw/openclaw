---
summary: "`openclaw nodes` کے لیے CLI حوالہ (list/status/approve/invoke، camera/canvas/screen)"
read_when:
  - آپ جوڑے گئے نوڈز (کیمرے، اسکرین، کینوس) کا انتظام کر رہے ہوں
  - آپ کو درخواستوں کی منظوری دینی ہو یا نوڈ کمانڈز چلانی ہوں
title: "نوڈز"
---

# `openclaw nodes`

جوڑے گئے نوڈز (ڈیوائسز) کا انتظام کریں اور نوڈ کی صلاحیتیں استعمال کریں۔

متعلقہ:

- نوڈز کا جائزہ: [Nodes](/nodes)
- کیمرہ: [Camera nodes](/nodes/camera)
- تصاویر: [Image nodes](/nodes/images)

عام اختیارات:

- `--url`, `--token`, `--timeout`, `--json`

## عام کمانڈز

```bash
openclaw nodes list
openclaw nodes list --connected
openclaw nodes list --last-connected 24h
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes status
openclaw nodes status --connected
openclaw nodes status --last-connected 24h
```

`nodes list` زیر التواء/جوڑے گئے ٹیبلز پرنٹ کرتا ہے۔ جوڑے گئے قطاروں میں تازہ ترین کنکشن کی عمر شامل ہوتی ہے (Last Connect)۔
صرف اس وقت جڑے ہوئے نوڈز دکھانے کے لیے `--connected` استعمال کریں۔ مدت کے اندر کنیکٹ ہونے والے نوڈز تک فلٹر کرنے کے لیے `--last-connected <duration>` استعمال کریں (مثلاً `24h`, `7d`)۔

## Invoke / run

```bash
openclaw nodes invoke --node <id|name|ip> --command <command> --params <json>
openclaw nodes run --node <id|name|ip> <command...>
openclaw nodes run --raw "git status"
openclaw nodes run --agent main --node <id|name|ip> --raw "git status"
```

Invoke فلیگز:

- `--params <json>`: JSON آبجیکٹ اسٹرنگ (بطورِ طے شدہ `{}`)۔
- `--invoke-timeout <ms>`: نوڈ invoke ٹائم آؤٹ (بطورِ طے شدہ `15000`)۔
- `--idempotency-key <key>`: اختیاری idempotency key۔

### Exec-style defaults

`nodes run` ماڈل کے exec رویّے (ڈیفالٹس + منظوریات) کی عکاسی کرتا ہے:

- `tools.exec.*` پڑھتا ہے (مزید `agents.list[].tools.exec.*` اووررائیڈز کے ساتھ)۔
- `system.run` کو invoke کرنے سے پہلے exec منظوریات (`exec.approval.request`) استعمال کرتا ہے۔
- جب `tools.exec.node` سیٹ ہو تو `--node` کو چھوڑا جا سکتا ہے۔
- ایسے نوڈ کی ضرورت ہوتی ہے جو `system.run` کی تشہیر کرے (macOS companion app یا headless node host)۔

فلیگز:

- `--cwd <path>`: ورکنگ ڈائریکٹری۔
- `--env <key=val>`: env اووررائیڈ (دہرایا جا سکتا ہے)۔
- `--command-timeout <ms>`: کمانڈ ٹائم آؤٹ۔
- `--invoke-timeout <ms>`: نوڈ invoke ٹائم آؤٹ (بطورِ طے شدہ `30000`)۔
- `--needs-screen-recording`: اسکرین ریکارڈنگ اجازت درکار ہو۔
- `--raw <command>`: شیل اسٹرنگ چلائیں (`/bin/sh -lc` یا `cmd.exe /c`)۔
- `--agent <id>`: ایجنٹ-اسکوپڈ منظوریات/allowlists (کنفیگر شدہ ایجنٹ بطورِ طے شدہ)۔
- `--ask <off|on-miss|always>`, `--security <deny|allowlist|full>`: اووررائیڈز۔

---
summary: "SSH سرنگوں (Gateway WS) اور ٹیل نیٹس کے ذریعے ریموٹ رسائی"
read_when:
  - ریموٹ گیٹ وے سیٹ اپس چلانے یا ان کی خرابیوں کا ازالہ کرتے وقت
title: "ریموٹ رسائی"
---

# ریموٹ رسائی (SSH، سرنگیں، اور ٹیل نیٹس)

یہ ریپو ایک واحد Gateway (ماسٹر) کو کسی مخصوص ہوسٹ (ڈیسک ٹاپ/سرور) پر مسلسل چلتے رہنے دیتا ہے اور کلائنٹس کو اس سے جوڑ کر “remote over SSH” کو سپورٹ کرتا ہے۔

- **آپریٹرز (آپ / macOS ایپ)** کے لیے: SSH ٹنلنگ عالمی بیک اپ طریقہ ہے۔
- **نوڈز (iOS/Android اور آئندہ ڈیوائسز)** کے لیے: Gateway **WebSocket** سے جڑیں (LAN/ٹیل نیٹ یا ضرورت کے مطابق SSH سرنگ)۔

## بنیادی تصور

- Gateway WebSocket آپ کے متعین پورٹ پر **loopback** سے بندھتا ہے (بطورِ طے شدہ 18789)۔
- ریموٹ استعمال کے لیے، اس loopback پورٹ کو SSH کے ذریعے فارورڈ کریں (یا ٹیل نیٹ/VPN استعمال کریں اور کم ٹنلنگ کریں)۔

## عام VPN/ٹیل نیٹ سیٹ اپس (جہاں ایجنٹ رہتا ہے)

Think of the **Gateway host** as “where the agent lives.” It owns sessions, auth profiles, channels, and state.
Your laptop/desktop (and nodes) connect to that host.

### 1. آپ کے ٹیل نیٹ میں ہمیشہ آن Gateway (VPS یا گھریلو سرور)

Gateway کو کسی مستقل ہوسٹ پر چلائیں اور **Tailscale** یا SSH کے ذریعے اس تک رسائی حاصل کریں۔

- **بہترین UX:** `gateway.bind: "loopback"` کو برقرار رکھیں اور کنٹرول UI کے لیے **Tailscale Serve** استعمال کریں۔
- **بیک اپ:** loopback برقرار رکھیں + جس مشین کو رسائی چاہیے اس سے SSH سرنگ۔
- **مثالیں:** [exe.dev](/install/exe-dev) (آسان VM) یا [Hetzner](/install/hetzner) (پروڈکشن VPS)۔

یہ اس وقت مثالی ہے جب آپ کا لیپ ٹاپ اکثر سلیپ میں جاتا ہو لیکن آپ ایجنٹ کو ہمیشہ آن رکھنا چاہتے ہوں۔

### 2. گھریلو ڈیسک ٹاپ Gateway چلاتا ہے، لیپ ٹاپ ریموٹ کنٹرول ہے

29. لیپ ٹاپ agent نہیں چلاتا۔ 30. یہ ریموٹ طریقے سے کنیکٹ ہوتا ہے:

- macOS ایپ کے **Remote over SSH** موڈ کا استعمال کریں (Settings → General → “OpenClaw runs”)۔
- ایپ سرنگ کو خود کھولتی اور مینیج کرتی ہے، لہٰذا WebChat + ہیلتھ چیکس خود بخود کام کرتے ہیں۔

رن بک: [macOS ریموٹ رسائی](/platforms/mac/remote)۔

### 3. لیپ ٹاپ Gateway چلاتا ہے، دوسری مشینوں سے ریموٹ رسائی

Gateway کو لوکل رکھیں مگر محفوظ طریقے سے ایکسپوز کریں:

- دوسری مشینوں سے لیپ ٹاپ تک SSH سرنگ، یا
- Tailscale Serve کے ذریعے کنٹرول UI اور Gateway کو صرف loopback پر رکھیں۔

گائیڈ: [Tailscale](/gateway/tailscale) اور [ویب جائزہ](/web)۔

## کمانڈ فلو (کیا کہاں چلتا ہے)

31. ایک گیٹ وے سروس اسٹیٹ + چینلز کی مالک ہوتی ہے۔ 32. Nodes پیریفیرلز ہوتے ہیں۔

فلو کی مثال (Telegram → نوڈ):

- Telegram پیغام **Gateway** پر آتا ہے۔
- Gateway **agent** چلاتا ہے اور فیصلہ کرتا ہے کہ آیا نوڈ ٹول کو کال کرنا ہے۔
- Gateway، Gateway WebSocket (`node.*` RPC) کے ذریعے **نوڈ** کو کال کرتا ہے۔
- نوڈ نتیجہ واپس کرتا ہے؛ Gateway جواب Telegram کو واپس بھیج دیتا ہے۔

نوٹس:

- **نوڈز gateway سروس نہیں چلاتے۔** فی ہوسٹ صرف ایک gateway چلنا چاہیے، الا یہ کہ آپ جان بوجھ کر علیحدہ پروفائلز چلائیں (دیکھیں [Multiple gateways](/gateway/multiple-gateways))۔
- macOS ایپ کا “node mode” دراصل Gateway WebSocket کے اوپر ایک نوڈ کلائنٹ ہے۔

## SSH سرنگ (CLI + ٹولز)

ریموٹ Gateway WS کے لیے ایک لوکل سرنگ بنائیں:

```bash
ssh -N -L 18789:127.0.0.1:18789 user@host
```

سرنگ فعال ہونے کے بعد:

- `openclaw health` اور `openclaw status --deep` اب `ws://127.0.0.1:18789` کے ذریعے ریموٹ gateway تک پہنچتے ہیں۔
- `openclaw gateway {status,health,send,agent,call}` ضرورت پڑنے پر `--url` کے ذریعے فارورڈ شدہ URL کو بھی ہدف بنا سکتا ہے۔

33. نوٹ: `18789` کو اپنی کنفیگرڈ `gateway.port` (یا `--port`/`OPENCLAW_GATEWAY_PORT`) سے بدل دیں۔
34. نوٹ: جب آپ `--url` پاس کرتے ہیں، تو CLI کنفیگ یا ماحولیات کی کریڈینشلز پر واپس نہیں جاتا۔
35. `--token` یا `--password` کو واضح طور پر شامل کریں۔ 36. واضح کریڈینشلز کا نہ ہونا ایک ایرر ہے۔

## CLI ریموٹ ڈیفالٹس

آپ ایک ریموٹ ہدف محفوظ کر سکتے ہیں تاکہ CLI کمانڈز بطورِ طے شدہ اسی کو استعمال کریں:

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://127.0.0.1:18789",
      token: "your-token",
    },
  },
}
```

جب gateway صرف loopback پر ہو، URL کو `ws://127.0.0.1:18789` پر رکھیں اور پہلے SSH سرنگ کھولیں۔

## SSH کے ذریعے چیٹ UI

37. WebChat اب علیحدہ HTTP پورٹ استعمال نہیں کرتا۔ 38. SwiftUI چیٹ UI براہِ راست گیٹ وے WebSocket سے کنیکٹ ہوتی ہے۔

- `18789` کو SSH کے ذریعے فارورڈ کریں (اوپر دیکھیں)، پھر کلائنٹس کو `ws://127.0.0.1:18789` سے جوڑیں۔
- macOS پر ایپ کے “Remote over SSH” موڈ کو ترجیح دیں، جو سرنگ کو خودکار طور پر مینیج کرتا ہے۔

## macOS ایپ “Remote over SSH”

macOS مینو بار ایپ یہی سیٹ اپ مکمل طور پر اینڈ ٹو اینڈ چلا سکتی ہے (ریموٹ اسٹیٹس چیکس، WebChat، اور Voice Wake فارورڈنگ)۔

رن بک: [macOS ریموٹ رسائی](/platforms/mac/remote)۔

## سکیورٹی قواعد (ریموٹ/VPN)

مختصر خلاصہ: **Gateway کو loopback تک محدود رکھیں** جب تک آپ کو بائنڈ کی یقیناً ضرورت نہ ہو۔

- **Loopback + SSH/Tailscale Serve** سب سے محفوظ ڈیفالٹ ہے (کوئی عوامی ایکسپوژر نہیں)۔
- **Non-loopback binds** (`lan`/`tailnet`/`custom`، یا `auto` جب loopback دستیاب نہ ہو) میں auth ٹوکنز/پاس ورڈز لازم ہیں۔
- `gateway.remote.token` **صرف** ریموٹ CLI کالز کے لیے ہے — یہ لوکل auth کو فعال **نہیں** کرتا۔
- `gateway.remote.tlsFingerprint`، `wss://` استعمال کرتے وقت ریموٹ TLS سرٹیفکیٹ کو پن کرتا ہے۔
- 39. **Tailscale Serve** شناختی ہیڈرز کے ذریعے تصدیق کر سکتا ہے جب `gateway.auth.allowTailscale: true` ہو۔
  40. اگر آپ ٹوکنز/پاس ورڈز چاہتے ہیں تو اسے `false` پر سیٹ کریں۔
- براؤزر کنٹرول کو آپریٹر رسائی کی طرح سمجھیں: صرف ٹیل نیٹ + دانستہ نوڈ جوڑی بنانا۔

تفصیلی جائزہ: [Security](/gateway/security)۔

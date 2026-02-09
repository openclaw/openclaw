---
summary: "WKWebView + custom URL scheme ဖြင့် ထည့်သွင်းထားသော agent ထိန်းချုပ် Canvas panel"
read_when:
  - macOS Canvas panel ကို အကောင်အထည်ဖော်နေချိန်
  - မြင်ကွင်းအလုပ်လုပ်ရာနေရာအတွက် agent ထိန်းချုပ်မှုများ ထည့်သွင်းနေချိန်
  - WKWebView canvas load ပြဿနာများကို Debug လုပ်နေချိန်
title: "Canvas"
---

# Canvas (macOS app)

25. macOS app သည် agent ထိန်းချုပ်သော **Canvas panel** ကို `WKWebView` ဖြင့် ထည့်သွင်းထားပါသည်။ 26. ၎င်းသည် HTML/CSS/JS, A2UI နှင့် အသေးစား interactive UI surface များအတွက် ပေါ့ပါးသော visual workspace ဖြစ်သည်။

## Canvas တည်ရှိရာနေရာ

Canvas state ကို Application Support အောက်တွင် သိမ်းဆည်းထားသည် —

- `~/Library/Application Support/OpenClaw/canvas/<session>/...`

Canvas panel သည် အဆိုပါ ဖိုင်များကို **custom URL scheme** ဖြင့် ဝန်ဆောင်မှုပေးသည် —

- `openclaw-canvas://<session>/<path>`

ဥပမာများ —

- `openclaw-canvas://main/` → `<canvasRoot>/main/index.html`
- `openclaw-canvas://main/assets/app.css` → `<canvasRoot>/main/assets/app.css`
- `openclaw-canvas://main/widgets/todo/` → `<canvasRoot>/main/widgets/todo/index.html`

root တွင် `index.html` မရှိပါက app သည် **built‑in scaffold page** ကို ပြသမည်ဖြစ်သည်။

## Panel အပြုအမူ

- Border မပါဘဲ အရွယ်အစားပြောင်းနိုင်သော panel ဖြစ်ပြီး menu bar (သို့) mouse cursor အနီးတွင် ချိတ်ထားသည်။
- session တစ်ခုချင်းစီအလိုက် အရွယ်အစား/တည်နေရာကို မှတ်မိထားသည်။
- local canvas ဖိုင်များ ပြောင်းလဲသည့်အခါ အလိုအလျောက် reload လုပ်သည်။
- Canvas panel ကို တစ်ကြိမ်တွင် တစ်ခုတည်းသာ မြင်ရပြီး (လိုအပ်ပါက session ကို ပြောင်းလဲသည်)။

27. Canvas ကို Settings → **Allow Canvas** မှ ပိတ်နိုင်ပါသည်။ 28. ပိတ်ထားပါက canvas node command များသည် `CANVAS_DISABLED` ကို ပြန်ပေးပါသည်။

## Agent API surface

Canvas ကို **Gateway WebSocket** မှတဆင့် ထုတ်ဖော်ထားသောကြောင့် agent သည် အောက်ပါများကို လုပ်ဆောင်နိုင်သည် —

- panel ကို ပြ/ဖျောက်
- path သို့မဟုတ် URL သို့ သွားလာ
- JavaScript ကို evaluate လုပ်
- snapshot image ကို ဖမ်းယူ

CLI ဥပမာများ —

```bash
openclaw nodes canvas present --node <id>
openclaw nodes canvas navigate --node <id> --url "/"
openclaw nodes canvas eval --node <id> --js "document.title"
openclaw nodes canvas snapshot --node <id>
```

မှတ်ချက်များ —

- `canvas.navigate` သည် **local canvas paths** များ၊ `http(s)` URLs နှင့် `file://` URLs များကို လက်ခံသည်။
- `"/"` ကို ပို့ပါက Canvas သည် local scaffold သို့မဟုတ် `index.html` ကို ပြသမည်ဖြစ်သည်။

## Canvas အတွင်းရှိ A2UI

A2UI is hosted by the Gateway canvas host and rendered inside the Canvas panel.
30. Gateway သည် Canvas host ကို ကြော်ငြာပေးသောအခါ macOS app သည် ပထမဆုံး ဖွင့်ချိန်တွင် A2UI host စာမျက်နှာသို့ အလိုအလျောက် သွားရောက်ပါသည်။

မူလ A2UI host URL —

```
http://<gateway-host>:18793/__openclaw__/a2ui/
```

### A2UI အမိန့်များ (v0.8)

Canvas သည် လက်ရှိတွင် **A2UI v0.8** server→client မက်ဆေ့ချ်များကို လက်ခံသည် —

- `beginRendering`
- `surfaceUpdate`
- `dataModelUpdate`
- `deleteSurface`

`createSurface` (v0.9) ကို မပံ့ပိုးပါ။

CLI ဥပမာ —

```bash
cat > /tmp/a2ui-v0.8.jsonl <<'EOFA2'
{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"root","component":{"Column":{"children":{"explicitList":["title","content"]}}}},{"id":"title","component":{"Text":{"text":{"literalString":"Canvas (A2UI v0.8)"},"usageHint":"h1"}}},{"id":"content","component":{"Text":{"text":{"literalString":"If you can read this, A2UI push works."},"usageHint":"body"}}}]}}
{"beginRendering":{"surfaceId":"main","root":"root"}}
EOFA2

openclaw nodes canvas a2ui push --jsonl /tmp/a2ui-v0.8.jsonl --node <id>
```

Quick smoke —

```bash
openclaw nodes canvas a2ui push --node <id> --text "Hello from A2UI"
```

## Canvas မှ agent run များကို စတင်လုပ်ဆောင်ခြင်း

Canvas သည် deep links များမှတဆင့် agent run အသစ်များကို စတင်နိုင်သည် —

- `openclaw://agent?...`

ဥပမာ (JS အတွင်း) —

```js
window.location.href = "openclaw://agent?message=Review%20this%20design";
```

မှန်ကန်သော key မပေးထားပါက app သည် အတည်ပြုချက်ကို မေးမြန်းမည်ဖြစ်သည်။

## လုံခြုံရေး ဆိုင်ရာ မှတ်ချက်များ

- Canvas scheme သည် directory traversal ကို တားဆီးထားပြီး ဖိုင်များသည် session root အောက်တွင်သာ ရှိရမည်။
- Local Canvas content သည် custom scheme ကို အသုံးပြုထားပြီး (loopback server မလိုအပ်ပါ)။
- External `http(s)` URLs များကို တိတိကျကျ navigate လုပ်ထားသည့်အခါတွင်သာ ခွင့်ပြုသည်။

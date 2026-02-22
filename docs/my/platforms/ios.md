---
summary: "iOS နိုဒ် အက်ပ်—Gateway သို့ ချိတ်ဆက်ခြင်း၊ pairing၊ canvas နှင့် ပြဿနာဖြေရှင်းခြင်း"
read_when:
  - iOS နိုဒ်ကို pairing ပြန်လုပ်ရန် သို့မဟုတ် ပြန်လည်ချိတ်ဆက်ရန်
  - iOS အက်ပ်ကို source မှ chạy/run လုပ်ရန်
  - gateway discovery သို့မဟုတ် canvas commands များကို debug လုပ်ရန်
title: "iOS App"
---

# iOS App (Node)

Availability: internal preview. 2. iOS app ကို အများပြည်သူအတွက် မဖြန့်ချိသေးပါ။

## ဘာလုပ်ပေးသလဲ

- WebSocket ဖြင့် Gateway သို့ ချိတ်ဆက်သည် (LAN သို့မဟုတ် tailnet)။
- နိုဒ်၏ စွမ်းဆောင်ရည်များကို ဖော်ထုတ်ပေးသည်: Canvas၊ Screen snapshot၊ Camera capture၊ Location၊ Talk mode၊ Voice wake။
- `node.invoke` အမိန့်များကို လက်ခံပြီး နိုဒ် အခြေအနေ ဖြစ်ရပ်များကို တင်ပြသည်။

## လိုအပ်ချက်များ

- အခြား စက်တစ်ခုတွင် Gateway ကို chạy/run လုပ်ထားရမည် (macOS၊ Linux၊ သို့မဟုတ် Windows via WSL2)။
- ကွန်ယက် လမ်းကြောင်း:
  - Bonjour ဖြင့် တူညီသော LAN၊ **သို့မဟုတ်**
  - unicast DNS-SD ဖြင့် Tailnet (ဥပမာ domain: `openclaw.internal.`)၊ **သို့မဟုတ်**
  - Manual host/port (fallback)။

## Quick start (pair + connect)

1. Gateway ကို စတင်ပါ:

```bash
openclaw gateway --port 18789
```

2. iOS အက်ပ်တွင် Settings ကို ဖွင့်ပြီး ရှာဖွေတွေ့ရှိထားသော gateway တစ်ခုကို ရွေးပါ (သို့မဟုတ် Manual Host ကို ဖွင့်ပြီး host/port ကို ထည့်ပါ)။

3. gateway host ပေါ်တွင် pairing တောင်းဆိုမှုကို အတည်ပြုပါ:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

4. ချိတ်ဆက်မှုကို အတည်ပြုပါ:

```bash
openclaw nodes status
openclaw gateway call node.list --params "{}"
```

## Discovery paths

### Bonjour (LAN)

3. Gateway သည် `local.` ပေါ်တွင် `_openclaw-gw._tcp` ကို ကြော်ငြာပေးသည်။ The iOS app lists these automatically.

### Tailnet (ကွန်ယက်ကူးလွန်)

5. mDNS ကို ပိတ်ထားပါက unicast DNS-SD zone ကို အသုံးပြုပါ (domain တစ်ခု ရွေးချယ်ပါ; ဥပမာ: `openclaw.internal.`) နှင့် Tailscale split DNS ကို အသုံးပြုပါ။
   See [Bonjour](/gateway/bonjour) for the CoreDNS example.

### Manual host/port

Settings တွင် **Manual Host** ကို ဖွင့်ပြီး gateway host + port ကို ထည့်ပါ (ပုံမှန် `18789`)။

## Canvas + A2UI

7. iOS node သည် WKWebView canvas ကို render လုပ်ပေးသည်။ 8. ၎င်းကို မောင်းနှင်ရန် `node.invoke` ကို အသုံးပြုပါ:

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.navigate --params '{"url":"http://<gateway-host>:18793/__openclaw__/canvas/"}'
```

မှတ်ချက်များ:

- Gateway canvas host သည် `/__openclaw__/canvas/` နှင့် `/__openclaw__/a2ui/` ကို serve လုပ်ပါသည်။
- canvas host URL ကို ကြော်ငြာထားပါက ချိတ်ဆက်ချိန်တွင် iOS နိုဒ်သည် A2UI သို့ အလိုအလျောက် သွားရောက်ပါသည်။
- built-in scaffold သို့ ပြန်ရန် `canvas.navigate` နှင့် `{"url":""}` ကို အသုံးပြုပါ။

### Canvas eval / snapshot

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.eval --params '{"javaScript":"(() => { const {ctx} = window.__openclaw; ctx.clearRect(0,0,innerWidth,innerHeight); ctx.lineWidth=6; ctx.strokeStyle=\"#ff2d55\"; ctx.beginPath(); ctx.moveTo(40,40); ctx.lineTo(innerWidth-40, innerHeight-40); ctx.stroke(); return \"ok\"; })()"}'
```

```bash
openclaw nodes invoke --node "iOS Node" --command canvas.snapshot --params '{"maxWidth":900,"format":"jpeg"}'
```

## Voice wake + talk mode

- Voice wake နှင့် talk mode ကို Settings တွင် ရရှိနိုင်ပါသည်။
- iOS သည် နောက်ခံအသံကို ရပ်ဆိုင်းနိုင်သောကြောင့် အက်ပ် မဖွင့်ထားချိန်တွင် voice အင်္ဂါရပ်များကို best-effort အဖြစ်သာ သဘောထားပါ။

## Common errors

- `NODE_BACKGROUND_UNAVAILABLE`: iOS အက်ပ်ကို foreground သို့ ယူလာပါ (canvas/camera/screen အမိန့်များအတွက် လိုအပ်ပါသည်)။
- `A2UI_HOST_NOT_CONFIGURED`: Gateway မှ canvas host URL ကို မကြော်ငြာထားပါ; [Gateway configuration](/gateway/configuration) တွင် `canvasHost` ကို စစ်ဆေးပါ။
- Pairing prompt မပေါ်လာပါက: `openclaw nodes pending` ကို chạy/run လုပ်ပြီး လက်ဖြင့် အတည်ပြုပါ။
- Reinstall ပြီးနောက် reconnect မအောင်မြင်ပါက: Keychain pairing token ကို ဖျက်ရှားထားပြီးဖြစ်သည်; နိုဒ်ကို ပြန်လည် pair လုပ်ပါ။

## Related docs

- [Pairing](/gateway/pairing)
- [Discovery](/gateway/discovery)
- [Bonjour](/gateway/bonjour)

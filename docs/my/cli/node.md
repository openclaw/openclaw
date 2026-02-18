---
summary: "`openclaw node` အတွက် CLI ရည်ညွှန်းချက် (headless node host)"
read_when:
  - headless node host ကို လည်ပတ်နေစဉ်
  - system.run အတွက် macOS မဟုတ်သော node ကို တွဲချိတ်နေစဉ်
title: "node"
---

# `openclaw node`

Gateway WebSocket သို့ ချိတ်ဆက်ပြီး ဤစက်ပေါ်တွင်
`system.run` / `system.which` ကို ဖော်ထုတ်ပေးသော **headless node host** ကို လည်ပတ်ပါ။

## node host ကို ဘာကြောင့် အသုံးပြုသင့်သလဲ။

သင့်ကွန်ယက်အတွင်းရှိ အခြားစက်များပေါ်တွင် **အမိန့်များကို လည်ပတ်စေလို** သော်လည်း
အပြည့်အစုံ macOS companion app ကို မတပ်ဆင်လိုသည့်အခါ node host ကို အသုံးပြုပါ။

အသုံးများသော အမှုအသုံးပြုမှုများ—

- အဝေးရှိ Linux/Windows စက်များ (build servers, lab machines, NAS) ပေါ်တွင် အမိန့်များကို လည်ပတ်ရန်။
- exec ကို gateway ပေါ်တွင် **sandboxed** အဖြစ် ထိန်းထားပြီး အတည်ပြုထားသော လည်ပတ်မှုများကို အခြား ဟို့စ်များသို့ လွှဲပေးရန်။
- အလိုအလျောက်လုပ်ဆောင်မှုများ သို့မဟုတ် CI node များအတွက် ပေါ့ပါးပြီး headless လည်ပတ်ရေး ပစ်မှတ်ကို ပံ့ပိုးရန်။

လည်ပတ်မှုများအားလုံးကို node host ပေါ်ရှိ **exec approvals** နှင့် အေးဂျင့်တစ်ခုချင်းစီအလိုက် allowlist များဖြင့် ဆက်လက်ကာကွယ်ထားသဖြင့် အမိန့်ဝင်ရောက်ခွင့်ကို ကန့်သတ်၍ ပြတ်သားစွာ ထိန်းချုပ်နိုင်ပါသည်။

## Browser proxy (zero-config)

Node တွင် `browser.enabled` ကို ပိတ်မထားပါက node hosts များသည် browser proxy ကို အလိုအလျောက် ကြော်ငြာပါသည်။ ထိုအရာကြောင့် agent သည် ထို node ပေါ်တွင် browser automation ကို ထပ်မံ configure မလုပ်ဘဲ အသုံးပြုနိုင်ပါသည်။

လိုအပ်ပါက node ပေါ်တွင် ပိတ်နိုင်ပါသည်—

```json5
{
  nodeHost: {
    browserProxy: {
      enabled: false,
    },
  },
}
```

## Run (foreground)

```bash
openclaw node run --host <gateway-host> --port 18789
```

Options:

- `--host <host>`: Gateway WebSocket ဟို့စ် (မူလတန်ဖိုး: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket ပေါက် (မူလတန်ဖိုး: `18789`)
- `--tls`: gateway ချိတ်ဆက်မှုအတွက် TLS ကို အသုံးပြုရန်
- `--tls-fingerprint <sha256>`: မျှော်မှန်းထားသော TLS လက်မှတ် fingerprint (sha256)
- `--node-id <id>`: node id ကို အစားထိုးသတ်မှတ်ရန် (pairing token ကို ရှင်းလင်းသည်)
- `--display-name <name>`: node ပြသအမည်ကို အစားထိုးသတ်မှတ်ရန်

## Service (background)

headless node host ကို အသုံးပြုသူ service အဖြစ် ထည့်သွင်းပါ။

```bash
openclaw node install --host <gateway-host> --port 18789
```

Options:

- `--host <host>`: Gateway WebSocket ဟို့စ် (မူလတန်ဖိုး: `127.0.0.1`)
- `--port <port>`: Gateway WebSocket ပေါက် (မူလတန်ဖိုး: `18789`)
- `--tls`: gateway ချိတ်ဆက်မှုအတွက် TLS ကို အသုံးပြုရန်
- `--tls-fingerprint <sha256>`: မျှော်မှန်းထားသော TLS လက်မှတ် fingerprint (sha256)
- `--node-id <id>`: node id ကို အစားထိုးသတ်မှတ်ရန် (pairing token ကို ရှင်းလင်းသည်)
- `--display-name <name>`: node ပြသအမည်ကို အစားထိုးသတ်မှတ်ရန်
- `--runtime <runtime>`: Service runtime (`node` သို့မဟုတ် `bun`)
- `--force`: ရှိပြီးသားကို ပြန်လည်ထည့်သွင်း/အစားထိုးရန်

Service ကို စီမံခန့်ခွဲရန်—

```bash
openclaw node status
openclaw node stop
openclaw node restart
openclaw node uninstall
```

service မဟုတ်သော foreground node host အတွက် `openclaw node run` ကို အသုံးပြုပါ။

Service အမိန့်များတွင် စက်ဖြင့်ဖတ်နိုင်သော အထွက်အဖြစ် `--json` ကို လက်ခံပါသည်။

## Pairing

ပထမဆုံး ချိတ်ဆက်မှုသည် Gateway ပေါ်တွင် pending node pair request တစ်ခုကို ဖန်တီးပါသည်။
အတည်ပြုရန်:

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
```

node host သည် ၎င်း၏ node id၊ token၊ ပြသအမည်နှင့် gateway ချိတ်ဆက်မှု အချက်အလက်များကို
`~/.openclaw/node.json` တွင် သိမ်းဆည်းထားပါသည်။

## Exec approvals

`system.run` ကို ဒေသခံ exec approvals များဖြင့် ကန့်သတ်ထားပါသည်—

- `~/.openclaw/exec-approvals.json`
- [Exec approvals](/tools/exec-approvals)
- `openclaw approvals --node <id|name|ip>` (Gateway မှ တည်းဖြတ်နိုင်သည်)

---
summary: "နိုဒ် ချိတ်ဆက်ခြင်း၊ foreground လိုအပ်ချက်များ၊ ခွင့်ပြုချက်များနှင့် ကိရိယာ မအောင်မြင်မှုများကို ပြဿနာဖြေရှင်းခြင်း"
read_when:
  - နိုဒ်သည် ချိတ်ဆက်ထားသော်လည်း camera/canvas/screen/exec ကိရိယာများ မအလုပ်လုပ်ပါက
  - နိုဒ် pairing နှင့် approvals အကြား စိတ်ကူးမော်ဒယ်ကို နားလည်ရန် လိုအပ်ပါက
title: "နိုဒ် ပြဿနာဖြေရှင်းခြင်း"
---

# နိုဒ် ပြဿနာဖြေရှင်းခြင်း

နိုဒ်သည် status တွင် မြင်ရသော်လည်း နိုဒ်ကိရိယာများ မအလုပ်လုပ်ပါက ဤစာမျက်နှာကို အသုံးပြုပါ။

## Command ladder

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

ထို့နောက် နိုဒ်သီးသန့် စစ်ဆေးမှုများကို လုပ်ဆောင်ပါ။

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
```

ကျန်းမာသော အချက်ပြများ -

- နိုဒ်သည် ချိတ်ဆက်ပြီး role `node` အတွက် paired ဖြစ်နေသည်။
- `nodes describe` တွင် သင်ခေါ်ယူနေသော capability ပါဝင်သည်။
- Exec approvals တွင် မျှော်မှန်းထားသော mode/allowlist ကို ပြသထားသည်။

## Foreground လိုအပ်ချက်များ

`canvas.*`၊ `camera.*` နှင့် `screen.*` တို့သည် iOS/Android နိုဒ်များတွင် foreground အနေဖြင့်သာ အလုပ်လုပ်ပါသည်။

အမြန် စစ်ဆေးခြင်းနှင့် ပြုပြင်ခြင်း -

```bash
openclaw nodes describe --node <idOrNameOrIp>
openclaw nodes canvas snapshot --node <idOrNameOrIp>
openclaw logs --follow
```

`NODE_BACKGROUND_UNAVAILABLE` ကို မြင်ပါက နိုဒ်အက်ပ်ကို foreground သို့ ယူလာပြီး ပြန်လည် စမ်းကြည့်ပါ။

## Permissions matrix

| Capability                   | iOS                                                               | Android                                                   | macOS node app                                  | ပုံမှန် မအောင်မြင်မှု ကုဒ်     |
| ---------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| `camera.snap`၊ `camera.clip` | Camera (+ clip အသံအတွက် mic)                   | Camera (+ clip အသံအတွက် mic)           | Camera (+ clip အသံအတွက် mic) | `*_PERMISSION_REQUIRED`        |
| `screen.record`              | Screen Recording (+ mic optional)              | Screen capture prompt (+ mic optional) | Screen Recording                                | `*_PERMISSION_REQUIRED`        |
| `location.get`               | While Using သို့မဟုတ် Always (mode အပေါ်မူတည်) | Mode အပေါ်မူတည်၍ Foreground/Background location           | Location permission                             | `LOCATION_PERMISSION_REQUIRED` |
| `system.run`                 | n/a (node host path)                           | n/a (node host path)                   | Exec approvals လိုအပ်သည်                        | `SYSTEM_RUN_DENIED`            |

## Pairing နှင့် approvals အကြား ကွာခြားချက်

ဤအရာများသည် ကွဲပြားသော gate များဖြစ်ပါသည် -

1. **Device pairing**: ဤနိုဒ်သည် Gateway သို့ ချိတ်ဆက်နိုင်ပါသလား။
2. **Exec approvals**: ဤနိုဒ်သည် သီးသန့် shell command တစ်ခုကို လုပ်ဆောင်နိုင်ပါသလား။

အမြန် စစ်ဆေးမှုများ -

```bash
openclaw devices list
openclaw nodes status
openclaw approvals get --node <idOrNameOrIp>
openclaw approvals allowlist add --node <idOrNameOrIp> "/usr/bin/uname"
```

47. pairing အဆင်ပြေသော်လည်း `system.run` မအောင်မြင်ပါက exec approvals/allowlist ကို ပြင်ဆင်ပါ။
48. Triggers များကို normalize လုပ်ထားသည် (trim လုပ်ပြီး empty များကို ဖယ်ရှားသည်)။

## အများဆုံး တွေ့ရသော နိုဒ် အမှားကုဒ်များ

- `NODE_BACKGROUND_UNAVAILABLE` → အက်ပ်သည် background သို့ ရောက်နေသည်; foreground သို့ ယူလာပါ။
- `CAMERA_DISABLED` → နိုဒ် ဆက်တင်များတွင် camera toggle ကို ပိတ်ထားသည်။
- `*_PERMISSION_REQUIRED` → OS ခွင့်ပြုချက် မရှိ/ငြင်းပယ်ထားသည်။
- `LOCATION_DISABLED` → location mode ကို ပိတ်ထားသည်။
- `LOCATION_PERMISSION_REQUIRED` → တောင်းဆိုထားသော location mode ကို ခွင့်မပြုထားပါ။
- `LOCATION_BACKGROUND_UNAVAILABLE` → အက်ပ်သည် background တွင်ရှိသော်လည်း While Using permission သာ ရှိသည်။
- `SYSTEM_RUN_DENIED: approval required` → exec request သည် အတိအလင်း အတည်ပြုချက် လိုအပ်သည်။
- `SYSTEM_RUN_DENIED: allowlist miss` → allowlist mode ကြောင့် command ကို ပိတ်ဆို့ထားသည်။

## အမြန် ပြန်လည်ထူထောင် လုပ်ငန်းစဉ်

```bash
openclaw nodes status
openclaw nodes describe --node <idOrNameOrIp>
openclaw approvals get --node <idOrNameOrIp>
openclaw logs --follow
```

မဖြေရှင်းနိုင်သေးပါက -

- စက်ပစ္စည်း pairing ကို ပြန်လည် အတည်ပြုပါ။
- နိုဒ်အက်ပ်ကို ပြန်ဖွင့်ပါ (foreground)။
- OS ခွင့်ပြုချက်များကို ပြန်လည် ခွင့်ပြုပါ။
- Exec approval policy ကို ပြန်လည် ဖန်တီးခြင်း သို့မဟုတ် ချိန်ညှိပါ။

ဆက်စပ်အကြောင်းအရာများ -

- [/nodes/index](/nodes/index)
- [/nodes/camera](/nodes/camera)
- [/nodes/location-command](/nodes/location-command)
- [/tools/exec-approvals](/tools/exec-approvals)
- [/gateway/pairing](/gateway/pairing)

---
summary: "NIP-04 ဖြင့် စာဝှက်ထားသော မက်ဆေ့ချ်များမှတဆင့် Nostr DM ချန်နယ်"
read_when:
  - OpenClaw ကို Nostr မှတဆင့် DM များ လက်ခံစေချင်သည့်အခါ
  - ဗဟိုမထားသော မက်ဆေ့ချ်ပို့ဆောင်ရေးကို တပ်ဆင်နေသည့်အခါ
title: "Nostr"
---

# Nostr

**အခြေအနေ:** ရွေးချယ်အသုံးပြုနိုင်သော ပလဂင် (မူလအနေဖြင့် ပိတ်ထားသည်)။

Nostr သည် လူမှုကွန်ယက်အတွက် ဗဟိုမဲ့ (decentralized) protocol တစ်ခုဖြစ်သည်။ ဤ channel သည် OpenClaw ကို NIP-04 မှတစ်ဆင့် အင်ကရစ်ပြုလုပ်ထားသော တိုက်ရိုက်မက်ဆေ့ချ်များ (DMs) ကို လက်ခံပြီး တုံ့ပြန်နိုင်ရန် ခွင့်ပြုပါသည်။

## Install (လိုအပ်သည့်အခါ)

### Onboarding (အကြံပြု)

- onboarding wizard (`openclaw onboard`) နှင့် `openclaw channels add` တွင် ရွေးချယ်နိုင်သော ချန်နယ်ပလဂင်များကို စာရင်းပြုထားသည်။
- Nostr ကို ရွေးချယ်လျှင် လိုအပ်သည့်အချိန်တွင် ပလဂင်ကို ထည့်သွင်းရန် အချက်ပြမည်ဖြစ်သည်။

မူလ ထည့်သွင်းသတ်မှတ်ချက်များ-

- **Dev ချန်နယ် + git checkout ရရှိနိုင်:** local plugin path ကို အသုံးပြုသည်။
- **Stable/Beta:** npm မှ ဒေါင်းလုဒ်လုပ်သည်။

အချက်ပြပေါ်တွင် ရွေးချယ်မှုကို မည်သည့်အချိန်မဆို ပြန်လည်ပြင်ဆင်နိုင်သည်။

### Manual install

```bash
openclaw plugins install @openclaw/nostr
```

Local checkout ကို အသုံးပြုရန် (dev workflow များအတွက်):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

ပလဂင်များကို ထည့်သွင်း သို့မဟုတ် ဖွင့်ပြီးနောက် Gateway ကို ပြန်လည်စတင်ပါ။

## Quick setup

1. Nostr keypair ကို ဖန်တီးပါ (လိုအပ်ပါက):

```bash
# Using nak
nak key generate
```

2. config ထဲသို့ ထည့်ပါ:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. key ကို export လုပ်ပါ:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Gateway ကို ပြန်လည်စတင်ပါ။

## Configuration reference

| Key          | Type                                                         | Default                                     | Description                                   |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | --------------------------------------------- |
| `privateKey` | string                                                       | required                                    | `nsec` သို့မဟုတ် hex ဖော်မတ်ရှိ Private key   |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | Relay URL များ (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | DM ဝင်ရောက်ခွင့် မူဝါဒ                        |
| `allowFrom`  | string[] | `[]`                                        | ခွင့်ပြုထားသော ပို့သူ pubkey များ             |
| `enabled`    | boolean                                                      | `true`                                      | ချန်နယ်ကို ဖွင့်/ပိတ်                         |
| `name`       | string                                                       | -                                           | ပြသမည့် အမည်                                  |
| `profile`    | object                                                       | -                                           | NIP-01 ပရိုဖိုင် မီတာဒေတာ                     |

## Profile metadata

Profile ဒေတာကို NIP-01 `kind:0` event အဖြစ် ထုတ်ဝေပါသည်။ Control UI (Channels -> Nostr -> Profile) မှ စီမံခန့်ခွဲနိုင်သလို config တွင်လည်း တိုက်ရိုက် သတ်မှတ်နိုင်ပါသည်။

ဥပမာ-

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

မှတ်ချက်များ-

- Profile URL များသည် `https://` ကို အသုံးပြုရမည်။
- relay များမှ import လုပ်သည့်အခါ field များကို ပေါင်းစည်းပြီး local override များကို ထိန်းသိမ်းထားသည်။

## Access control

### DM မူဝါဒများ

- **pairing** (မူလ): မသိသော ပို့သူများသည် pairing code ကို ရရှိမည်။
- **allowlist**: `allowFrom` ထဲရှိ pubkey များသာ DM ပို့နိုင်သည်။
- **open**: အဝင် DM များကို အများပြည်သူအတွက် ဖွင့်ထားသည် (`allowFrom: ["*"]` လိုအပ်သည်)။
- **disabled**: အဝင် DM များကို လျစ်လျူရှုသည်။

### Allowlist ဥပမာ

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Key formats

လက်ခံသော ဖော်မတ်များ-

- **Private key:** `nsec...` သို့မဟုတ် အက္ခရာ 64 လုံးပါသော hex
- **Pubkey များ (`allowFrom`):** `npub...` သို့မဟုတ် hex

## Relays

မူလသတ်မှတ်ချက်များ: `relay.damus.io` နှင့် `nos.lol`။

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

အကြံပြုချက်များ-

- အစားထိုးအသုံးပြုနိုင်ရန် relay 2-3 ခုကို အသုံးပြုပါ။
- relay များကို အလွန်များစွာ မသုံးပါနှင့် (latency နှင့် ထပ်တလဲလဲ ဖြစ်နိုင်ခြေ)။
- အခကြေးငွေပေးရသော relay များသည် ယုံကြည်စိတ်ချရမှုကို မြှင့်တင်ပေးနိုင်သည်။
- စမ်းသပ်ရန် local relay များကို အသုံးပြုနိုင်သည် (`ws://localhost:7777`)။

## Protocol support

| NIP    | Status    | Description                                        |
| ------ | --------- | -------------------------------------------------- |
| NIP-01 | Supported | အခြေခံ event ဖော်မတ် + ပရိုဖိုင် မီတာဒေတာ          |
| NIP-04 | Supported | စာဝှက်ထားသော DM များ (`kind:4`) |
| NIP-17 | Planned   | Gift-wrapped DM များ                               |
| NIP-44 | Planned   | ဗားရှင်းပါသော စာဝှက်ခြင်း                          |

## Testing

### Local relay

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Manual test

1. log များထဲမှ bot pubkey (npub) ကို မှတ်သားပါ။
2. Nostr client (Damus, Amethyst စသည်) ကို ဖွင့်ပါ။
3. bot pubkey သို့ DM ပို့ပါ။
4. တုံ့ပြန်မှုကို အတည်ပြုပါ။

## Troubleshooting

### မက်ဆေ့ချ်များ မရရှိခြင်း

- Private key သည် မှန်ကန်ကြောင်း စစ်ဆေးပါ။
- Relay URL များကို ချိတ်ဆက်နိုင်ပြီး `wss://` (သို့မဟုတ် local အတွက် `ws://`) ကို အသုံးပြုထားကြောင်း သေချာပါစေ။
- `enabled` သည် `false` မဟုတ်ကြောင်း အတည်ပြုပါ။
- Relay ချိတ်ဆက်မှု အမှားများအတွက် Gateway log များကို စစ်ဆေးပါ။

### တုံ့ပြန်ချက်များ မပို့နိုင်ခြင်း

- Relay သည် write လုပ်ခြင်းကို လက်ခံကြောင်း စစ်ဆေးပါ။
- Outbound connectivity ကို အတည်ပြုပါ။
- Relay rate limit များကို သတိပြုပါ။

### ထပ်တလဲလဲ တုံ့ပြန်မှုများ

- relay များစွာ အသုံးပြုသောအခါ မျှော်လင့်ထားရမည့် အခြေအနေဖြစ်သည်။
- မက်ဆေ့ချ်များကို event ID ဖြင့် deduplicate လုပ်ထားပြီး ပထမဆုံး ပို့ဆောင်မှုသာ တုံ့ပြန်မှုကို ဖြစ်စေသည်။

## Security

- Private key များကို မည်သည့်အခါမှ commit မလုပ်ပါနှင့်။
- key များအတွက် environment variables ကို အသုံးပြုပါ။
- production bot များအတွက် `allowlist` ကို စဉ်းစားပါ။

## Limitations (MVP)

- တိုက်ရိုက် မက်ဆေ့ချ်များသာ (group chat မပါ)။
- မီဒီယာ attachment မပါ။
- NIP-04 သာ (NIP-17 gift-wrap ကို စီစဉ်ထားသည်)။

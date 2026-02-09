---
title: "Pi ဖွံ့ဖြိုးရေး လုပ်ငန်းစဉ်"
---

# Pi ဖွံ့ဖြိုးရေး လုပ်ငန်းစဉ်

ဤလမ်းညွှန်သည် OpenClaw တွင် pi ပေါင်းစည်းမှုအပေါ် အလုပ်လုပ်ရာတွင် သင့်လျော်ပြီး စနစ်တကျရှိသော လုပ်ငန်းစဉ်ကို အကျဉ်းချုပ် ဖော်ပြထားပါသည်။

## Type Checking နှင့် Linting

- Type စစ်ဆေးခြင်းနှင့် build ပြုလုပ်ခြင်း: `pnpm build`
- Lint: `pnpm lint`
- Format စစ်ဆေးခြင်း: `pnpm format`
- push မပြုလုပ်မီ gate အပြည့်အစုံ လုပ်ဆောင်ခြင်း: `pnpm lint && pnpm build && pnpm test`

## Pi စမ်းသပ်မှုများကို လည်ပတ်စေခြင်း

pi ပေါင်းစည်းမှု စမ်းသပ်မှုအစုံအတွက် သီးသန့် script ကို အသုံးပြုပါ—

```bash
scripts/pi/run-tests.sh
```

အမှန်တကယ် provider အပြုအမူကို စမ်းသပ်သော live test ကို ထည့်သွင်းလိုပါက—

```bash
scripts/pi/run-tests.sh --live
```

ဤ script သည် အောက်ပါ glob များမှတဆင့် pi နှင့် ဆိုင်သော unit test အားလုံးကို လည်ပတ်စေပါသည်—

- `src/agents/pi-*.test.ts`
- `src/agents/pi-embedded-*.test.ts`
- `src/agents/pi-tools*.test.ts`
- `src/agents/pi-settings.test.ts`
- `src/agents/pi-tool-definition-adapter.test.ts`
- `src/agents/pi-extensions/*.test.ts`

## Manual Testing

အကြံပြုထားသော လုပ်ဆောင်စဉ်—

- Gateway（ဂိတ်ဝေး）ကို dev mode ဖြင့် လည်ပတ်စေပါ—
  - `pnpm gateway:dev`
- agent ကို တိုက်ရိုက် လှုံ့ဆော်ပါ—
  - `pnpm openclaw agent --message "Hello" --thinking low`
- အပြန်အလှန် debug ပြုလုပ်ရန် TUI ကို အသုံးပြုပါ—
  - `pnpm tui`

tool call အပြုအမူကို စမ်းသပ်ရန်၊ tool streaming နှင့် payload ကို ကိုင်တွယ်ပုံကို မြင်နိုင်ရန် `read` သို့မဟုတ် `exec` လုပ်ဆောင်ချက်ကို prompt ပေးပါ။

## Clean Slate Reset

2. State ကို OpenClaw state directory အောက်တွင် သိမ်းဆည်းထားပါသည်။ 3. ပုံမှန်တန်ဖိုးမှာ `~/.openclaw` ဖြစ်ပါသည်။ 4. `OPENCLAW_STATE_DIR` ကို သတ်မှတ်ထားပါက ထို directory ကို အသုံးပြုပါမည်။

အားလုံးကို ပြန်လည်စတင်ရန်—

- config အတွက် `openclaw.json`
- auth profiles နှင့် tokens အတွက် `credentials/`
- agent session history အတွက် `agents/<agentId>/sessions/`
- session index အတွက် `agents/<agentId>/sessions.json`
- legacy paths ရှိပါက `sessions/`
- အလွတ် workspace လိုပါက `workspace/`

5. Session များကိုသာ reset လုပ်ချင်ပါက အဆိုပါ agent အတွက် `agents/<agentId>/sessions/` နှင့် `agents/<agentId>/sessions.json` ကို ဖျက်ပါ။ 6. ပြန်လည် authenticate မလုပ်ချင်ပါက `credentials/` ကို ထားရှိထားပါ။

## References

- [https://docs.openclaw.ai/testing](https://docs.openclaw.ai/testing)
- [https://docs.openclaw.ai/start/getting-started](https://docs.openclaw.ai/start/getting-started)

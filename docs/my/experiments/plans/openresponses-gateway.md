---
summary: "အစီအစဉ်: OpenResponses /v1/responses endpoint ကို ထည့်သွင်းပြီး chat completions ကို သန့်ရှင်းစွာ အဆင့်ချင်း ဖယ်ရှားရန်"
owner: "openclaw"
status: "draft"
last_updated: "2026-01-19"
title: "OpenResponses Gateway အစီအစဉ်"
---

# OpenResponses Gateway ပေါင်းစည်းရေး အစီအစဉ်

## Context

OpenClaw Gateway သည် လက်ရှိတွင် OpenAI နှင့် ကိုက်ညီသည့် Chat Completions endpoint အနည်းဆုံးကို
`/v1/chat/completions` တွင် ဖော်ပြပေးထားသည် ([OpenAI Chat Completions](/gateway/openai-http-api) ကိုကြည့်ပါ)။

၎င်းကို agentic workflows များအတွက် ဒီဇိုင်းထုတ်ထားပြီး item-based inputs များနှင့် semantic streaming events များကို အသုံးပြုပါသည်။ OpenResponses spec သည် `/v1/chat/completions` မဟုတ်ဘဲ `/v1/responses` ကို သတ်မှတ်ထားပါသည်။ ဤစာရွက်စာတမ်းသည် အနာဂတ် model configuration အတွက် **ideas** များကို ဖမ်းဆီးထားခြင်း ဖြစ်ပါသည်။

## Goals

- OpenResponses semantics ကို လိုက်နာသည့် `/v1/responses` endpoint ကို ထည့်သွင်းရန်။
- Chat Completions ကို ပိတ်နိုင်လွယ်ကူပြီး နောက်ဆုံးတွင် ဖယ်ရှားနိုင်သော compatibility layer အဖြစ် ထိန်းသိမ်းထားရန်။
- သီးခြားခွဲထားပြီး ပြန်လည်အသုံးပြုနိုင်သော schemas များဖြင့် validation နှင့် parsing ကို စံချိန်စံညွှန်း化 ပြုလုပ်ရန်။

## Non-goals

- ပထမအဆင့်တွင် OpenResponses feature အပြည့်အစုံကို မဖော်ဆောင်ပါ (images, files, hosted tools)။
- အတွင်းပိုင်း agent အကောင်အထည်ဖော်ရေး logic သို့မဟုတ် tool orchestration ကို အစားထိုးခြင်း မပြုလုပ်ပါ။
- ပထမအဆင့်အတွင်း ရှိပြီးသား `/v1/chat/completions` အပြုအမူကို မပြောင်းလဲပါ။

## Research Summary

အရင်းအမြစ်များ: OpenResponses OpenAPI, OpenResponses specification site နှင့် Hugging Face blog post။

ထုတ်ယူထားသော အချက်အလက် အဓိကများ:

- `POST /v1/responses` သည် `CreateResponseBody` fields များကို လက်ခံသည်၊ ဥပမာ `model`, `input` (string သို့မဟုတ်
  `ItemParam[]`), `instructions`, `tools`, `tool_choice`, `stream`, `max_output_tokens`, နှင့်
  `max_tool_calls`။
- `ItemParam` သည် ခွဲခြားသတ်မှတ်ထားသော union တစ်ခုဖြစ်ပြီး အောက်ပါအရာများ ပါဝင်သည်—
  - `message` items များ (roles `system`, `developer`, `user`, `assistant` ပါဝင်)
  - `function_call` နှင့် `function_call_output`
  - `reasoning`
  - `item_reference`
- အောင်မြင်သော responses များသည် `ResponseResource` ကို ပြန်ပေးပြီး `object: "response"`, `status`, နှင့်
  `output` items များ ပါဝင်သည်။
- Streaming သည် အောက်ပါ semantic events များကို အသုံးပြုသည်—
  - `response.created`, `response.in_progress`, `response.completed`, `response.failed`
  - `response.output_item.added`, `response.output_item.done`
  - `response.content_part.added`, `response.content_part.done`
  - `response.output_text.delta`, `response.output_text.done`
- Spec တွင် အောက်ပါလိုအပ်ချက်များ ပါရှိသည်—
  - `Content-Type: text/event-stream`
  - `event:` သည် JSON `type` field နှင့် ကိုက်ညီရမည်
  - အဆုံးသတ် event သည် အတိအကျ `[DONE]` ဖြစ်ရမည်
- Reasoning items များတွင် `content`, `encrypted_content`, နှင့် `summary` ကို ဖော်ပြနိုင်သည်။
- HF ဥပမာများတွင် requests များအတွက် `OpenResponses-Version: latest` (optional header) ပါဝင်သည်။

## Proposed Architecture

- Zod schemas များသာ ပါဝင်သည့် `src/gateway/open-responses.schema.ts` ကို ထည့်သွင်းရန် (gateway imports မပါ)။
- `/v1/responses` အတွက် `src/gateway/openresponses-http.ts` (သို့မဟုတ် `open-responses-http.ts`) ကို ထည့်သွင်းရန်။
- legacy compatibility adapter အဖြစ် `src/gateway/openai-http.ts` ကို မပြောင်းလဲဘဲ ထိန်းသိမ်းထားရန်။
- config `gateway.http.endpoints.responses.enabled` ကို ထည့်သွင်းရန် (default `false`)။
- `gateway.http.endpoints.chatCompletions.enabled` ကို သီးခြားလွတ်လပ်စွာ ထားရှိပြီး endpoint နှစ်ခုစလုံးကို
  သီးခြားစီ toggle ပြုလုပ်နိုင်စေရန်။
- Chat Completions ကို enabled လုပ်ထားပါက legacy အခြေအနေကို အချက်ပေးရန် startup warning ထုတ်ပေးရန်။

## Chat Completions အတွက် Deprecation Path

- တင်းကျပ်သော module အကန့်အသတ်များကို ထိန်းသိမ်းရန်—responses နှင့် chat completions အကြား schema types များကို မမျှဝေပါ။
- Chat Completions ကို config ဖြင့် opt-in အဖြစ် ပြုလုပ်ပြီး code မပြောင်းလဲဘဲ ပိတ်နိုင်စေရန်။
- `/v1/responses` တည်ငြိမ်လာသောအခါ Chat Completions ကို legacy အဖြစ် သတ်မှတ်ရန် docs များကို အပ်ဒိတ်လုပ်ရန်။
- ရွေးချယ်နိုင်သော အနာဂတ်အဆင့်: ဖယ်ရှားရေးလမ်းကြောင်းကို လွယ်ကူစေရန် Chat Completions requests များကို Responses handler သို့ map လုပ်ခြင်း။

## Phase 1 Support Subset

- `input` ကို string အဖြစ် သို့မဟုတ် message roles နှင့် `function_call_output` ပါဝင်သည့် `ItemParam[]` အဖြစ် လက်ခံရန်။
- system နှင့် developer messages များကို `extraSystemPrompt` သို့ ထုတ်ယူရန်။
- agent runs အတွက် လက်ရှိ message အဖြစ် နောက်ဆုံး `user` သို့မဟုတ် `function_call_output` ကို အသုံးပြုရန်။
- မထောက်ပံ့သော content parts (image/file) များကို `invalid_request_error` ဖြင့် ပယ်ချရန်။
- `output_text` content ပါဝင်သည့် assistant message တစ်ခုတည်းကို ပြန်ပေးရန်။
- token accounting ကို ချိတ်ဆက်ပြီးသည်အထိ zeroed values ပါသည့် `usage` ကို ပြန်ပေးရန်။

## Validation Strategy (No SDK)

- ထောက်ပံ့ထားသော subset အတွက် Zod schemas များကို အကောင်အထည်ဖော်ရန်—
  - `CreateResponseBody`
  - `ItemParam` + message content part unions
  - `ResponseResource`
  - Gateway တွင် အသုံးပြုသော streaming event shapes များ
- drift ကို ရှောင်ရှားပြီး အနာဂတ် codegen အတွက် ခွင့်ပြုနိုင်စေရန် schemas များကို သီးခြား module တစ်ခုတည်းတွင် ထားရှိရန်။

## Streaming Implementation (Phase 1)

- `event:` နှင့် `data:` နှစ်ခုစလုံးပါဝင်သည့် SSE lines များ။
- လိုအပ်သော အစီအစဉ် (minimum viable)—
  - `response.created`
  - `response.output_item.added`
  - `response.content_part.added`
  - `response.output_text.delta` (လိုအပ်သလို ထပ်ခါတလဲလဲ)
  - `response.output_text.done`
  - `response.content_part.done`
  - `response.completed`
  - `[DONE]`

## Tests and Verification Plan

- `/v1/responses` အတွက် e2e coverage ကို ထည့်သွင်းရန်—
  - Auth လိုအပ်မှု
  - Non-stream response shape
  - Stream event အစီအစဉ်နှင့် `[DONE]`
  - Headers နှင့် `user` ဖြင့် session routing
- `src/gateway/openai-http.e2e.test.ts` ကို မပြောင်းလဲဘဲ ထိန်းသိမ်းရန်။
- Manual: `stream: true` ဖြင့် `/v1/responses` သို့ curl လုပ်ပြီး event အစီအစဉ်နှင့် အဆုံးသတ်
  `[DONE]` ကို အတည်ပြုရန်။

## Doc Updates (Follow-up)

- `/v1/responses` အသုံးပြုပုံနှင့် ဥပမာများအတွက် docs စာမျက်နှာအသစ် တစ်ခု ထည့်သွင်းရန်။
- `/gateway/openai-http-api` ကို legacy မှတ်ချက်နှင့် `/v1/responses` သို့ လမ်းညွှန်ချက်ဖြင့် အပ်ဒိတ်လုပ်ရန်။

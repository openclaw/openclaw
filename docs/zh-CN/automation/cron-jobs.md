---
read_when:
  - 璋冨害鍚庡彴浠诲姟鎴栧敜閱?  - 閰嶇疆闇€瑕佷笌蹇冭烦涓€璧锋垨骞惰杩愯鐨勮嚜鍔ㄥ寲
  - 鍦ㄥ績璺冲拰瀹氭椂浠诲姟涔嬮棿鍋氶€夋嫨
summary: Gateway缃戝叧璋冨害鍣ㄧ殑瀹氭椂浠诲姟涓庡敜閱?title: 瀹氭椂浠诲姟
x-i18n:
  generated_at: "2026-02-01T19:37:32Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d43268b0029f1b13d0825ddcc9c06a354987ea17ce02f3b5428a9c68bf936676
  source_path: automation/cron-jobs.md
  workflow: 14
---

# 瀹氭椂浠诲姟锛圙ateway缃戝叧璋冨害鍣級

> **瀹氭椂浠诲姟杩樻槸蹇冭烦锛?* 璇峰弬闃匸瀹氭椂浠诲姟涓庡績璺冲姣擼(/automation/cron-vs-heartbeat)浜嗚В浣曟椂浣跨敤鍝鏂瑰紡銆?
瀹氭椂浠诲姟鏄?Gateway缃戝叧鍐呯疆鐨勮皟搴﹀櫒銆傚畠鎸佷箙鍖栦换鍔°€佸湪鍚堥€傜殑鏃堕棿鍞ら啋鏅鸿兘浣擄紝骞跺彲閫夋嫨灏嗚緭鍑哄彂閫佸洖鑱婂ぉ銆?
濡傛灉浣犳兂瑕?_"姣忓ぉ鏃╀笂杩愯"_ 鎴?_"20 鍒嗛挓鍚庢彁閱掓櫤鑳戒綋"_锛屽畾鏃朵换鍔″氨鏄搴旂殑鏈哄埗銆?
## 绠€瑕佹杩?
- 瀹氭椂浠诲姟杩愯鍦?**Gateway缃戝叧鍐呴儴**锛堣€岄潪妯″瀷鍐呴儴锛夈€?- 浠诲姟鎸佷箙鍖栧瓨鍌ㄥ湪 `~/.openclaw/cron/` 涓嬶紝鍥犳閲嶅惎涓嶄細涓㈠け璁″垝銆?- 涓ょ鎵ц鏂瑰紡锛?  - **涓讳細璇?*锛氬叆闃熶竴涓郴缁熶簨浠讹紝鐒跺悗鍦ㄤ笅涓€娆″績璺虫椂杩愯銆?  - **闅旂寮?*锛氬湪 `cron:<jobId>` 鎴栬嚜瀹氫箟浼氳瘽涓繍琛屼笓鐢ㄦ櫤鑳戒綋杞锛屽彲鎶曢€掓憳瑕侊紙榛樿 announce锛夋垨涓嶆姇閫掋€?  - **褰撳墠浼氳瘽**锛氱粦瀹氬埌鍒涘缓瀹氭椂浠诲姟鏃剁殑浼氳瘽 (`sessionTarget: "current"`)銆?  - **鑷畾涔変細璇?*锛氬湪鎸佷箙鍖栫殑鍛藉悕浼氳瘽涓繍琛?(`sessionTarget: "session:custom-id"`)銆?- 鍞ら啋鏄竴绛夊姛鑳斤細浠诲姟鍙互璇锋眰"绔嬪嵆鍞ら啋"鎴?涓嬫蹇冭烦鏃?銆?
## 蹇€熷紑濮嬶紙鍙搷浣滐級

鍒涘缓涓€涓竴娆℃€ф彁閱掞紝楠岃瘉鍏跺瓨鍦紝鐒跺悗绔嬪嵆杩愯锛?
```bash
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Reminder: check the cron docs draft" \
  --wake now \
  --delete-after-run

openclaw cron list
openclaw cron run <job-id> --force
openclaw cron runs --id <job-id>
```

璋冨害涓€涓甫鎶曢€掑姛鑳界殑鍛ㄦ湡鎬ч殧绂讳换鍔★細

```bash
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"
```

## 宸ュ叿璋冪敤绛変环褰㈠紡锛圙ateway缃戝叧瀹氭椂浠诲姟宸ュ叿锛?
鏈夊叧瑙勮寖鐨?JSON 缁撴瀯鍜岀ず渚嬶紝璇峰弬闃匸宸ュ叿璋冪敤鐨?JSON 妯″紡](/automation/cron-jobs#json-schema-for-tool-calls)銆?
## 瀹氭椂浠诲姟鐨勫瓨鍌ㄤ綅缃?
瀹氭椂浠诲姟榛樿鎸佷箙鍖栧瓨鍌ㄥ湪 Gateway缃戝叧涓绘満鐨?`~/.openclaw/cron/jobs.json` 涓€侴ateway缃戝叧灏嗘枃浠跺姞杞藉埌鍐呭瓨涓紝骞跺湪鏇存敼鏃跺啓鍥烇紝鍥犳浠呭湪 Gateway缃戝叧鍋滄鏃舵墜鍔ㄧ紪杈戞墠鏄畨鍏ㄧ殑銆傝浼樺厛浣跨敤 `openclaw cron add/edit` 鎴栧畾鏃朵换鍔″伐鍏疯皟鐢?API 杩涜鏇存敼銆?
## 鏂版墜鍙嬪ソ姒傝堪

灏嗗畾鏃朵换鍔＄悊瑙ｄ负锛?*浣曟椂**杩愯 + **鍋氫粈涔?*銆?
1. **閫夋嫨璋冨害璁″垝**
   - 涓€娆℃€ф彁閱?鈫?`schedule.kind = "at"`锛圕LI锛歚--at`锛?   - 閲嶅浠诲姟 鈫?`schedule.kind = "every"` 鎴?`schedule.kind = "cron"`
   - 濡傛灉浣犵殑 ISO 鏃堕棿鎴崇渷鐣ヤ簡鏃跺尯锛屽皢琚涓?**UTC**銆?
2. **閫夋嫨杩愯浣嶇疆**
   - `sessionTarget: "main"` 鈫?鍦ㄤ笅涓€娆″績璺虫椂浣跨敤涓讳細璇濅笂涓嬫枃杩愯銆?   - `sessionTarget: "isolated"` 鈫?鍦?`cron:<jobId>` 涓繍琛屼笓鐢ㄦ櫤鑳戒綋杞銆?   - `sessionTarget: "current"` 鈫?缁戝畾鍒板綋鍓嶄細璇濓紙鍒涘缓鏃惰В鏋愪负 `session:<sessionKey>`锛夈€?   - `sessionTarget: "session:custom-id"` 鈫?鍦ㄦ寔涔呭寲鐨勫懡鍚嶄細璇濅腑杩愯锛岃法杩愯淇濇寔涓婁笅鏂囥€?
   榛樿琛屼负锛堜繚鎸佷笉鍙橈級锛?   - `systemEvent` 璐熻浇榛樿浣跨敤 `main`
   - `agentTurn` 璐熻浇榛樿浣跨敤 `isolated`

   瑕佷娇鐢ㄥ綋鍓嶄細璇濈粦瀹氾紝闇€鏄惧紡璁剧疆 `sessionTarget: "current"`銆?
3. **閫夋嫨璐熻浇**
   - 涓讳細璇?鈫?`payload.kind = "systemEvent"`
   - 闅旂浼氳瘽 鈫?`payload.kind = "agentTurn"`

鍙€夛細涓€娆℃€т换鍔★紙`schedule.kind = "at"`锛夐粯璁や細鍦ㄦ垚鍔熻繍琛屽悗鍒犻櫎銆傝缃?`deleteAfterRun: false` 鍙繚鐣欏畠锛堟垚鍔熷悗浼氱鐢級銆?
## 姒傚康

### 浠诲姟

瀹氭椂浠诲姟鏄竴鏉″瓨鍌ㄨ褰曪紝鍖呭惈锛?
- 涓€涓?*璋冨害璁″垝**锛堜綍鏃惰繍琛岋級锛?- 涓€涓?*璐熻浇**锛堝仛浠€涔堬級锛?- 鍙€夌殑**鎶曢€?*锛堣緭鍑哄彂閫佸埌鍝噷锛夈€?- 鍙€夌殑**鏅鸿兘浣撶粦瀹?*锛坄agentId`锛夛細鍦ㄦ寚瀹氭櫤鑳戒綋涓嬭繍琛屼换鍔★紱濡傛灉缂哄け鎴栨湭鐭ワ紝Gateway缃戝叧浼氬洖閫€鍒伴粯璁ゆ櫤鑳戒綋銆?
浠诲姟閫氳繃绋冲畾鐨?`jobId` 鏍囪瘑锛堢敤浜?CLI/Gateway缃戝叧 API锛夈€?鍦ㄦ櫤鑳戒綋宸ュ叿璋冪敤涓紝`jobId` 鏄鑼冨瓧娈碉紱鏃х増 `id` 浠嶅彲鍏煎浣跨敤銆?涓€娆℃€т换鍔￠粯璁や細鍦ㄦ垚鍔熻繍琛屽悗鑷姩鍒犻櫎锛涜缃?`deleteAfterRun: false` 鍙繚鐣欏畠銆?
### 璋冨害璁″垝

瀹氭椂浠诲姟鏀寔涓夌璋冨害绫诲瀷锛?
- `at`锛氫竴娆℃€ф椂闂存埑锛圛SO 8601 瀛楃涓诧級銆?- `every`锛氬浐瀹氶棿闅旓紙姣锛夈€?- `cron`锛? 瀛楁 cron 琛ㄨ揪寮忥紝鍙€?IANA 鏃跺尯銆?
Cron 琛ㄨ揪寮忎娇鐢?`croner`銆傚鏋滅渷鐣ユ椂鍖猴紝灏嗕娇鐢?Gateway缃戝叧涓绘満鐨勬湰鍦版椂鍖恒€?
### 涓讳細璇濅笌闅旂寮忔墽琛?
#### 涓讳細璇濅换鍔★紙绯荤粺浜嬩欢锛?
涓讳細璇濅换鍔″叆闃熶竴涓郴缁熶簨浠讹紝骞跺彲閫夋嫨鍞ら啋蹇冭烦杩愯鍣ㄣ€傚畠浠繀椤讳娇鐢?`payload.kind = "systemEvent"`銆?
- `wakeMode: "next-heartbeat"`锛堥粯璁わ級锛氫簨浠剁瓑寰呬笅涓€娆¤鍒掑績璺炽€?- `wakeMode: "now"`锛氫簨浠惰Е鍙戠珛鍗冲績璺宠繍琛屻€?
褰撲綘闇€瑕佹甯哥殑蹇冭烦鎻愮ず + 涓讳細璇濅笂涓嬫枃鏃讹紝杩欐槸鏈€浣抽€夋嫨銆傚弬瑙乕蹇冭烦](/gateway/heartbeat)銆?
#### 闅旂浠诲姟锛堜笓鐢ㄥ畾鏃朵細璇濓級

闅旂浠诲姟鍦ㄤ細璇?`cron:<jobId>` 鎴栬嚜瀹氫箟浼氳瘽涓繍琛屼笓鐢ㄦ櫤鑳戒綋杞銆?
鍏抽敭琛屼负锛?
- 鎻愮ず浠?`[cron:<jobId> <浠诲姟鍚嶇О>]` 涓哄墠缂€锛屼究浜庤拷韪€?- 姣忔杩愯閮戒細鍚姩涓€涓?*鍏ㄦ柊鐨勪細璇?ID**锛堜笉缁ф壙涔嬪墠鐨勫璇濓級锛岄櫎闈炰娇鐢ㄨ嚜瀹氫箟浼氳瘽銆?- 鑷畾涔変細璇濓紙`session:xxx`锛夊彲璺ㄨ繍琛屼繚鎸佷笂涓嬫枃锛岄€傜敤浜庡姣忔棩绔欎細绛夐渶瑕佸熀浜庡墠娆℃憳瑕佺殑宸ヤ綔娴併€?- 濡傛灉鏈寚瀹?`delivery`锛岄殧绂讳换鍔′細榛樿浠モ€渁nnounce鈥濇柟寮忔姇閫掓憳瑕併€?- `delivery.mode` 鍙€?`announce`锛堟姇閫掓憳瑕侊級鎴?`none`锛堝唴閮ㄨ繍琛岋級銆?
瀵逛簬鍢堟潅銆侀绻佹垨"鍚庡彴鏉傚姟"绫讳换鍔★紝浣跨敤闅旂浠诲姟鍙互閬垮厤姹℃煋浣犵殑涓昏亰澶╄褰曘€?
### 璐熻浇缁撴瀯锛堣繍琛屽唴瀹癸級

鏀寔涓ょ璐熻浇绫诲瀷锛?
- `systemEvent`锛氫粎闄愪富浼氳瘽锛岄€氳繃蹇冭烦鎻愮ず璺敱銆?- `agentTurn`锛氫粎闄愰殧绂讳細璇濓紝杩愯涓撶敤鏅鸿兘浣撹疆娆°€?
甯哥敤 `agentTurn` 瀛楁锛?
- `message`锛氬繀濉枃鏈彁绀恒€?- `model` / `thinking`锛氬彲閫夎鐩栵紙瑙佷笅鏂囷級銆?- `timeoutSeconds`锛氬彲閫夎秴鏃惰鐩栥€?
### 妯″瀷鍜屾€濈淮瑕嗙洊

闅旂浠诲姟锛坄agentTurn`锛夊彲浠ヨ鐩栨ā鍨嬪拰鎬濈淮绾у埆锛?
- `model`锛氭彁渚涘晢/妯″瀷瀛楃涓诧紙渚嬪 `anthropic/claude-sonnet-4-20250514`锛夋垨鍒悕锛堜緥濡?`opus`锛?- `thinking`锛氭€濈淮绾у埆锛坄off`銆乣minimal`銆乣low`銆乣medium`銆乣high`銆乣xhigh`锛涗粎闄?GPT-5.2 + Codex 妯″瀷锛?
娉ㄦ剰锛氫綘涔熷彲浠ュ湪涓讳細璇濅换鍔′笂璁剧疆 `model`锛屼絾杩欎細鏇存敼鍏变韩鐨勪富浼氳瘽妯″瀷銆傛垜浠缓璁粎瀵归殧绂讳换鍔′娇鐢ㄦā鍨嬭鐩栵紝浠ラ伩鍏嶆剰澶栫殑涓婁笅鏂囧垏鎹€?
浼樺厛绾цВ鏋愰『搴忥細

1. 浠诲姟璐熻浇瑕嗙洊锛堟渶楂樹紭鍏堢骇锛?2. 閽╁瓙鐗瑰畾榛樿鍊硷紙渚嬪 `hooks.gmail.model`锛?3. 鏅鸿兘浣撻厤缃粯璁ゅ€?
### 鎶曢€掞紙娓犻亾 + 鐩爣锛?
闅旂浠诲姟鍙互閫氳繃椤跺眰 `delivery` 閰嶇疆鎶曢€掕緭鍑猴細

- `delivery.mode`锛歚announce`锛堟姇閫掓憳瑕侊級鎴?`none`
- `delivery.channel`锛歚whatsapp` / `telegram` / `discord` / `slack` / `mattermost`锛堟彃浠讹級/ `signal` / `imessage` / `last`
- `delivery.to`锛氭笭閬撶壒瀹氱殑鎺ユ敹鐩爣
- `delivery.bestEffort`锛氭姇閫掑け璐ユ椂閬垮厤浠诲姟澶辫触

褰撳惎鐢?announce 鎶曢€掓椂锛岃杞浼氭姂鍒舵秷鎭伐鍏峰彂閫侊紱璇蜂娇鐢?`delivery.channel`/`delivery.to` 鏉ユ寚瀹氱洰鏍囥€?
濡傛灉鐪佺暐 `delivery.channel` 鎴?`delivery.to`锛屽畾鏃朵换鍔′細鍥為€€鍒颁富浼氳瘽鐨勨€滄渶鍚庤矾鐢扁€濓紙鏅鸿兘浣撴渶鍚庡洖澶嶇殑浣嶇疆锛夈€?
鐩爣鏍煎紡鎻愰啋锛?
- Slack/Discord/Mattermost锛堟彃浠讹級鐩爣搴斾娇鐢ㄦ槑纭墠缂€锛堜緥濡?`channel:<id>`銆乣user:<id>`锛変互閬垮厤姝т箟銆?- Telegram 涓婚搴斾娇鐢?`:topic:` 鏍煎紡锛堣涓嬫枃锛夈€?
#### Telegram 鎶曢€掔洰鏍囷紙涓婚/璁哄潧甯栧瓙锛?
Telegram 閫氳繃 `message_thread_id` 鏀寔璁哄潧涓婚銆傚浜庡畾鏃朵换鍔℃姇閫掞紝浣犲彲浠ュ皢涓婚/甯栧瓙缂栫爜鍒?`to` 瀛楁涓細

- `-1001234567890`锛堜粎鑱婂ぉ ID锛?- `-1001234567890:topic:123`锛堟帹鑽愶細鏄庣‘鐨勪富棰樻爣璁帮級
- `-1001234567890:123`锛堢畝鍐欙細鏁板瓧鍚庣紑锛?
甯﹀墠缂€鐨勭洰鏍囧 `telegram:...` / `telegram:group:...` 涔熷彲鎺ュ彈锛?
- `telegram:group:-1001234567890:topic:123`

## 宸ュ叿璋冪敤鐨?JSON 妯″紡

鐩存帴璋冪敤 Gateway缃戝叧 `cron.*` 宸ュ叿锛堟櫤鑳戒綋宸ュ叿璋冪敤鎴?RPC锛夋椂浣跨敤杩欎簺缁撴瀯銆侰LI 鏍囧織鎺ュ彈浜虹被鍙鐨勬椂闂存牸寮忓 `20m`锛屼絾宸ュ叿璋冪敤搴斾娇鐢?ISO 8601 瀛楃涓蹭綔涓?`schedule.at`锛屽苟浣跨敤姣浣滀负 `schedule.everyMs`銆?
### cron.add 鍙傛暟

涓€娆℃€т富浼氳瘽浠诲姟锛堢郴缁熶簨浠讹級锛?
```json
{
  "name": "Reminder",
  "schedule": { "kind": "at", "at": "2026-02-01T16:00:00Z" },
  "sessionTarget": "main",
  "wakeMode": "now",
  "payload": { "kind": "systemEvent", "text": "Reminder text" },
  "deleteAfterRun": true
}
```

甯︽姇閫掔殑鍛ㄦ湡鎬ч殧绂讳换鍔★細

```json
{
  "name": "Morning brief",
  "schedule": { "kind": "cron", "expr": "0 7 * * *", "tz": "America/Los_Angeles" },
  "sessionTarget": "isolated",
  "wakeMode": "next-heartbeat",
  "payload": {
    "kind": "agentTurn",
    "message": "Summarize overnight updates."
  },
  "delivery": {
    "mode": "announce",
    "channel": "slack",
    "to": "channel:C1234567890",
    "bestEffort": true
  }
}
```

璇存槑锛?
- `schedule.kind`锛歚at`锛坄at`锛夈€乣every`锛坄everyMs`锛夋垨 `cron`锛坄expr`锛屽彲閫?`tz`锛夈€?- `schedule.at` 鎺ュ彈 ISO 8601锛堝彲鐪佺暐鏃跺尯锛涚渷鐣ユ椂鎸?UTC 澶勭悊锛夈€?- `everyMs` 涓烘绉掓暟銆?- `sessionTarget` 蹇呴』涓?`"main"` 鎴?`"isolated"`锛屼笖蹇呴』涓?`payload.kind` 鍖归厤銆?- 鍙€夊瓧娈碉細`agentId`銆乣description`銆乣enabled`銆乣deleteAfterRun`銆乣delivery`銆?- `wakeMode` 鐪佺暐鏃堕粯璁や负 `"next-heartbeat"`銆?
### cron.update 鍙傛暟

```json
{
  "jobId": "job-123",
  "patch": {
    "enabled": false,
    "schedule": { "kind": "every", "everyMs": 3600000 }
  }
}
```

璇存槑锛?
- `jobId` 鏄鑼冨瓧娈碉紱`id` 鍙吋瀹逛娇鐢ㄣ€?- 鍦ㄨˉ涓佷腑浣跨敤 `agentId: null` 鍙竻闄ゆ櫤鑳戒綋缁戝畾銆?
### cron.run 鍜?cron.remove 鍙傛暟

```json
{ "jobId": "job-123", "mode": "force" }
```

```json
{ "jobId": "job-123" }
```

## 瀛樺偍涓庡巻鍙?
- 浠诲姟瀛樺偍锛歚~/.openclaw/cron/jobs.json`锛圙ateway缃戝叧绠＄悊鐨?JSON锛夈€?- 杩愯鍘嗗彶锛歚~/.openclaw/cron/runs/<jobId>.jsonl`锛圝SONL锛岃嚜鍔ㄦ竻鐞嗭級銆?- 瑕嗙洊瀛樺偍璺緞锛氶厤缃腑鐨?`cron.store`銆?
## 閰嶇疆

```json5
{
  cron: {
    enabled: true, // 榛樿 true
    store: "~/.openclaw/cron/jobs.json",
    maxConcurrentRuns: 1, // 榛樿 1
  },
}
```

瀹屽叏绂佺敤瀹氭椂浠诲姟锛?
- `cron.enabled: false`锛堥厤缃級
- `OPENCLAW_SKIP_CRON=1`锛堢幆澧冨彉閲忥級

## CLI 蹇€熷紑濮?
涓€娆℃€ф彁閱掞紙UTC ISO锛屾垚鍔熷悗鑷姩鍒犻櫎锛夛細

```bash
openclaw cron add \
  --name "Send reminder" \
  --at "2026-01-12T18:00:00Z" \
  --session main \
  --system-event "Reminder: submit expense report." \
  --wake now \
  --delete-after-run
```

涓€娆℃€ф彁閱掞紙涓讳細璇濓紝绔嬪嵆鍞ら啋锛夛細

```bash
openclaw cron add \
  --name "Calendar check" \
  --at "20m" \
  --session main \
  --system-event "Next heartbeat: check calendar." \
  --wake now
```

鍛ㄦ湡鎬ч殧绂讳换鍔★紙鎶曢€掑埌 WhatsApp锛夛細

```bash
openclaw cron add \
  --name "Morning status" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize inbox + calendar for today." \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

鍛ㄦ湡鎬ч殧绂讳换鍔★紙鎶曢€掑埌 Telegram 涓婚锛夛細

```bash
openclaw cron add \
  --name "Nightly summary (topic)" \
  --cron "0 22 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize today; send to the nightly topic." \
  --announce \
  --channel telegram \
  --to "-1001234567890:topic:123"
```

甯︽ā鍨嬪拰鎬濈淮瑕嗙洊鐨勯殧绂讳换鍔★細

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 1" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Weekly deep analysis of project progress." \
  --model "opus" \
  --thinking high \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

鏅鸿兘浣撻€夋嫨锛堝鏅鸿兘浣撻厤缃級锛?
```bash
# 灏嗕换鍔＄粦瀹氬埌鏅鸿兘浣?"ops"锛堝鏋滆鏅鸿兘浣撲笉瀛樺湪鍒欏洖閫€鍒伴粯璁ゆ櫤鑳戒綋锛?openclaw cron add --name "Ops sweep" --cron "0 6 * * *" --session isolated --message "Check ops queue" --agent ops

# 鍒囨崲鎴栨竻闄ょ幇鏈変换鍔＄殑鏅鸿兘浣?openclaw cron edit <jobId> --agent ops
openclaw cron edit <jobId> --clear-agent
```

鎵嬪姩杩愯锛堣皟璇曪級锛?
```bash
openclaw cron run <jobId> --force
```

缂栬緫鐜版湁浠诲姟锛堣ˉ涓佸瓧娈碉級锛?
```bash
openclaw cron edit <jobId> \
  --message "Updated prompt" \
  --model "opus" \
  --thinking low
```

杩愯鍘嗗彶锛?
```bash
openclaw cron runs --id <jobId> --limit 50
```

涓嶅垱寤轰换鍔＄洿鎺ュ彂閫佺郴缁熶簨浠讹細

```bash
openclaw system event --mode now --text "Next heartbeat: check battery."
```

## Gateway缃戝叧 API 鎺ュ彛

- `cron.list`銆乣cron.status`銆乣cron.add`銆乣cron.update`銆乣cron.remove`
- `cron.run`锛堝己鍒舵垨鍒版湡锛夈€乣cron.runs`
  濡傞渶涓嶅垱寤轰换鍔＄洿鎺ュ彂閫佺郴缁熶簨浠讹紝璇蜂娇鐢?[`openclaw system event`](/cli/system)銆?
## 鏁呴殰鎺掗櫎

### "娌℃湁浠讳綍浠诲姟杩愯"

- 妫€鏌ュ畾鏃朵换鍔℃槸鍚﹀凡鍚敤锛歚cron.enabled` 鍜?`OPENCLAW_SKIP_CRON`銆?- 妫€鏌?Gateway缃戝叧鏄惁鎸佺画杩愯锛堝畾鏃朵换鍔¤繍琛屽湪 Gateway缃戝叧杩涚▼鍐呴儴锛夈€?- 瀵逛簬 `cron` 璋冨害锛氱‘璁ゆ椂鍖猴紙`--tz`锛変笌涓绘満鏃跺尯鐨勫叧绯汇€?
### Telegram 鎶曢€掑埌浜嗛敊璇殑浣嶇疆

- 瀵逛簬璁哄潧涓婚锛屼娇鐢?`-100鈥?topic:<id>` 浠ョ‘淇濇槑纭棤姝т箟銆?- 濡傛灉浣犲湪鏃ュ織鎴栧瓨鍌ㄧ殑"鏈€鍚庤矾鐢?鐩爣涓湅鍒?`telegram:...` 鍓嶇紑锛岃繖鏄甯哥殑锛涘畾鏃朵换鍔℃姇閫掓帴鍙楄繖浜涘墠缂€骞朵粛鑳芥纭В鏋愪富棰?ID銆?

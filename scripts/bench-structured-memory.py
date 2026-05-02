#!/usr/bin/env python3
"""
SheetMemory classification benchmark — local Ollama models, ZH + EN dirty input.

Usage:
  python3 scripts/bench-structured-memory.py                           # auto models, both langs
  python3 scripts/bench-structured-memory.py --lang zh                 # Chinese only
  python3 scripts/bench-structured-memory.py --lang en                 # English only
  python3 scripts/bench-structured-memory.py --models qwen:7b qwen2.5:3b
  python3 scripts/bench-structured-memory.py --models llama3.2:3b --lang en
  python3 scripts/bench-structured-memory.py --debug                   # raw replies on failure
  python3 scripts/bench-structured-memory.py --csv                     # machine-readable

Requires: Ollama at localhost:11434, Python 3.7+
"""

from __future__ import annotations

import json, re, sys, time, urllib.request, urllib.error

OLLAMA = "http://localhost:11434"
VALID_TYPES = {"fact", "event", "plan", "impression", "preference", "rule"}

PROMPT = """You are a memory classification assistant. Analyze the following text and classify it into a structured memory record.

Classify into ONE of these types:
- fact: A factual statement or piece of knowledge
- event: Something that happened at a point in time
- plan: A future intention, goal, or plan
- impression: A subjective opinion, feeling, or assessment
- preference: A stated like, dislike, or preference
- rule: A conditional rule or constraint

IMPORTANT: type must be EXACTLY one of the six values above. Do NOT invent new types like "comparison", "task", "note", etc. If the text compares two things and the speaker favors one, use "preference".

Assign an importance score (1-10) where:
10 = Critical, must remember (identity, core goals, safety rules)
7-9 = Very important (key preferences, recurring patterns)
4-6 = Moderately important (contextual details)
1-3 = Minor (trivia, passing remarks)

Assign a confidence score (0.0-1.0) based on how clearly the text conveys this information.

Also refine the summary to be concise (100 chars or fewer) and extract key space-separated lowercase keywords.

Respond ONLY with a valid JSON object with these fields:
{
  "type": "<one of: fact, event, plan, impression, preference, rule>",
  "importance": <integer 1-10>,
  "confidence": <number 0.0-1.0>,
  "summary_refined": "<concise summary, 100 chars max>",
  "keywords": "<space-separated lowercase keywords>"
}

Text to classify:"""

# ── test cases ──────────────────────────────────────────────────────
CASES_ZH = [
    # noise-wrapped
    ("noise-rule","rule","哦对了说到这个，我突然想起来上次和老王吃饭的时候他提了一嘴，说他们那边现在所有超过50万的采购单都必须要VP签字的，好像是去年出了个什么合规问题之后加的。"),
    ("noise-pref","preference","就是说，嗯，怎么讲呢，反正我用了这么多年各种工具下来，就是那个感觉你懂吧，TypeScript写后端真的比Python舒服太多了，类型系统摆在那里你不用都安心。"),
    ("noise-event","event","诶我想起来一件事，就上周嘛，也不是什么大事，就是我们的CI管道不知道被谁改了配置，然后所有的部署全红了，搞了三个小时才发现是那个新来的把环境变量名写错了。"),
    # implicit
    ("implicit-rule","rule","之前那个跨部门项目拖了三个月最后还是黄了，老板直接在全员会上说了，以后这种跨部门的需求必须先拉通对齐再动手，不然资源全白烧。"),
    ("implicit-impression","impression","说实话我觉得我撑不到年底了，每天早上起来都不想开电脑，也不是说项目多难，就是那种说不清楚的累。"),
    ("implicit-pref","preference","你看吧，老张那边用Java做的那个服务，光配置文件就十几个，每次改配置都要重启，我都替他累。我们这边Go一个二进制丢上去就跑了，你说这有啥好比的。"),
    # fragmented
    ("frag-plan","plan","下个月...等一下我看看日历，对，15号之前，把那个，就是那个给客户的方案，终稿，得弄完上线。"),
    ("frag-event","event","昨天的事。服务器。凌晨3点。重启了三次。后来发现是内存泄漏。"),
    # negation
    ("neg-fact","fact","不对不对，我之前说错了，不是3月14，我的生日是8月22号，上次填表的时候搞混了。"),
    ("neg-plan","plan","本来定的周三的会取消了，改成周五上午10点，线上，就我们三个人，主要是过一下那个新版的API设计。"),
    # multi-intent
    ("multi-event-plan","event","我昨天跟产品吵了一架，他们那个需求文档写的什么玩意完全没法看，后来老大出来调停，定了下周三下午再碰一次，专门聊排期。"),
    ("multi-fact-plan","plan","反正就这样吧你帮我记一下，两件事：API key周三过期要续，还有我们组新来了个实习生叫王小明，清华的研二。"),
    # boundary
    ("bound-boss","impression","老板说他很看好这个方向。但你知道他的，上个月说看好AIGC，这个月又看好RAG了，下个月估计又是别的。方向变得比翻书还快。"),
    ("bound-rule","rule","代码必须写测试，不写测试别合。这是上次线上事故之后我们组里默认的规矩，虽然没人正式在文档里写过，但大家都认。"),
    ("bound-vague","impression","就那样吧。不好不坏。反正日子照过，需求照写，上线照常。你说有什么特别的，没有。你说有什么不满，好像也没什么。"),
    # code-switching
    ("code-fact","fact","我们新的CTO叫James Chen，之前在Google做了8年的AI infra，他的technical background真的很强，大家可以放心。"),
    ("code-rule","rule","FYI啊，老板今天在standup上说了，all production deployments must go through the change management process，no exceptions。这个算是正式规定下来了。"),
    # hypothetical
    ("hypo-plan","plan","如果下周一的review过了的话，我们就正式启动那个重构项目，争取在Q3结束之前把旧系统全部下线。不过先看周一的结果再说吧。"),
    ("hypo-rule","rule","假设这个bug真的是内存泄漏导致的——其实我基本确定是——那以后所有的C++模块上线之前都得跑一遍valgrind，不能再跳过了。"),
    # sarcasm / passive-aggressive
    ("sarc-impression","impression","哦当然了我们伟大的项目经理又一次在截止日期前两天改了需求，太棒了，我真的好喜欢这种惊喜，每天都有新的挑战呢。"),
    ("passive-rule","rule","也不知道是谁定的规矩，反正我们组现在提PR必须at三个人review，少一个都不行。虽然没人承认是自己定的，但每次违反都会被退回。"),
    # third-party
    ("third-event","event","我听小王说的啊，上周五运维那边出了个大事故——有人在生产库上直接跑了drop table，还好有备份恢复了，整个过程大概四十分钟。"),
    ("third-pref","preference","小李跟我说过他特别讨厌用Jira，觉得太重了，他宁愿用Notion加一个简单的看板。我自己其实无所谓，但他每次提到Jira就要吐槽十分钟。"),
    # very short
    ("short-fact","fact","对了，我邮箱是zhangsan@gmail.com。"),
    ("short-plan","plan","下午三点开会。别忘了。"),
]

CASES_EN = [
    # noise-wrapped
    ("noise-rule","rule","Oh by the way, speaking of that, I just remembered — when I grabbed lunch with Mark last month he mentioned that their legal team now requires VP sign-off on any procurement over $500k. Something about an audit finding from last year, apparently."),
    ("noise-pref","preference","So, like, I've been using all kinds of tools over the years and honestly, you know what I mean, TypeScript for backend just feels so much safer than Python. The type system catches stuff before it blows up, you don't even have to think about it."),
    ("noise-event","event","Oh right I almost forgot — last Tuesday, not a huge deal, but someone changed the CI pipeline config and every single deployment went red. Took us three hours to figure out the new hire had renamed an environment variable without telling anyone."),
    # implicit
    ("implicit-rule","rule","That cross-team project dragged on for three months and then just died. The VP called an all-hands and basically said any project that touches more than one team now needs a formal alignment meeting before anyone writes a line of code. No exceptions."),
    ("implicit-impression","impression","Honestly I don't think I'm going to make it to the end of the year. Every morning I just stare at my laptop and don't want to open it. It's not that the work is hard exactly, it's just this... weight. I can't really explain it."),
    ("implicit-pref","preference","Look at Dave's team — their Java service has like a dozen config files and every time they tweak anything they have to restart the whole thing. Meanwhile our Go binary is a single artifact you just drop on the server and it runs. I mean, what's even the comparison here."),
    # fragmented
    ("frag-plan","plan","Next month... hold on let me check the calendar, yeah, by the 15th. That proposal for the client. The final version. Needs to be done and shipped."),
    ("frag-event","event","Yesterday. The server. 3 AM. Restarted three times. Memory leak, turns out."),
    # negation
    ("neg-fact","fact","No wait, I got that wrong last time. My birthday isn't March 14th, it's August 22nd. I mixed it up when I was filling out that form."),
    ("neg-plan","plan","The Wednesday meeting got cancelled. Moved to Friday 10 AM, online, just the three of us. Mainly to walk through the new API design."),
    # multi-intent
    ("multi-event-plan","event","I got into a huge argument with the product manager yesterday — their spec doc was completely unreadable — and then our manager stepped in and we agreed to meet again next Wednesday afternoon just to sort out the timeline."),
    ("multi-fact-plan","plan","Alright just help me jot this down — two things: the API key expires Wednesday and needs renewing, and we have a new intern starting named Sarah Chen, she's a grad student from MIT."),
    # boundary
    ("bound-boss","impression","Our CEO says he's super bullish on this direction. But honestly, you know how he is — last month it was all about AIGC, this month it's RAG, next month it'll be something else entirely. The guy changes direction faster than I can update my slides."),
    ("bound-rule","rule","You don't merge without tests. Period. It's been the unwritten rule on our team ever since that outage last spring. Nobody put it in a doc, nobody officially said it, but everyone knows."),
    ("bound-vague","impression","It's fine I guess. Not great, not terrible. Days go by, tickets come in, deployments roll out. Is there anything special going on? Not really. Is there anything I'm unhappy about? I mean, nothing specific."),
    # code-switching
    ("code-fact","fact","Our new CTO just started this week — name's James Chen, ex-Google, did AI infra there for 8 years. His technical background is legit, I think we're in good hands."),
    ("code-rule","rule","FYI — the CEO announced in standup today that all production deployments now require a change management ticket. No exceptions. This is正式的 now, not just a suggestion."),
    # hypothetical
    ("hypo-plan","plan","If the architecture review passes next Monday, we'll officially kick off the refactoring project and try to sunset the legacy system by end of Q3. But let's see how Monday goes first."),
    ("hypo-rule","rule","Assuming this really is a memory leak — and I'm 90% sure it is — we need to make valgrind mandatory for every C++ module before it hits production. Can't keep skipping it."),
    # sarcasm / passive-aggressive
    ("sarc-impression","impression","Oh absolutely *love* it when our brilliant PM changes the requirements two days before the deadline. It's just the best feeling. Keeps life exciting, you know?"),
    ("passive-rule","rule","Nobody will admit to making this rule, but every PR in our repo now requires three reviewer approvals. Try to merge with two and it gets rejected instantly. It's just how things work now."),
    # third-party
    ("third-event","event","I heard from Dave that ops had a massive incident last Friday — someone accidentally ran a drop table in production. They recovered from backup, but the whole thing lasted about forty minutes."),
    ("third-pref","preference","My coworker Sarah absolutely hates Jira — she says it's way too heavy and she'd rather use Notion with a simple kanban board. I don't really care either way but every time Jira comes up she goes on a ten-minute rant."),
    # very short
    ("short-fact","fact","btw my email is james.chen@gmail.com"),
    ("short-plan","plan","Meeting at 3pm. Don't forget."),
]

# ── helpers ─────────────────────────────────────────────────────────

def parse_classification(raw: str) -> dict | None:
    """Extract a valid classification JSON from model output."""
    trimmed = raw.strip()
    if not trimmed:
        return None

    candidates: list[str] = []
    fenced = re.sub(r"```(?:json)?\s*", "", trimmed)
    fenced = re.sub(r"```", "", fenced)
    if fenced.strip() != trimmed:
        candidates.append(fenced.strip())
    candidates.extend(re.findall(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", trimmed))
    m = re.search(r"\{[\s\S]*\}", trimmed)
    if m:
        candidates.append(m.group(0))

    seen: set[str] = set()
    for json_str in candidates:
        if json_str in seen: continue
        seen.add(json_str)
        try:
            obj = json.loads(json_str)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict): continue
        if not obj.get("type") or not obj.get("summary_refined"): continue
        if not isinstance(obj.get("importance"), (int, float)): continue
        if not isinstance(obj.get("confidence"), (int, float)): continue
        if obj["type"] not in VALID_TYPES: continue
        return {
            "type": obj["type"],
            "importance": max(1, min(10, round(obj["importance"]))),
            "confidence": max(0.0, min(1.0, float(obj["confidence"]))),
            "summary_refined": str(obj["summary_refined"])[:100],
            "keywords": str(obj.get("keywords", "")).lower().replace(",", " ").strip(),
        }
    return None


def call_ollama(model: str, text: str, timeout_s: int = 120) -> tuple[str, float, dict | None]:
    """Returns (response_text, elapsed_seconds, full_api_response_or_None)."""
    full_prompt = f"{PROMPT} {text}"
    num_predict = 1024 if any(t in model.lower() for t in ("gemma", "26b", "27b")) else 256
    body = json.dumps({
        "model": model,
        "stream": False,
        "options": {"temperature": 0.0, "num_predict": num_predict},
        "messages": [{"role": "user", "content": full_prompt}],
    }).encode()

    t0 = time.time()
    req = urllib.request.Request(
        f"{OLLAMA}/api/chat", data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read())
    except urllib.error.URLError as e:
        return "", time.time() - t0, {"error": str(e)}

    elapsed = time.time() - t0
    msg = data.get("message", {}) or {}
    content = msg.get("content", "")
    if not content.strip() and msg.get("thinking"):
        content = msg["thinking"]
    return content, elapsed, data


def list_ollama_models() -> list[str]:
    try:
        with urllib.request.urlopen(f"{OLLAMA}/api/tags", timeout=5) as resp:
            return [m["name"] for m in json.loads(resp.read()).get("models", [])]
    except Exception:
        return []


def resolve_models(available: list[str], requested: list[str] | None) -> list[str]:
    if requested: return requested
    models = []
    for prefix in ("qwen:7b", "qwen2.5:7b", "gemma3:27b"):
        if any(m.startswith(prefix) or m == prefix for m in available):
            models.append(prefix); break
    for prefix in ("qwen2.5:3b", "qwen:3b"):
        if any(m.startswith(prefix) or m == prefix for m in available):
            models.append(prefix); break
    return models or available[:2]


# ── runner ───────────────────────────────────────────────────────────

def run_bench(models: list[str], cases: list, lang: str, *, debug: bool = False):
    header = f"  {'case':<24s} {'expect':<12s}"
    for _ in models:
        header += f" {'got':<12s} {'imp':>3s} {'conf':>5s} {'time':>6s}"
    print(header)
    print(f"  {'-' * (len(header) - 2)}")

    stats: dict[str, dict] = {m: {"type_ok": 0, "parse_ok": 0, "total": 0, "times": []} for m in models}

    for case_id, expected_type, text in cases:
        row = f"  {case_id:<24s} {expected_type:<12s}"
        for model in models:
            reply, elapsed, full_resp = call_ollama(model, text)
            classification = parse_classification(reply)
            stats[model]["total"] += 1
            stats[model]["times"].append(elapsed)
            if classification:
                stats[model]["parse_ok"] += 1
                if classification["type"] == expected_type:
                    stats[model]["type_ok"] += 1
                    row += f" \033[32m{classification['type']:<12s}\033[0m"
                else:
                    row += f" \033[33m{classification['type']:<12s}\033[0m"
                row += f" {classification['importance']:>3d} {classification['confidence']:>5.2f} {elapsed:>5.1f}s"
            else:
                row += f" \033[31m{'PARSE_FAIL':<12s}\033[0m {'-':>3s} {'-':>5s} {elapsed:>5.1f}s"
                if debug and reply.strip():
                    print(f"       [{model}] raw: {reply[:300]}")
                elif not reply.strip() and debug:
                    done = full_resp.get("done_reason", "?") if full_resp else "?"
                    eval_count = full_resp.get("eval_count", 0) if full_resp else 0
                    thinking_len = len((full_resp.get("message", {}) or {}).get("thinking", "")) if full_resp else 0
                    print(f"       [{model}] EMPTY  done_reason={done} eval_count={eval_count} thinking_len={thinking_len}")
        print(row)

    print(f"\n  {'='*60}")
    print(f"  Language: {lang}")
    print(f"  {'Model':<25s} {'Accuracy':>10s} {'Parse':>10s} {'Avg Lat':>10s}")
    print(f"  {'-'*55}")
    for model in models:
        s = stats[model]
        acc = s["type_ok"] / s["total"] * 100 if s["total"] else 0
        parse_rate = s["parse_ok"] / s["total"] * 100 if s["total"] else 0
        avg_lat = sum(s["times"]) / len(s["times"]) if s["times"] else 0
        print(f"  {model:<25s} {acc:>8.0f}%  {parse_rate:>8.0f}%  {avg_lat:>8.1f}s")
    return stats


def csv_output(all_stats: dict):
    print("model,lang,accuracy,parse_rate,avg_latency")
    for key, s in all_stats.items():
        acc = s["type_ok"] / s["total"] * 100 if s["total"] else 0
        parse_rate = s["parse_ok"] / s["total"] * 100 if s["total"] else 0
        avg_lat = sum(s["times"]) / len(s["times"]) if s["times"] else 0
        print(f"{key},{acc:.1f},{parse_rate:.1f},{avg_lat:.2f}")


# ── main ─────────────────────────────────────────────────────────────

def main():
    args = sys.argv[1:]
    debug = "--debug" in args
    csv_mode = "--csv" in args
    args = [a for a in args if a not in ("--debug", "--csv")]

    lang = "both"
    models_requested = None
    i = 0
    while i < len(args):
        if args[i] == "--lang" and i + 1 < len(args):
            lang = args[i + 1]; i += 2
        elif args[i] == "--models":
            models_requested = []; i += 1
            while i < len(args) and not args[i].startswith("--"):
                models_requested.append(args[i]); i += 1
        else:
            print(f"Unknown arg: {args[i]}"); sys.exit(1)

    available = list_ollama_models()
    if not available:
        print("ERROR: Cannot reach Ollama at localhost:11434"); sys.exit(1)

    models = resolve_models(available, models_requested)
    print(f"Models: {models}")

    all_stats = {}
    for lg in (["zh", "en"] if lang == "both" else [lang]):
        cases = CASES_ZH if lg == "zh" else CASES_EN
        print(f"\n{'#'*70}")
        print(f"#  SheetMemory Classification Benchmark — {lg.upper()} ({len(cases)} cases)")
        print(f"{'#'*70}")
        s = run_bench(models, cases, lg, debug=debug)
        for model, st in s.items():
            all_stats[f"{model}|{lg}"] = st

    if csv_mode:
        csv_output(all_stats)


if __name__ == "__main__":
    main()

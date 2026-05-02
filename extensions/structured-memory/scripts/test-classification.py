#!/usr/bin/env python3
"""
Test structured-memory classification prompt against local Ollama models.

Usage:
  python3 scripts/test-classification.py                         # test auto-detected models (zh)
  python3 scripts/test-classification.py qwen2.5:7b               # test specific model (zh)
  python3 scripts/test-classification.py qwen:7b qwen2.5:3b      # compare two models (zh)
  python3 scripts/test-classification.py --lang=en               # English test set
  python3 scripts/test-classification.py --lang=en qwen:7b llama3.2:3b
  python3 scripts/test-classification.py --all                   # all available models
  python3 scripts/test-classification.py --debug                 # show raw output on failure

Requires: ollama (HTTP API at localhost:11434)
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
import urllib.request
import urllib.error

OLLAMA_URL = "http://localhost:11434"

# ── prompt: identical to extensions/structured-memory/src/tools.ts ──
PROMPT_PREFIX = """You are a memory classification assistant. Analyze the following text and classify it into a structured memory record.

Classify into ONE of these types:
- fact: A factual statement or piece of knowledge
- event: Something that happened at a point in time
- plan: A future intention, goal, or plan
- impression: A subjective opinion, feeling, or assessment
- preference: A stated like, dislike, or preference
- rule: A conditional rule or constraint

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

# ── test cases: (id, expected_type, text, note) ──
# CASES_ZH: Chinese dirty input — noise, implicit, fragmented, negation, multi-intent, boundary.
CASES_ZH = [
    # ── noise-wrapped ──
    ("noise-rule",
     "rule",
     "哦对了说到这个，我突然想起来上次和老王吃饭的时候他提了一嘴，说他们那边现在所有超过50万的采购单都必须要VP签字的，好像是去年出了个什么合规问题之后加的。"
    ),
    ("noise-pref",
     "preference",
     "就是说，嗯，怎么讲呢，反正我用了这么多年各种工具下来，就是那个感觉你懂吧，TypeScript写后端真的比Python舒服太多了，类型系统摆在那里你不用都安心。"
    ),
    ("noise-event",
     "event",
     "诶我想起来一件事，就上周嘛，也不是什么大事，就是我们的CI管道不知道被谁改了配置，然后所有的部署全红了，搞了三个小时才发现是那个新来的把环境变量名写错了。"
    ),
    # ── implicit ──
    ("implicit-rule",
     "rule",
     "之前那个跨部门项目拖了三个月最后还是黄了，老板直接在全员会上说了，以后这种跨部门的需求必须先拉通对齐再动手，不然资源全白烧。"
    ),
    ("implicit-impression",
     "impression",
     "说实话我觉得我撑不到年底了，每天早上起来都不想开电脑，也不是说项目多难，就是那种说不清楚的累。"
    ),
    ("implicit-pref",
     "preference",
     "你看吧，老张那边用Java做的那个服务，光配置文件就十几个，每次改配置都要重启，我都替他累。我们这边Go一个二进制丢上去就跑了，你说这有啥好比的。"
    ),
    # ── fragmented ──
    ("frag-plan",
     "plan",
     "下个月...等一下我看看日历，对，15号之前，把那个，就是那个给客户的方案，终稿，得弄完上线。"
    ),
    ("frag-event",
     "event",
     "昨天的事。服务器。凌晨3点。重启了三次。后来发现是内存泄漏。"
    ),
    # ── negation / correction ──
    ("neg-fact",
     "fact",
     "不对不对，我之前说错了，不是3月14，我的生日是8月22号，上次填表的时候搞混了。"
    ),
    ("neg-plan",
     "plan",
     "本来定的周三的会取消了，改成周五上午10点，线上，就我们三个人，主要是过一下那个新版的API设计。"
    ),
    # ── multi-intent ──
    ("multi-event-plan",
     "event",
     "我昨天跟产品吵了一架，他们那个需求文档写的什么玩意完全没法看，后来老大出来调停，定了下周三下午再碰一次，专门聊排期。"
    ),
    ("multi-fact-plan",
     "plan",
     "反正就这样吧你帮我记一下，两件事：API key周三过期要续，还有我们组新来了个实习生叫王小明，清华的研二。"
    ),
    # ── boundary-ambiguous ──
    ("bound-boss",
     "impression",
     "老板说他很看好这个方向。但你知道他的，上个月说看好AIGC，这个月又看好RAG了，下个月估计又是别的。方向变得比翻书还快。"
    ),
    ("bound-rule",
     "rule",
     "代码必须写测试，不写测试别合。这是上次线上事故之后我们组里默认的规矩，虽然没人正式在文档里写过，但大家都认。"
    ),
    ("bound-vague",
     "impression",
     "就那样吧。不好不坏。反正日子照过，需求照写，上线照常。你说有什么特别的，没有。你说有什么不满，好像也没什么。"
    ),
    # ── code-switching ──
    ("code-fact",
     "fact",
     "我们新的CTO叫James Chen，之前在Google做了8年的AI infra，他的technical background真的很强，大家可以放心。"
    ),
    ("code-rule",
     "rule",
     "FYI啊，老板今天在standup上说了，all production deployments must go through the change management process，no exceptions。这个算是正式规定下来了。"
    ),
    # ── hypothetical ──
    ("hypo-plan",
     "plan",
     "如果下周一的review过了的话，我们就正式启动那个重构项目，争取在Q3结束之前把旧系统全部下线。不过先看周一的结果再说吧。"
    ),
    ("hypo-rule",
     "rule",
     "假设这个bug真的是内存泄漏导致的——其实我基本确定是——那以后所有的C++模块上线之前都得跑一遍valgrind，不能再跳过了。"
    ),
    # ── sarcasm / passive-aggressive ──
    ("sarc-impression",
     "impression",
     "哦当然了我们伟大的项目经理又一次在截止日期前两天改了需求，太棒了，我真的好喜欢这种惊喜，每天都有新的挑战呢。"
    ),
    ("passive-rule",
     "rule",
     "也不知道是谁定的规矩，反正我们组现在提PR必须at三个人review，少一个都不行。虽然没人承认是自己定的，但每次违反都会被退回。"
    ),
    # ── third-party recounting ──
    ("third-event",
     "event",
     "我听小王说的啊，上周五运维那边出了个大事故——有人在生产库上直接跑了drop table，还好有备份恢复了，整个过程大概四十分钟。"
    ),
    ("third-pref",
     "preference",
     "小李跟我说过他特别讨厌用Jira，觉得太重了，他宁愿用Notion加一个简单的看板。我自己其实无所谓，但他每次提到Jira就要吐槽十分钟。"
    ),
    # ── very short ──
    ("short-fact",
     "fact",
     "对了，我邮箱是zhangsan@gmail.com。"
    ),
    ("short-plan",
     "plan",
     "下午三点开会。别忘了。"
    ),
]

# CASES_EN: English dirty input — same challenge dimensions.
CASES_EN = [
    # ── noise-wrapped ──
    ("noise-rule",
     "rule",
     "Oh by the way, speaking of that, I just remembered — when I grabbed lunch with Mark last month he mentioned that their legal team now requires VP sign-off on any procurement over $500k. Something about an audit finding from last year, apparently."
    ),
    ("noise-pref",
     "preference",
     "So, like, I've been using all kinds of tools over the years and honestly, you know what I mean, TypeScript for backend just feels so much safer than Python. The type system catches stuff before it blows up, you don't even have to think about it."
    ),
    ("noise-event",
     "event",
     "Oh right I almost forgot — last Tuesday, not a huge deal, but someone changed the CI pipeline config and every single deployment went red. Took us three hours to figure out the new hire had renamed an environment variable without telling anyone."
    ),
    # ── implicit ──
    ("implicit-rule",
     "rule",
     "That cross-team project dragged on for three months and then just died. The VP called an all-hands and basically said any project that touches more than one team now needs a formal alignment meeting before anyone writes a line of code. No exceptions."
    ),
    ("implicit-impression",
     "impression",
     "Honestly I don't think I'm going to make it to the end of the year. Every morning I just stare at my laptop and don't want to open it. It's not that the work is hard exactly, it's just this... weight. I can't really explain it."
    ),
    ("implicit-pref",
     "preference",
     "Look at Dave's team — their Java service has like a dozen config files and every time they tweak anything they have to restart the whole thing. Meanwhile our Go binary is a single artifact you just drop on the server and it runs. I mean, what's even the comparison here."
    ),
    # ── fragmented ──
    ("frag-plan",
     "plan",
     "Next month... hold on let me check the calendar, yeah, by the 15th. That proposal for the client. The final version. Needs to be done and shipped."
    ),
    ("frag-event",
     "event",
     "Yesterday. The server. 3 AM. Restarted three times. Memory leak, turns out."
    ),
    # ── negation / correction ──
    ("neg-fact",
     "fact",
     "No wait, I got that wrong last time. My birthday isn't March 14th, it's August 22nd. I mixed it up when I was filling out that form."
    ),
    ("neg-plan",
     "plan",
     "The Wednesday meeting got cancelled. Moved to Friday 10 AM, online, just the three of us. Mainly to walk through the new API design."
    ),
    # ── multi-intent ──
    ("multi-event-plan",
     "event",
     "I got into a huge argument with the product manager yesterday — their spec doc was completely unreadable — and then our manager stepped in and we agreed to meet again next Wednesday afternoon just to sort out the timeline."
    ),
    ("multi-fact-plan",
     "plan",
     "Alright just help me jot this down — two things: the API key expires Wednesday and needs renewing, and we have a new intern starting named Sarah Chen, she's a grad student from MIT."
    ),
    # ── boundary-ambiguous ──
    ("bound-boss",
     "impression",
     "Our CEO says he's super bullish on this direction. But honestly, you know how he is — last month it was all about AIGC, this month it's RAG, next month it'll be something else entirely. The guy changes direction faster than I can update my slides."
    ),
    ("bound-rule",
     "rule",
     "You don't merge without tests. Period. It's been the unwritten rule on our team ever since that outage last spring. Nobody put it in a doc, nobody officially said it, but everyone knows."
    ),
    ("bound-vague",
     "impression",
     "It's fine I guess. Not great, not terrible. Days go by, tickets come in, deployments roll out. Is there anything special going on? Not really. Is there anything I'm unhappy about? I mean, nothing specific."
    ),
    # ── code-switching ──
    ("code-fact",
     "fact",
     "Our new CTO just started this week — name's James Chen, ex-Google, did AI infra there for 8 years. His technical background is legit, I think we're in good hands."
    ),
    ("code-rule",
     "rule",
     "FYI — the CEO announced in standup today that all production deployments now require a change management ticket. No exceptions. This is正式的 now, not just a suggestion."
    ),
    # ── hypothetical ──
    ("hypo-plan",
     "plan",
     "If the architecture review passes next Monday, we'll officially kick off the refactoring project and try to sunset the legacy system by end of Q3. But let's see how Monday goes first."
    ),
    ("hypo-rule",
     "rule",
     "Assuming this really is a memory leak — and I'm 90% sure it is — we need to make valgrind mandatory for every C++ module before it hits production. Can't keep skipping it."
    ),
    # ── sarcasm / passive-aggressive ──
    ("sarc-impression",
     "impression",
     "Oh absolutely *love* it when our brilliant PM changes the requirements two days before the deadline. It's just the best feeling. Keeps life exciting, you know?"
    ),
    ("passive-rule",
     "rule",
     "Nobody will admit to making this rule, but every PR in our repo now requires three reviewer approvals. Try to merge with two and it gets rejected instantly. It's just how things work now."
    ),
    # ── third-party recounting ──
    ("third-event",
     "event",
     "I heard from Dave that ops had a massive incident last Friday — someone accidentally ran a drop table in production. They recovered from backup, but the whole thing lasted about forty minutes."
    ),
    ("third-pref",
     "preference",
     "My coworker Sarah absolutely hates Jira — she says it's way too heavy and she'd rather use Notion with a simple kanban board. I don't really care either way but every time Jira comes up she goes on a ten-minute rant."
    ),
    # ── very short ──
    ("short-fact",
     "fact",
     "btw my email is james.chen@gmail.com"
    ),
    ("short-plan",
     "plan",
     "Meeting at 3pm. Don't forget."
    ),
]

#  active test set
CASES = CASES_ZH

VALID_TYPES = {"fact", "event", "plan", "impression", "preference", "rule"}


def parse_classification(raw: str) -> dict | None:
    """Same logic as parseClassificationResponse in tools.ts, with extra
    resilience for local models that wrap JSON in fences or add commentary."""
    trimmed = raw.strip()
    if not trimmed:
        return None

    # Try multiple extraction strategies, in order.
    candidates: list[str] = []

    # Strategy 1: strip ```json / ``` fences
    fenced = re.sub(r"```(?:json)?\s*", "", trimmed)
    fenced = re.sub(r"```", "", fenced)
    if fenced.strip() != trimmed:
        candidates.append(fenced.strip())

    # Strategy 2: extract ALL { ... } blocks (handle nested objects in
    # "attributes" etc.) and try each from longest to shortest.
    all_blocks = re.findall(r"\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}", trimmed)
    candidates.extend(all_blocks)

    # Strategy 3: greedy single block (original logic)
    m = re.search(r"\{[\s\S]*\}", trimmed)
    if m:
        candidates.append(m.group(0))

    # Deduplicate while preserving order.
    seen: set[str] = set()
    ordered: list[str] = []
    for c in candidates:
        if c not in seen:
            seen.add(c)
            ordered.append(c)

    for json_str in ordered:
        try:
            obj = json.loads(json_str)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue
        if not obj.get("type") or not obj.get("summary_refined"):
            continue
        if not isinstance(obj.get("importance"), (int, float)):
            continue
        if not isinstance(obj.get("confidence"), (int, float)):
            continue
        if obj["type"] not in VALID_TYPES:
            continue
        return {
            "type": obj["type"],
            "importance": max(1, min(10, round(obj["importance"]))),
            "confidence": max(0.0, min(1.0, float(obj["confidence"]))),
            "summary_refined": str(obj["summary_refined"])[:100],
            "keywords": (
                str(obj.get("keywords", ""))
                .lower()
                .replace(",", " ")
                .strip()
            ),
        }

    return None


def call_ollama(model: str, prompt: str, timeout_s: int = 180, debug: bool = False) -> tuple[str, float, dict | None]:
    """Call Ollama chat API, return (response_text, elapsed_seconds, full_response_or_none)."""
    # Thinking models (Gemma 4, etc.) spend tokens on internal reasoning.
    # Use a generous budget; classification only needs ~80 tokens, but
    # thinking can consume 300+ before producing output.
    num_predict = 1024 if "gemma" in model.lower() or "26b" in model.lower() or "27b" in model.lower() else 256
    body = json.dumps({
        "model": model,
        "stream": False,
        "options": {"temperature": 0.0, "num_predict": num_predict},
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = json.loads(resp.read())
        elapsed = time.time() - t0
        msg = data.get("message", {}) or {}
        content = msg.get("content", "")
        # Thinking models (Gemma 4) may put reasoning in "thinking" and leave
        # "content" empty if num_predict was too low. Fall back to the thinking
        # field to salvage a partial classification.
        if not content.strip() and msg.get("thinking"):
            content = msg["thinking"]
        return content, elapsed, data if debug else None
    except urllib.error.URLError as e:
        elapsed = time.time() - t0
        raise RuntimeError(f"HTTP error: {e}") from e


DEBUG = False  # set by --debug flag


def test_model(model: str) -> dict:
    """Run all cases against one model, return stats."""
    print(f"\n{'='*60}")
    print(f"  Model: {model}")
    print(f"{'='*60}")

    results = []
    total_elapsed = 0.0
    pass_count = 0
    type_match = 0
    fail_count = 0
    parse_fail = 0

    for case_id, expected_type, text in CASES:
        full_prompt = f"{PROMPT_PREFIX} {text}"

        try:
            reply, elapsed, full_resp = call_ollama(model, full_prompt, debug=DEBUG)
            total_elapsed += elapsed
        except RuntimeError as e:
            print(f"  [{case_id}] ERROR: {e}")
            fail_count += 1
            continue

        classification = parse_classification(reply)
        type_ok = classification and classification["type"] == expected_type

        status = "✓" if (classification and type_ok) else ("⚠" if classification else "✗")
        if classification:
            pass_count += 1
            if type_ok:
                type_match += 1
        else:
            parse_fail += 1
            fail_count += 1

        print(f"  {status} [{case_id:20s}] expect={expected_type:12s} "
              f"got={classification['type'] if classification else 'PARSE_FAIL':12s} "
              f"imp={classification['importance'] if classification else '-':>3} "
              f"conf={classification['confidence'] if classification else '-':>5} "
              f"{elapsed:5.1f}s")

        # show raw reply on parse failure for debugging
        if not classification:
            if DEBUG:
                print(f"       --- RAW REPLY ---\n{reply}\n       --- END RAW ---")
                if full_resp:
                    print(f"       --- FULL API RESPONSE ---")
                    print(json.dumps(full_resp, indent=2, ensure_ascii=False))
                    print(f"       --- END API RESPONSE ---")
            else:
                print(f"       reply empty, add --debug to see full API response" if not reply.strip() else f"       raw: {reply[:200]}...")

        results.append({
            "case": case_id,
            "expected_type": expected_type,
            "classification": classification,
            "raw_reply": reply[:300] if not classification else None,
        })

    avg_time = total_elapsed / len(CASES) if CASES else 0
    accuracy = type_match / len(CASES) * 100 if CASES else 0
    parse_rate = pass_count / len(CASES) * 100 if CASES else 0

    print(f"  ── Summary ──")
    print(f"  Type accuracy : {type_match}/{len(CASES)} ({accuracy:.0f}%)")
    print(f"  Parse success : {pass_count}/{len(CASES)} ({parse_rate:.0f}%)")
    print(f"  Avg latency   : {avg_time:.1f}s")
    print(f"  Total time    : {total_elapsed:.1f}s")

    return {
        "model": model,
        "accuracy": accuracy,
        "parse_rate": parse_rate,
        "avg_latency": avg_time,
        "total_time": total_elapsed,
        "results": results,
    }


def list_ollama_models() -> list[str]:
    """Get list of available Ollama models."""
    try:
        with urllib.request.urlopen(f"{OLLAMA_URL}/api/tags", timeout=5) as resp:
            data = json.loads(resp.read())
        return [m["name"] for m in data.get("models", [])]
    except Exception:
        return []


def main():
    global DEBUG, CASES
    DEBUG = "--debug" in sys.argv
    sys.argv = [a for a in sys.argv if a != "--debug"]

    if "--lang=en" in sys.argv:
        CASES = CASES_EN
        sys.argv = [a for a in sys.argv if a != "--lang=en"]
    elif "--lang=zh" in sys.argv:
        CASES = CASES_ZH
        sys.argv = [a for a in sys.argv if a != "--lang=zh"]

    available = list_ollama_models()

    if not available:
        print("ERROR: Could not reach Ollama at localhost:11434")
        print("Make sure 'ollama serve' is running.")
        sys.exit(1)

    print(f"Available models: {', '.join(available[:10])}"
          + (f" ... (+{len(available)-10})" if len(available) > 10 else ""))

    # resolve models to test
    if "--all" in sys.argv:
        models = [m for m in available if any(
            tag in m.lower() for tag in ["gemma", "qwen", "llama", "mistral"]
        )]
        if not models:
            models = available
    elif len(sys.argv) > 1:
        models = [a for a in sys.argv[1:] if not a.startswith("--")]
    else:
        # default: try gemma then qwen
        models = []
        for prefix in ["gemma3:27b", "gemma2:27b", "gemma:27b"]:
            if any(m.startswith(prefix) or m == prefix for m in available):
                models.append(prefix)
                break
        for prefix in ["qwen2.5:7b", "qwen3:7b", "qwen:7b"]:
            if any(m.startswith(prefix) or m == prefix for m in available):
                models.append(prefix)
                break
        if not models:
            print("Could not auto-detect gemma/qwen models.")
            print(f"Available: {available}")
            print("Pass model name(s) explicitly: python3 test-classification.py <model> [model2]")
            sys.exit(1)

    print(f"Will test: {models}")

    # run tests
    all_stats = []
    for model in models:
        stats = test_model(model)
        all_stats.append(stats)

    # comparison
    if len(all_stats) > 1:
        print(f"\n{'='*60}")
        print(f"  Comparison")
        print(f"{'='*60}")
        print(f"  {'Model':<25s} {'Accuracy':>10s} {'Parse':>10s} {'Avg Lat':>10s}")
        print(f"  {'-'*55}")
        for s in all_stats:
            print(f"  {s['model']:<25s} {s['accuracy']:>8.0f}%  {s['parse_rate']:>8.0f}%  {s['avg_latency']:>8.1f}s")


if __name__ == "__main__":
    main()

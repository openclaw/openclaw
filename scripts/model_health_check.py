"""Model Health Check — stress-tests every model/role in openclaw_config.json.

Runs programmatic checks without Telegram, outputs a summary matrix:
  [Model] -> [Role] -> [Tool Call Parsing (Pass/Fail)] -> [Response Time ms]

Usage:
  python -m scripts.model_health_check
  python scripts/model_health_check.py
"""

import asyncio
import json
import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

# Ensure project root is on path
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

# Load .env so OPENROUTER_API_KEY is available
try:
    from dotenv import load_dotenv
    load_dotenv(PROJECT_ROOT / ".env")
except ImportError:
    pass


@dataclass
class CheckResult:
    """Result of a single model health check."""
    role: str
    model: str
    brigade: str
    test_name: str
    passed: bool
    response_ms: float = 0.0
    response_preview: str = ""
    error: str = ""
    tool_parse_status: str = "N/A"  # Pass / Fail / N/A


@dataclass
class HealthReport:
    """Aggregated health report."""
    results: List[CheckResult] = field(default_factory=list)
    total_pass: int = 0
    total_fail: int = 0
    youtube_test: Optional[CheckResult] = None

    def add(self, r: CheckResult):
        self.results.append(r)
        if r.passed:
            self.total_pass += 1
        else:
            self.total_fail += 1

    def to_matrix(self) -> str:
        """Format as text table."""
        lines = []
        lines.append("=" * 95)
        lines.append(f"{'Model':<45} {'Role':<20} {'Tool Parse':<12} {'Time(ms)':<10} {'Status'}")
        lines.append("-" * 95)
        for r in self.results:
            status = "✅ PASS" if r.passed else "❌ FAIL"
            lines.append(
                f"{r.model[:44]:<45} {r.role:<20} {r.tool_parse_status:<12} "
                f"{r.response_ms:<10.0f} {status}"
            )
            if not r.passed and r.error:
                lines.append(f"  └─ Error: {r.error[:80]}")
        lines.append("-" * 95)
        lines.append(f"Total: {self.total_pass} PASS / {self.total_fail} FAIL / {len(self.results)} checks")
        if self.youtube_test:
            yt_status = "✅ PASS" if self.youtube_test.passed else "❌ FAIL"
            lines.append(f"YouTube: {yt_status} — {self.youtube_test.response_preview[:60]}")
        lines.append("=" * 95)
        return "\n".join(lines)

    def to_telegram_text(self) -> str:
        """Format for Telegram (plain text, no Markdown)."""
        lines = []
        lines.append("📊 MODEL HEALTH CHECK REPORT")
        lines.append("")
        for r in self.results:
            icon = "✅" if r.passed else "❌"
            lines.append(f"{icon} {r.role} ({r.model[:30]})")
            lines.append(f"   Tool Parse: {r.tool_parse_status} | {r.response_ms:.0f}ms")
            if not r.passed and r.error:
                lines.append(f"   Error: {r.error[:60]}")
        lines.append("")
        lines.append(f"Result: {self.total_pass}/{len(self.results)} PASS")
        if self.youtube_test:
            yt_icon = "✅" if self.youtube_test.passed else "❌"
            lines.append(f"\n🎥 YouTube parser: {yt_icon} {self.youtube_test.response_preview[:60]}")
        return "\n".join(lines)


async def _call_model(api_key: str, model: str, system_prompt: str, user_prompt: str,
                      timeout_sec: int = 60, max_retries: int = 3) -> tuple:
    """Call OpenRouter model with retry on 429. Returns (response_text, elapsed_ms, error)."""
    import aiohttp

    base_url = "https://openrouter.ai/api/v1"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://openclaw.bot",
        "X-Title": "OpenClaw_HealthCheck",
    }
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt or f"You are a helpful assistant."},
            {"role": "user", "content": user_prompt},
        ],
        "stream": False,
        "max_tokens": 1024,
        "temperature": 0.3,
    }

    last_err = ""
    t0 = time.monotonic()
    for attempt in range(max_retries):
        try:
            async with aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=timeout_sec)
            ) as session:
                async with session.post(
                    f"{base_url}/chat/completions", json=payload, headers=headers,
                ) as resp:
                    elapsed = (time.monotonic() - t0) * 1000
                    if resp.status == 200:
                        data = await resp.json()
                        text = data.get("choices", [{}])[0].get("message", {}).get("content") or ""
                        import re
                        text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
                        return (text, elapsed, "")
                    elif resp.status == 429:
                        body = await resp.text()
                        last_err = f"HTTP 429: {body[:200]}"
                        wait = 10 * (attempt + 1)
                        print(f"    ⏳ Rate limited on {model[:30]}, retry {attempt+1}/{max_retries} in {wait}s...")
                        await asyncio.sleep(wait)
                        continue
                    else:
                        body = await resp.text()
                        return ("", elapsed, f"HTTP {resp.status}: {body[:200]}")
        except asyncio.TimeoutError:
            elapsed = (time.monotonic() - t0) * 1000
            return ("", elapsed, f"Timeout after {timeout_sec}s")
        except Exception as e:
            elapsed = (time.monotonic() - t0) * 1000
            return ("", elapsed, str(e))

    elapsed = (time.monotonic() - t0) * 1000
    return ("", elapsed, last_err)


# ---- Test Scenarios ----

async def test_planner(api_key: str, model: str, role_config: dict, brigade: str) -> CheckResult:
    """Test Planner: ask for a structured 3-point plan."""
    sys_prompt = role_config.get("system_prompt", "Ты — Planner.")
    user_prompt = "Составь план из 3 пунктов для оптимизации SQL-запросов в торговом боте. Отвечай кратко."

    text, ms, err = await _call_model(api_key, model, sys_prompt, user_prompt)
    passed = bool(text) and not err
    # Check for structured content (numbered items)
    has_structure = any(f"{i}" in text for i in range(1, 4)) or ("план" in text.lower())

    return CheckResult(
        role="Planner", model=model, brigade=brigade,
        test_name="structured_plan",
        passed=passed and has_structure,
        response_ms=ms,
        response_preview=text[:100],
        error=err if err else ("No structured plan returned" if not has_structure else ""),
    )


async def test_coder(api_key: str, model: str, role_config: dict, brigade: str) -> CheckResult:
    """Test Coder: ask to write a function. Check for tool call parsing."""
    sys_prompt = role_config.get("system_prompt", "Ты — Coder.")
    user_prompt = (
        "Напиши функцию hello_world() на Python, которая возвращает строку 'Hello, World!'. "
        "Выдай только код."
    )

    text, ms, err = await _call_model(api_key, model, sys_prompt, user_prompt)
    passed = bool(text) and not err

    # Check for code content
    has_code = "def " in text or "hello" in text.lower()

    # Check for tool call leakage
    from src.pipeline._tool_call_parser import parse_tool_calls
    leaked_calls = parse_tool_calls(text)
    tool_status = "Fail (leaked)" if leaked_calls else "Pass"

    return CheckResult(
        role="Coder", model=model, brigade=brigade,
        test_name="write_function",
        passed=passed and has_code,
        response_ms=ms,
        response_preview=text[:100],
        error=err if err else ("No code returned" if not has_code else ""),
        tool_parse_status=tool_status,
    )


async def test_auditor(api_key: str, model: str, role_config: dict, brigade: str) -> CheckResult:
    """Test Auditor: ask to compare two texts and pick the best."""
    sys_prompt = role_config.get("system_prompt", "Ты — Auditor.")
    user_prompt = (
        "Сравни два ответа и скажи какой лучше:\n"
        "A: 'Используй SELECT * FROM orders WHERE date > NOW()'\n"
        "B: 'Используй SELECT id, total FROM orders WHERE date > CURRENT_TIMESTAMP LIMIT 100'\n"
        "Выбери лучший и объясни почему."
    )

    text, ms, err = await _call_model(api_key, model, sys_prompt, user_prompt)
    passed = bool(text) and not err
    # Check that auditor actually picked one
    made_choice = any(kw in text.upper() for kw in ["A", "B", "ЛУЧШ", "ВЫБИР", "ПРЕДПОЧТ"])

    return CheckResult(
        role="Auditor", model=model, brigade=brigade,
        test_name="compare_answers",
        passed=passed and made_choice,
        response_ms=ms,
        response_preview=text[:100],
        error=err if err else ("Auditor didn't make a choice" if not made_choice else ""),
    )


async def test_researcher(api_key: str, model: str, role_config: dict, brigade: str) -> CheckResult:
    """Test Researcher: ask for a factual analysis."""
    sys_prompt = role_config.get("system_prompt", "Ты — Researcher.")
    user_prompt = "Объясни в 3 предложениях что такое RLHF (Reinforcement Learning from Human Feedback)."

    text, ms, err = await _call_model(api_key, model, sys_prompt, user_prompt)
    passed = bool(text) and not err
    has_substance = len(text) > 50 and any(kw in text.lower() for kw in ["reinforcement", "rl", "обучени", "reward", "модел"])

    return CheckResult(
        role="Researcher", model=model, brigade=brigade,
        test_name="factual_analysis",
        passed=passed and has_substance,
        response_ms=ms,
        response_preview=text[:100],
        error=err if err else ("Shallow/empty response" if not has_substance else ""),
    )


async def test_vision(api_key: str, model: str, role_config: dict, brigade: str) -> CheckResult:
    """Test Vision model: send a text-only request (vision requires multimodal)."""
    sys_prompt = "Ты — Vision Analyst. Описывай изображения."
    user_prompt = (
        "Опиши в 2 предложениях что обычно изображено на логотипе Python (язык программирования)."
    )

    text, ms, err = await _call_model(api_key, model, sys_prompt, user_prompt)
    passed = bool(text) and not err
    has_desc = len(text) > 20

    return CheckResult(
        role="Vision", model=model, brigade=brigade,
        test_name="describe_logo",
        passed=passed and has_desc,
        response_ms=ms,
        response_preview=text[:100],
        error=err,
    )


async def test_generic_role(api_key: str, model: str, role_name: str, role_config: dict,
                            brigade: str) -> CheckResult:
    """Generic test for any role: simple Q&A."""
    sys_prompt = role_config.get("system_prompt", f"Ты — {role_name}.")
    user_prompt = f"Кратко в 1-2 предложениях опиши свою роль как {role_name}."

    text, ms, err = await _call_model(api_key, model, sys_prompt, user_prompt)
    passed = bool(text) and not err

    # Check for tool call leakage
    from src.pipeline._tool_call_parser import parse_tool_calls
    leaked_calls = parse_tool_calls(text)
    tool_status = "Fail (leaked)" if leaked_calls else "Pass"

    return CheckResult(
        role=role_name, model=model, brigade=brigade,
        test_name="generic_qa",
        passed=passed,
        response_ms=ms,
        response_preview=text[:100],
        error=err,
        tool_parse_status=tool_status,
    )


async def test_tool_call_parsing() -> CheckResult:
    """Test the tool call parser itself with known patterns."""
    from src.pipeline._tool_call_parser import parse_tool_calls, strip_tool_calls

    test_cases = [
        '<tool_call><function=web_search>{"query":"python async"}</function></tool_call>',
        '[TOOL_CALL] {"name": "read_file", "arguments": {"path": "/tmp/x"}} [/TOOL_CALL]',
        '<|tool_call|>{"name": "execute_command", "arguments": {"cmd": "ls"}}<|/tool_call|>',
        '```tool_call\n{"name": "list_tables", "arguments": {}}\n```',
        '<function=web_search>{"query": "test"}</function>',
        # v14.2: ReAct-style (Llama-3.3)
        'Action: web_search\nAction Input: {"query": "RLHF"}',
        # v14.2: Qwen \u273fFUNCTION\u273f format
        '\u273F FUNCTION \u273F: web_search\n\u273F ARGS \u273F: {"query": "test"}\n\u273F RESULT',
    ]

    all_ok = True
    errors = []
    for i, tc in enumerate(test_cases):
        calls = parse_tool_calls(tc)
        if not calls:
            all_ok = False
            errors.append(f"Pattern {i+1} not parsed")
        else:
            stripped = strip_tool_calls(tc, calls)
            if calls[0].raw_match in stripped:
                all_ok = False
                errors.append(f"Pattern {i+1} not stripped")

    return CheckResult(
        role="ToolParser", model="local", brigade="System",
        test_name="parser_self_test",
        passed=all_ok,
        response_ms=0,
        response_preview=f"{len(test_cases)} patterns tested",
        error="; ".join(errors) if errors else "",
        tool_parse_status="Pass" if all_ok else f"Fail ({len(errors)} errors)",
    )


async def test_youtube_parser() -> CheckResult:
    """Test YouTube parser with a well-known short video."""
    try:
        from src.tools.youtube_parser import analyze_youtube_video
        # Use Rick Astley - Never Gonna Give You Up (well-known, always available)
        result = await analyze_youtube_video("dQw4w9WgXcQ", timeout_sec=20)
        if result.success and result.title:
            return CheckResult(
                role="YouTube", model="yt-dlp", brigade="System",
                test_name="fetch_transcript",
                passed=True,
                response_ms=0,
                response_preview=f"Title: {result.title[:50]}, transcript: {len(result.transcript)} chars",
            )
        else:
            return CheckResult(
                role="YouTube", model="yt-dlp", brigade="System",
                test_name="fetch_transcript",
                passed=False,
                error=result.error or "No title returned",
                response_preview=f"error: {result.error[:60]}",
            )
    except Exception as e:
        return CheckResult(
            role="YouTube", model="yt-dlp", brigade="System",
            test_name="fetch_transcript",
            passed=False,
            error=str(e),
        )


# Dispatch table: role name -> specific test function
_ROLE_TESTS = {
    "Planner": test_planner,
    "Coder": test_coder,
    "Auditor": test_auditor,
    "Researcher": test_researcher,
}

# Vision-capable role names map to vision test
_VISION_ROLES = {"Vision", "Video_Analyst", "video_analyst", "vision"}


async def run_health_check(config_path: str = None) -> HealthReport:
    """Run full model health check against all roles in config."""
    if config_path is None:
        config_path = str(PROJECT_ROOT / "config" / "openclaw_config.json")

    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    # Get API key
    api_key = config.get("system", {}).get("openrouter", {}).get("api_key", "")
    if api_key.startswith("${"):
        env_key = api_key.strip("${}")
        api_key = os.environ.get(env_key, os.environ.get("OPENROUTER_API_KEY", ""))

    if not api_key:
        print("ERROR: No OpenRouter API key found. Set OPENROUTER_API_KEY env var.")
        sys.exit(1)

    report = HealthReport()

    # 1. Test tool call parser itself
    print("🔧 Testing tool call parser...")
    parser_result = await test_tool_call_parsing()
    report.add(parser_result)
    icon = "✅" if parser_result.passed else "❌"
    print(f"  {icon} Tool Call Parser: {parser_result.tool_parse_status}")

    # 2. Test all model_router entries
    model_router = config.get("system", {}).get("model_router", {})
    print(f"\n📡 Testing model_router ({len(model_router)} entries)...")
    for task_type, model in model_router.items():
        if task_type == "intent":
            continue  # Skip intent classifier
        await asyncio.sleep(3)  # Rate-limit guard
        result = await test_generic_role(
            api_key, model, f"Router:{task_type}", {"system_prompt": f"Ты — {task_type} модель."}, "System",
        )
        report.add(result)
        icon = "✅" if result.passed else "❌"
        print(f"  {icon} {task_type}: {model[:40]} ({result.response_ms:.0f}ms)")

    # 3. Test each brigade role
    brigades = config.get("brigades", {})
    for brigade_name, brigade_cfg in brigades.items():
        roles = brigade_cfg.get("roles", {})
        print(f"\n🏗 Brigade: {brigade_name} ({len(roles)} roles)")
        for role_name, role_cfg in roles.items():
            model = role_cfg.get("openrouter_model") or role_cfg.get("model", "")
            if not model:
                continue

            await asyncio.sleep(3)  # Rate-limit guard
            test_fn = _ROLE_TESTS.get(role_name)
            if role_name in _VISION_ROLES or "vision" in role_name.lower() or "video" in role_name.lower():
                result = await test_vision(api_key, model, role_cfg, brigade_name)
            elif test_fn:
                result = await test_fn(api_key, model, role_cfg, brigade_name)
            else:
                result = await test_generic_role(api_key, model, role_name, role_cfg, brigade_name)

            report.add(result)
            icon = "✅" if result.passed else "❌"
            print(f"  {icon} {role_name}: {model[:40]} ({result.response_ms:.0f}ms) [{result.tool_parse_status}]")

    # 4. YouTube parser test
    print("\n🎥 Testing YouTube parser...")
    yt_result = await test_youtube_parser()
    report.youtube_test = yt_result
    report.add(yt_result)
    icon = "✅" if yt_result.passed else "❌"
    print(f"  {icon} YouTube: {yt_result.response_preview[:60]}")

    return report


async def send_telegram_report(report: HealthReport) -> bool:
    """Send health report to Telegram admin chat."""
    import aiohttp

    config_path = str(PROJECT_ROOT / "config" / "openclaw_config.json")
    with open(config_path, "r", encoding="utf-8") as f:
        config = json.load(f)

    tg_cfg = config.get("system", {}).get("telegram", {})
    token = tg_cfg.get("bot_token", "")
    chat_id = tg_cfg.get("admin_chat_id", "")

    # Strip ${} wrappers
    if isinstance(token, str) and token.startswith("${") and token.endswith("}"):
        token = token[2:-1]
    if isinstance(chat_id, str) and chat_id.startswith("${") and chat_id.endswith("}"):
        chat_id = chat_id[2:-1]

    if not token or not chat_id:
        print("ERROR: Telegram bot_token or admin_chat_id not configured.")
        return False

    text = report.to_telegram_text()
    # Telegram limit: 4096 chars
    if len(text) > 4000:
        text = text[:4000] + "\n..."

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": str(chat_id), "text": text}
    try:
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload, timeout=aiohttp.ClientTimeout(total=10)) as resp:
                if resp.status == 200:
                    print("\n✅ Report sent to Telegram")
                    return True
                body = await resp.text()
                print(f"\n❌ Telegram send failed: {resp.status} {body[:200]}")
                return False
    except Exception as e:
        print(f"\n❌ Telegram send error: {e}")
        return False


async def main():
    import argparse
    parser = argparse.ArgumentParser(description="OpenClaw Model Health Check")
    parser.add_argument("--send-telegram", action="store_true", help="Send report to Telegram admin")
    args, _ = parser.parse_known_args()

    print("=" * 60)
    print("  OPENCLAW MODEL HEALTH CHECK v14.2")
    print("=" * 60)
    print()

    report = await run_health_check()

    print()
    print(report.to_matrix())

    # Save to file
    report_path = PROJECT_ROOT / "data" / "model_health_report.txt"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report.to_matrix())
    print(f"\nReport saved to: {report_path}")

    if args.send_telegram:
        await send_telegram_report(report)

    return report


if __name__ == "__main__":
    report = asyncio.run(main())
    sys.exit(0 if report.total_fail == 0 else 1)

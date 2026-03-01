"""Claude CLI wrapper for Sentinel tasks — uses `claude -p` (Claude Code subscription)."""
import json
import os
import subprocess
from datetime import date
from pathlib import Path

_CALLS_FILE = Path(__file__).resolve().parent.parent / ".api_calls"
_CLAUDE_BIN = os.path.expanduser("~/.local/bin/claude")

# Model mapping: config names → claude CLI --model flag
_MODEL_MAP = {
    "claude-haiku-4-5-20251001": "haiku",
    "claude-sonnet-4-5-20250514": "sonnet",
    "haiku": "haiku",
    "sonnet": "sonnet",
}


def _read_daily_calls():
    """Read today's call count from file."""
    today = date.today().isoformat()
    try:
        data = json.loads(_CALLS_FILE.read_text())
        if data.get("date") == today:
            return data.get("count", 0)
    except (FileNotFoundError, json.JSONDecodeError, ValueError):
        pass
    return 0


def _increment_daily_calls():
    """Increment and persist today's call count (atomic write)."""
    today = date.today().isoformat()
    count = _read_daily_calls() + 1
    tmp = _CALLS_FILE.with_suffix(".tmp")
    with open(tmp, "w") as f:
        json.dump({"date": today, "count": count}, f)
        f.flush()
        os.fsync(f.fileno())
    tmp.rename(_CALLS_FILE)
    return count


def _run_claude(prompt, model="haiku", timeout=120):
    """Run claude CLI in one-shot mode. Returns text output."""
    cli_model = _MODEL_MAP.get(model, model)
    env = os.environ.copy()
    env.pop("CLAUDECODE", None)  # avoid nested session check

    result = subprocess.run(
        [_CLAUDE_BIN, "-p", prompt,
         "--model", cli_model,
         "--output-format", "text"],
        capture_output=True, text=True, timeout=timeout, env=env,
    )
    if result.returncode != 0:
        raise RuntimeError(f"claude CLI exit {result.returncode}: {(result.stderr or result.stdout)[:300]}")
    return result.stdout.strip()


class ClaudeClient:
    def __init__(self, max_daily_calls=20):
        self.max_daily_calls = max_daily_calls

    def _check_limit(self):
        current = _read_daily_calls()
        if current >= self.max_daily_calls:
            raise RuntimeError(f"Daily call limit ({self.max_daily_calls}) reached — {current} calls today")
        _increment_daily_calls()

    def analyze(self, prompt, context="", model="haiku"):
        """General-purpose analysis."""
        self._check_limit()
        full = f"{prompt}\n\n{context}" if context else prompt
        return _run_claude(full, model=model)

    def morning_brief(self, digest, bulletin, tasks, weather, model="haiku"):
        """Generate morning briefing (~250 words)."""
        self._check_limit()
        prompt = f"""你是無極系統的晨報員。用繁體中文生成簡潔的早報，250字以內。

今日天氣：{weather}

昨日摘要：
{digest}

公告欄告警：
{bulletin}

待辦任務：
{tasks}

格式：先天氣一句，再重點摘要，最後待辦提醒。簡潔有力，不要廢話。"""
        return _run_claude(prompt, model=model)

    def weekly_summary(self, digests, audit, exp_stats, anomaly_history, model="sonnet"):
        """Generate weekly review summary."""
        self._check_limit()
        prompt = f"""你是無極系統的週報分析師。生成本週週報，500字以內，繁體中文。

本週每日摘要：
{digests}

結構審計結果：
{audit}

經驗庫統計：
{exp_stats}

異常掃描歷史：
{anomaly_history}

格式：
## 本週概覽
(3-5 bullet 重點)

## 趨勢觀察
(模式/改善/惡化)

## 下週建議
(2-3 具體行動)"""
        return _run_claude(prompt, model=model)

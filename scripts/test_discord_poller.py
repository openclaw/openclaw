from __future__ import annotations

import argparse
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path(__file__).with_name("discord_poller.py")
SPEC = importlib.util.spec_from_file_location("discord_poller_under_test", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Unable to load module from {MODULE_PATH}")
discord_poller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(discord_poller)


class DummySession:
    headers: dict[str, str]

    def __init__(self) -> None:
        self.headers = {}


def build_args(state_file: Path, inbound_dir: Path, walkthink_dir: Path) -> argparse.Namespace:
    return argparse.Namespace(
        channel_id="walkthink-channel",
        token_env="DISCORD_TOKEN",
        interval_sec=5.0,
        fetch_limit=50,
        state_file=str(state_file),
        legacy_last_id_file=str(state_file.with_name("legacy_last_id.txt")),
        inbound_dir=str(inbound_dir),
        auto_process_python="/usr/bin/python3",
        auto_process_script="/tmp/auto_process.py",
        walkthink_dir=str(walkthink_dir),
        catch_up_initial_batch=True,
        heartbeat_sec=60.0,
        process_timeout_sec=120.0,
        retry_base_sec=60.0,
        retry_max_sec=1800.0,
        retry_notify_sec=1800.0,
        status=False,
        status_format="text",
        openclaw_config=str(state_file.with_name("openclaw.json")),
        ai_api_key_env="OPENROUTER_API_KEY",
        ai_base_url="https://example.invalid/v1",
        ai_model="test-model",
        ai_system_prompt="",
        enable_ai_reply=False,
        ai_reply_max_tokens=800,
    )


class DiscordPollerRetryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.state_file = self.root / "discord_poller_state.json"
        self.inbound_dir = self.root / "inbound"
        self.walkthink_dir = self.root / "WalkThink"
        (self.walkthink_dir / "data" / "entries").mkdir(parents=True, exist_ok=True)
        self.args = build_args(self.state_file, self.inbound_dir, self.walkthink_dir)
        self.message = {
            "id": "100",
            "content": "",
            "author": {"bot": False},
            "attachments": [
                {
                    "id": "att-1",
                    "filename": "thought.ogg",
                    "content_type": "audio/ogg",
                    "url": "https://cdn.discordapp.com/thought.ogg",
                }
            ],
        }

    def _run_main_once(
        self,
        *,
        get_messages_side_effect,
        run_auto_process_result,
        get_message_by_id_result=None,
        download_attachment_side_effect=None,
        time_time_value=1_000.0,
        env_overrides: dict[str, str] | None = None,
        ai_chat_reply_result: str | Exception | None = None,
        memory_context: str = "",
    ) -> tuple[int, list[str]]:
        sent_messages: list[str] = []

        def fake_send_message(_session, _channel_id: str, content: str) -> None:
            sent_messages.append(content)

        def stop_after_loop(_seconds: float) -> None:
            raise KeyboardInterrupt

        run_auto_process_patch: mock._patch
        if callable(run_auto_process_result) or isinstance(run_auto_process_result, BaseException):
            run_auto_process_patch = mock.patch.object(
                discord_poller,
                "run_auto_process",
                side_effect=run_auto_process_result,
            )
        else:
            run_auto_process_patch = mock.patch.object(
                discord_poller,
                "run_auto_process",
                return_value=run_auto_process_result,
            )

        if callable(get_message_by_id_result) or isinstance(get_message_by_id_result, BaseException):
            get_message_by_id_patch = mock.patch.object(
                discord_poller,
                "get_message_by_id",
                side_effect=get_message_by_id_result,
            )
        else:
            get_message_by_id_patch = mock.patch.object(
                discord_poller,
                "get_message_by_id",
                return_value=get_message_by_id_result,
            )

        if isinstance(ai_chat_reply_result, Exception):
            ai_chat_reply_patch = mock.patch.object(
                discord_poller,
                "ai_chat_reply",
                side_effect=ai_chat_reply_result,
            )
        elif ai_chat_reply_result is None:
            ai_chat_reply_patch = mock.patch.object(discord_poller, "ai_chat_reply", wraps=discord_poller.ai_chat_reply)
        else:
            ai_chat_reply_patch = mock.patch.object(
                discord_poller,
                "ai_chat_reply",
                return_value=ai_chat_reply_result,
            )

        env = {"DISCORD_TOKEN": "token"}
        if env_overrides:
            env.update(env_overrides)

        with (
            mock.patch.object(discord_poller, "parse_args", return_value=self.args),
            mock.patch.dict(discord_poller.os.environ, env, clear=False),
            mock.patch.object(discord_poller.requests, "Session", return_value=DummySession()),
            mock.patch.object(discord_poller, "get_messages", side_effect=get_messages_side_effect),
            get_message_by_id_patch,
            ai_chat_reply_patch,
            mock.patch.object(discord_poller, "load_full_memory_context", return_value=memory_context),
            mock.patch.object(discord_poller, "send_message", side_effect=fake_send_message),
            mock.patch.object(discord_poller, "download_attachment", side_effect=download_attachment_side_effect),
            run_auto_process_patch,
            mock.patch.object(discord_poller.time, "time", return_value=time_time_value),
            mock.patch.object(discord_poller.time, "sleep", side_effect=stop_after_loop),
        ):
            result = discord_poller.main()

        return result, sent_messages

    def test_timeout_advances_cursor_and_tracks_pending_audio(self) -> None:
        def fake_get_messages(_session, _channel_id: str, _fetch_limit: int, after_id: str | None = None):
            if after_id is None:
                return [self.message]
            if after_id == "99":
                return [self.message]
            return []

        timeout_error = subprocess.TimeoutExpired(cmd=["auto_process.py"], timeout=120)
        result, sent_messages = self._run_main_once(
            get_messages_side_effect=fake_get_messages,
            run_auto_process_result=timeout_error,
        )

        self.assertEqual(result, 0)
        state = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(state["per_channel_last_id"]["walkthink-channel"], "100")
        self.assertEqual(state["processed_attachment_keys"], [])
        self.assertEqual(state["pending_attachment_keys"], ["100:att-1"])
        self.assertEqual(state["pending_attachment_meta"]["100:att-1"]["retry_count"], 1)
        self.assertEqual(state["pending_attachment_meta"]["100:att-1"]["channel_id"], "walkthink-channel")
        self.assertEqual(state["pending_attachment_meta"]["100:att-1"]["message_id"], "100")
        self.assertEqual(state["recent_audio_events"][-1]["kind"], "retry-scheduled")
        self.assertTrue(any("约 1 分钟后自动重试" in msg for msg in sent_messages))
        self.assertFalse(any("已跳过" in msg for msg in sent_messages))

    def test_success_clears_pending_via_independent_retry_queue(self) -> None:
        self.state_file.write_text(
            json.dumps(
                {
                    "last_message_id": "0",
                    "per_channel_last_id": {"walkthink-channel": "100"},
                    "processed_attachment_keys": [],
                    "pending_attachment_keys": ["100:att-1"],
                    "pending_attachment_meta": {
                        "100:att-1": {
                            "channel_id": "walkthink-channel",
                            "message_id": "100",
                            "attachment_id": "att-1",
                            "filename": "thought.ogg",
                            "source_url": "https://cdn.discordapp.com/thought.ogg",
                            "retry_count": 1,
                            "next_retry_ts": 900.0,
                            "last_notice_ts": 800.0,
                        }
                    },
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        def fake_get_messages(_session, _channel_id: str, _fetch_limit: int, after_id: str | None = None):
            return []

        success_result = subprocess.CompletedProcess(args=["auto_process.py"], returncode=0, stdout="", stderr="")
        result, sent_messages = self._run_main_once(
            get_messages_side_effect=fake_get_messages,
            run_auto_process_result=success_result,
            get_message_by_id_result=self.message,
        )

        self.assertEqual(result, 0)
        state = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(state["per_channel_last_id"]["walkthink-channel"], "100")
        self.assertEqual(state["processed_attachment_keys"], ["100:att-1"])
        self.assertEqual(state["pending_attachment_keys"], [])
        self.assertEqual(state["pending_attachment_meta"], {})
        self.assertFalse(any("开始处理" in msg for msg in sent_messages))
        self.assertTrue(any("已自动处理语音" in msg for msg in sent_messages))

    def test_pending_audio_does_not_block_later_messages_in_same_channel(self) -> None:
        second_message = {
            "id": "101",
            "content": "ping",
            "author": {"bot": False},
            "attachments": [],
        }

        def fake_get_messages(_session, _channel_id: str, _fetch_limit: int, after_id: str | None = None):
            if after_id is None:
                return [self.message, second_message]
            if after_id == "99":
                return [self.message, second_message]
            return []

        timeout_error = subprocess.TimeoutExpired(cmd=["auto_process.py"], timeout=120)
        result, sent_messages = self._run_main_once(
            get_messages_side_effect=fake_get_messages,
            run_auto_process_result=timeout_error,
        )

        self.assertEqual(result, 0)
        state = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(state["per_channel_last_id"]["walkthink-channel"], "101")
        self.assertEqual(state["pending_attachment_keys"], ["100:att-1"])
        self.assertIn("pong (via poller)", sent_messages)

    def test_retry_schedule_suppresses_repeat_notifications_until_interval(self) -> None:
        pending_meta: dict[str, dict[str, object]] = {}

        first_meta, first_notify = discord_poller.schedule_retryable_attachment(
            pending_meta,
            "100:att-1",
            now_ts=1_000.0,
            retry_base_sec=60.0,
            retry_max_sec=1800.0,
            retry_notify_sec=1800.0,
            error="timeout",
        )
        second_meta, second_notify = discord_poller.schedule_retryable_attachment(
            pending_meta,
            "100:att-1",
            now_ts=1_030.0,
            retry_base_sec=60.0,
            retry_max_sec=1800.0,
            retry_notify_sec=1800.0,
            error="timeout again",
        )

        self.assertTrue(first_notify)
        self.assertFalse(second_notify)
        self.assertEqual(first_meta["retry_count"], 1)
        self.assertEqual(second_meta["retry_count"], 2)
        self.assertEqual(first_meta["next_retry_ts"], 1_060.0)
        self.assertEqual(second_meta["next_retry_ts"], 1_150.0)
        self.assertTrue(discord_poller.should_defer_pending_retry(pending_meta, "100:att-1", 1_031.0))

    def test_pending_retry_defers_without_resending_warning(self) -> None:
        self.state_file.write_text(
            json.dumps(
                {
                    "last_message_id": "0",
                    "per_channel_last_id": {"walkthink-channel": "99"},
                    "processed_attachment_keys": [],
                    "pending_attachment_keys": ["100:att-1"],
                    "pending_attachment_meta": {
                        "100:att-1": {
                            "retry_count": 1,
                            "last_notice_ts": 1_000.0,
                            "next_retry_ts": 1_060.0,
                        }
                    },
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

        def fake_get_messages(_session, _channel_id: str, _fetch_limit: int, after_id: str | None = None):
            if after_id == "99":
                return [self.message]
            return []

        download_mock = mock.Mock()
        result, sent_messages = self._run_main_once(
            get_messages_side_effect=fake_get_messages,
            run_auto_process_result=subprocess.CompletedProcess(args=["auto_process.py"], returncode=0, stdout="", stderr=""),
            download_attachment_side_effect=download_mock,
            time_time_value=1_010.0,
        )

        self.assertEqual(result, 0)
        state = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(state["per_channel_last_id"]["walkthink-channel"], "100")
        self.assertEqual(state["pending_attachment_keys"], ["100:att-1"])
        self.assertEqual(state["pending_attachment_meta"]["100:att-1"]["next_retry_ts"], 1_060.0)
        download_mock.assert_not_called()
        self.assertEqual(sent_messages, [])

    def test_long_text_auto_saves_entry_and_builds_memory_aware_ai_reply(self) -> None:
        self.args.enable_ai_reply = True
        message = {
            "id": "100",
            "content": "这是一次比较长的文字思考，长度肯定超过三十个字，用来验证自动保存和 AI 上下文回复。",
            "author": {"bot": False},
            "attachments": [],
        }
        history = [
            {"id": "99", "content": "之前的用户问题", "author": {"bot": False}},
            {"id": "98", "content": "之前的 AI 回答", "author": {"bot": True}},
            message,
        ]

        def fake_get_messages(_session, _channel_id: str, fetch_limit: int, after_id: str | None = None):
            if after_id is None and fetch_limit == 50:
                return [message]
            if after_id == "99":
                return [message]
            if after_id is None and fetch_limit == 20:
                return history
            return []

        with mock.patch.object(discord_poller, "ai_chat_reply", return_value="AI 回复内容") as ai_reply_mock:
            result, sent_messages = self._run_main_once(
                get_messages_side_effect=fake_get_messages,
                run_auto_process_result=subprocess.CompletedProcess(args=["auto_process.py"], returncode=0, stdout="", stderr=""),
                env_overrides={"OPENROUTER_API_KEY": "test-key"},
                memory_context="【长期记忆】用户最近在思考论文和健康。",
            )

        self.assertEqual(result, 0)
        saved_entries = list((self.walkthink_dir / "data" / "entries").glob("*_discord_text_100.md"))
        self.assertEqual(len(saved_entries), 1)
        saved_text = saved_entries[0].read_text(encoding="utf-8")
        self.assertIn("这是一次比较长的文字思考", saved_text)
        self.assertTrue(any("已为你保存这条文字思考" in msg for msg in sent_messages))
        self.assertIn("AI 回复内容", sent_messages)
        ai_reply_mock.assert_called_once()
        context_message = ai_reply_mock.call_args.args[4]
        self.assertIn("【长期记忆】用户最近在思考论文和健康。", context_message)
        self.assertIn("【用户最新发言】", context_message)
        self.assertIn("这是一次比较长的文字思考", context_message)

    def test_save_command_merges_recent_bot_messages_into_single_insight_note(self) -> None:
        self.args.enable_ai_reply = True
        message = {
            "id": "100",
            "content": "把这个总结保存下来",
            "author": {"bot": False},
            "attachments": [],
        }
        history = [
            message,
            {"id": "99", "content": "第二段 AI 洞察", "author": {"bot": True}},
            {"id": "98", "content": "第一段 AI 洞察", "author": {"bot": True}},
            {"id": "97", "content": "更早的用户发言", "author": {"bot": False}},
        ]

        def fake_get_messages(_session, _channel_id: str, fetch_limit: int, after_id: str | None = None):
            if after_id is None and fetch_limit == 50:
                return [message]
            if after_id == "99":
                return [message]
            if after_id is None and fetch_limit == 20:
                return history
            return []

        with mock.patch.object(discord_poller, "ai_chat_reply", return_value="不应该被调用") as ai_reply_mock:
            result, sent_messages = self._run_main_once(
                get_messages_side_effect=fake_get_messages,
                run_auto_process_result=subprocess.CompletedProcess(args=["auto_process.py"], returncode=0, stdout="", stderr=""),
                env_overrides={"OPENROUTER_API_KEY": "test-key"},
            )

        self.assertEqual(result, 0)
        saved_entries = list((self.walkthink_dir / "data" / "entries").glob("*_ai_insight_100.md"))
        self.assertEqual(len(saved_entries), 1)
        saved_text = saved_entries[0].read_text(encoding="utf-8")
        self.assertIn("第一段 AI 洞察", saved_text)
        self.assertIn("第二段 AI 洞察", saved_text)
        self.assertTrue(any("已将 2 条消息合并为一条完整洞察笔记" in msg for msg in sent_messages))
        ai_reply_mock.assert_not_called()

    def test_save_command_dedupes_existing_insight_without_writing_duplicate_file(self) -> None:
        self.args.enable_ai_reply = True
        message = {
            "id": "100",
            "content": "记下来",
            "author": {"bot": False},
            "attachments": [],
        }
        merged_insight = "第一段 AI 洞察\n\n第二段 AI 洞察"
        existing_file = self.walkthink_dir / "data" / "entries" / "2026-03-07_120000_ai_insight_old.md"
        existing_file.write_text(
            f"# AI 洞察\n\n## 🎤 转录内容\n\n{merged_insight}\n",
            encoding="utf-8",
        )
        history = [
            message,
            {"id": "99", "content": "第二段 AI 洞察", "author": {"bot": True}},
            {"id": "98", "content": "第一段 AI 洞察", "author": {"bot": True}},
            {"id": "97", "content": "更早的用户发言", "author": {"bot": False}},
        ]

        def fake_get_messages(_session, _channel_id: str, fetch_limit: int, after_id: str | None = None):
            if after_id is None and fetch_limit == 50:
                return [message]
            if after_id == "99":
                return [message]
            if after_id is None and fetch_limit == 20:
                return history
            return []

        result, sent_messages = self._run_main_once(
            get_messages_side_effect=fake_get_messages,
            run_auto_process_result=subprocess.CompletedProcess(args=["auto_process.py"], returncode=0, stdout="", stderr=""),
            env_overrides={"OPENROUTER_API_KEY": "test-key"},
        )

        self.assertEqual(result, 0)
        saved_entries = list((self.walkthink_dir / "data" / "entries").glob("*_ai_insight_*.md"))
        self.assertEqual(len(saved_entries), 1)
        self.assertTrue(any("这条洞察已经保存过了" in msg for msg in sent_messages))

    def test_status_snapshot_renders_pending_and_recent_events(self) -> None:
        snapshot = discord_poller.build_status_snapshot(
            {
                "per_channel_last_id": {"walkthink-channel": "101"},
                "pending_attachment_keys": ["100:att-1"],
                "pending_attachment_meta": {
                    "100:att-1": {
                        "channel_id": "walkthink-channel",
                        "message_id": "100",
                        "attachment_id": "att-1",
                        "filename": "thought.ogg",
                        "retry_count": 2,
                        "last_error": "timeout",
                        "next_retry_ts": 1_060.0,
                    }
                },
                "recent_audio_events": [
                    {
                        "ts": "2026-03-06T11:20:30+00:00",
                        "kind": "recovered",
                        "channel_id": "walkthink-channel",
                        "message_id": "100",
                        "attachment_id": "att-1",
                        "filename": "thought.ogg",
                    }
                ],
            },
            now_ts=1_000.0,
        )

        self.assertEqual(snapshot["pending_count"], 1)
        self.assertEqual(snapshot["recent_event_count"], 1)
        self.assertFalse(snapshot["pending"][0]["ready_now"])

        rendered = discord_poller.render_status_text(snapshot)
        self.assertIn("Pending attachments: 1", rendered)
        self.assertIn("Recent audio events: 1", rendered)
        self.assertIn("thought.ogg", rendered)


if __name__ == "__main__":
    unittest.main()

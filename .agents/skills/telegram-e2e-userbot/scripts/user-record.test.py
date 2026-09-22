import importlib.util
import json
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path


RECORD_PATH = Path(__file__).with_name("user-record.py")
SPEC = importlib.util.spec_from_file_location("tg_user_record", RECORD_PATH)
record = importlib.util.module_from_spec(SPEC)
sys.modules["tg_user_record"] = record
SPEC.loader.exec_module(record)


class FakeClient:
    def __init__(self):
        self.requests = []

    def request(self, payload, timeout=20):
        self.requests.append((payload, timeout))
        return {"@type": "callbackQueryAnswer", "text": ""}


class CallbackScenarioTest(unittest.TestCase):
    def test_scenario_sends_to_the_selected_forum_topic(self):
        clock = [0]
        calls = []
        class Recorder:
            started_at = 0
            chat_id = -10042
            def _append(self, *_args, **_kwargs):
                pass
        class Driver:
            def send_text(self, chat_id, text, reply_to=None, thread_id=0, forum_topic_id=None):
                calls.append((chat_id, text, forum_topic_id))
                clock[0] = 2
                return {"id": 42}
        with patch.object(record.time, "time", side_effect=lambda: clock[0]):
            record.run_scenario(Recorder(), Driver(), {}, [{"type": "send", "atMs": 0, "text": "topic proof", "forumTopicId": 17}], 1)
        self.assertEqual(calls, [(-10042, "topic proof", 17)])

    def test_scenario_photo_send_and_reply_to_previous(self):
        clock = [0]
        calls = []
        class Recorder:
            started_at = 0
            chat_id = 4242
            def _append(self, *_args, **_kwargs):
                pass
        class Driver:
            def send_photos(self, chat_id, paths, caption="", reply_to=None, thread_id=0, forum_topic_id=None):
                calls.append(("photo", chat_id, tuple(paths), caption, reply_to, forum_topic_id))
                clock[0] = 1
                return [{"id": 7}]
            def send_text(self, chat_id, text, reply_to=None, thread_id=0, forum_topic_id=None):
                calls.append(("text", chat_id, text, reply_to, forum_topic_id))
                clock[0] = 6
                return {"id": 8}
        actions = [
            {"type": "send", "atMs": 0, "text": "", "photo": "/tmp/fixture.png"},
            {"type": "send", "atMs": 0, "text": "/btw check this", "replyToPrevious": True},
        ]
        with patch.object(record.time, "time", side_effect=lambda: clock[0]):
            sent = record.run_scenario(Recorder(), Driver(), {}, actions, 5)
        self.assertEqual(calls, [
            ("photo", 4242, ("/tmp/fixture.png",), "", None, None),
            ("text", 4242, "/btw check this", 7, None),
        ])
        self.assertEqual(sent, [7, 8])

    def test_unconfirmed_send_keeps_recording_without_resend_or_success_receipt(self):
        clock = [100]
        class Client:
            def __init__(self):
                self.updates = [{"@type": "updateNewMessage", "message": {
                    "id": 42, "chat_id": 7, "date": 101,
                    "sender_id": {"user_id": 9},
                    "content": {"@type": "messageText", "text": {"text": "Observed reply"}},
                }}]
            def next_update(self, timeout=1):
                clock[0] += timeout
                return self.updates.pop(0) if self.updates else None
        class Driver:
            def __init__(self):
                self.client = Client()
                self.sends = 0
            def send_text(self, *_args, **_kwargs):
                self.sends += 1
                clock[0] = 130
                raise record.driver.DriverError("Timed out waiting for Telegram message send confirmation")
        instance = Driver()
        with patch.object(record.time, "time", side_effect=lambda: clock[0]):
            recorder = record.EventRecorder(instance.client, 7, "", 9)
            with self.assertRaisesRegex(record.driver.DriverError, "send confirmation"):
                record.run_scenario(recorder, instance, {}, [
                    {"type": "send", "atMs": 0, "text": "first"},
                    {"type": "send", "atMs": 35000, "text": "must not send"},
                ], 40)
        self.assertEqual(instance.sends, 1)
        self.assertEqual(clock[0], 140)
        self.assertEqual(recorder.events[0]["status"], "failed")
        self.assertIsNone(recorder.events[0]["messageId"])
        self.assertEqual(recorder.events[0]["sendOutcome"], "unknown")
        self.assertEqual(recorder.summary()["sutRevisionTexts"], ["Observed reply"])
        self.assertEqual([event["kind"] for event in recorder.events], ["action", "message"])

    def test_records_partial_rich_revisions_raw_without_fetching_full_content(self):
        client = FakeClient()
        rich = {
            "@type": "richMessage", "is_full": False, "is_rtl": False,
            "blocks": [{"@type": "pageBlockParagraph", "text": {
                "@type": "richTextPlain", "text": "partial send",
            }}],
        }
        replacement = {
            **rich, "blocks": [{"@type": "pageBlockParagraph", "text": {
                "@type": "richTextPlain", "text": "partial edit",
            }}],
        }
        updates = [
            {"@type": "updateNewMessage", "message": {
                "id": 42 << 20, "chat_id": -1001,
                "sender_id": {"@type": "messageSenderUser", "user_id": 42},
                "content": {"@type": "messageRichMessage", "message": rich},
            }},
            {"@type": "updateMessageContent", "chat_id": -1001,
             "message_id": 42 << 20,
             "new_content": {"@type": "messageRichMessage", "message": replacement}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "events.jsonl"
            recorder = record.EventRecorder(client, -1001, target, 42)
            try:
                for update in updates:
                    recorder.ingest(update)
            finally:
                recorder.close()
            events = [json.loads(line) for line in target.read_text().splitlines()]
        self.assertEqual([event["kind"] for event in events], ["message", "edit"])
        self.assertEqual([event["text"] for event in events], ["partial send", "partial edit"])
        self.assertEqual([event["richMessageIsFull"] for event in events], [False, False])
        self.assertEqual([event["raw"] for event in events], updates)
        self.assertEqual(client.requests, [])

    def test_waits_for_prior_gateway_barriers(self):
        actions = [
            {"type": "patchConfig", "atMs": 0},
            {"type": "send", "atMs": 0, "text": "after patch"},
        ]
        with tempfile.TemporaryDirectory() as directory:
            self.assertFalse(record.scenario_barriers_ready(actions, 1, directory))
            (Path(directory) / "0").touch()
            self.assertTrue(record.scenario_barriers_ready(actions, 1, directory))

    def test_publishes_atomic_recorder_ready_artifact(self):
        recorder = record.EventRecorder(FakeClient(), -1001, "", 42)
        recorder.started_at = 1_786_900_000.125
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "ready.json"
            record.publish_recorder_ready(target, recorder)
            self.assertEqual(
                json.loads(target.read_text()),
                {
                    "schemaVersion": 1,
                    "startedAtUnixMs": 1_786_900_000_125,
                    "chatId": -1001,
                },
            )
            self.assertEqual(list(target.parent.glob(".*.tmp")), [])

    def test_ignores_cached_messages_from_before_recording_window(self):
        recorder = record.EventRecorder(FakeClient(), -1001, "", 42)
        recorder.started_at = 200
        recorder.ingest(
            {
                "@type": "updateNewMessage",
                "message": {
                    "id": 1048576,
                    "chat_id": -1001,
                    "date": 100,
                    "sender_id": {"@type": "messageSenderUser", "user_id": 42},
                    "content": {
                        "@type": "messageText",
                        "text": {"@type": "formattedText", "text": "cached"},
                    },
                },
            }
        )

        self.assertEqual(recorder.events, [])
        self.assertEqual(recorder.messages, {})

    def test_finds_and_clicks_sut_callback_button(self):
        client = FakeClient()
        recorder = record.EventRecorder(client, -1001, "", 42)
        recorder.ingest(
            {
                "@type": "updateNewMessage",
                "message": {
                    "id": 1048576,
                    "chat_id": -1001,
                    "sender_id": {"@type": "messageSenderUser", "user_id": 42},
                    "content": {
                        "@type": "messageText",
                        "text": {"@type": "formattedText", "text": "Select a provider:"},
                    },
                    "reply_markup": {
                        "@type": "replyMarkupInlineKeyboard",
                        "rows": [
                            [
                                {
                                    "text": "OpenAI",
                                    "type": {
                                        "@type": "inlineKeyboardButtonTypeCallback",
                                        "data": "bW9kZWxzX3Byb3ZpZGVyX29wZW5haQ==",
                                    },
                                }
                            ]
                        ],
                    },
                },
            }
        )

        found = recorder.find_callback_button("Select a provider", "OpenAI")
        self.assertEqual(found, (1048576, "bW9kZWxzX3Byb3ZpZGVyX29wZW5haQ=="))
        recorder.click_callback_button(*found, timeout_ms=3_000)
        self.assertEqual(
            client.requests,
            [
                (
                    {
                        "@type": "getCallbackQueryAnswer",
                        "chat_id": -1001,
                        "message_id": 1048576,
                        "payload": {
                            "@type": "callbackQueryPayloadData",
                            "data": "bW9kZWxzX3Byb3ZpZGVyX29wZW5haQ==",
                        },
                    },
                    3.0,
                )
            ],
        )

    def test_finds_callback_under_current_heading_after_content_and_keyboard_edits(self):
        for content_first in (True, False):
            with self.subTest(content_first=content_first):
                recorder = record.EventRecorder(FakeClient(), -1001, "", 42)
                message = {
                    "id": 1048576, "chat_id": -1001,
                    "sender_id": {"@type": "messageSenderUser", "user_id": 42},
                    "content": {
                        "@type": "messageText",
                        "text": {"@type": "formattedText", "text": "Select a provider:"},
                    },
                    "reply_markup": {
                        "@type": "replyMarkupInlineKeyboard",
                        "rows": [[{"text": "Example", "type": {
                            "@type": "inlineKeyboardButtonTypeCallback", "data": "cHJvdmlkZXI=",
                        }}]],
                    },
                }
                content_edit = {
                    "@type": "updateMessageContent", "chat_id": -1001, "message_id": 1048576,
                    "new_content": {
                        "@type": "messageText",
                        "text": {"@type": "formattedText", "text": "Models (example) — 2 available"},
                    },
                }
                keyboard_edit = {
                    "@type": "updateMessageEdited", "chat_id": -1001, "message_id": 1048576,
                    "reply_markup": {
                        "@type": "replyMarkupInlineKeyboard",
                        "rows": [[{"text": "middle", "type": {
                            "@type": "inlineKeyboardButtonTypeCallback", "data": "bWlkZGxl",
                        }}]],
                    },
                }
                recorder.ingest({"@type": "updateNewMessage", "message": message})
                edits = ((content_edit, keyboard_edit) if content_first
                         else (keyboard_edit, content_edit))
                for update in edits:
                    recorder.ingest(update)

                self.assertEqual(recorder.find_callback_button("Models (", "middle"),
                                 (1048576, "bWlkZGxl"))
                self.assertIsNone(recorder.find_callback_button("Select a provider:", "middle"))
                self.assertEqual(message["content"]["text"]["text"], "Select a provider:")
                self.assertEqual(message["reply_markup"]["rows"][0][0]["text"], "Example")


if __name__ == "__main__":
    unittest.main()

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
    def test_reply_barrier_binds_distinct_native_replies_before_advancing(self):
        for fault in (None, "dm", "missing-before", "missing-after", "wrong-sender", "wrong-chat",
                      "wrong-quote", "missing-quote", "wrong-topic", "old-id", "partial-rich"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                clock = [0]
                pending = []
                sends = []
                replaced = []
                def message(message_id, text, reply_to, **fields):
                    return {"@type": "updateNewMessage", "message": {
                        "id": message_id, "chat_id": -10042,
                        "sender_id": {"user_id": 42},
                        "reply_to": {"message_id": reply_to, "chat_id": -10042},
                        "topic_id": {"@type": "messageTopicForum", "forum_topic_id": 17},
                        "content": {"@type": "messageText", "text": {"text": text}},
                        **fields,
                    }}
                class Client:
                    def next_update(self, timeout):
                        clock[0] += 1
                        if (Path(directory) / "0").exists() and not replaced:
                            replaced.append(clock[0])
                            (Path(directory) / "1").touch()
                        return pending.pop(0) if pending else None
                recorder = record.EventRecorder(Client(), -10042, "", 42)
                recorder.started_at = 0
                # A cached message must not become a new reply through an edit.
                recorder.ingest(message(90, "cached", 10))
                owner = self
                class Driver:
                    client = recorder.client
                    def send_text(self, chat_id, text, **kwargs):
                        sends.append(text)
                        sent_id = 10 if len(sends) == 1 else 20
                        reply_id = 11 if len(sends) == 1 else 21
                        marker = "BEFORE" if len(sends) == 1 else "AFTER"
                        if len(sends) == 2:
                            owner.assertTrue((Path(directory) / "0").exists(), "fresh send preceded visible baseline")
                            owner.assertEqual(len(replaced), 1, "fresh send preceded replacement readiness")
                            baseline = json.loads((Path(directory) / "0").read_text())
                            owner.assertEqual((baseline["sentMessageId"], baseline["messageId"]), (10, 11))
                            # Late recovery of the baseline cannot satisfy the new turn.
                            pending.append(message(12, "BEFORE", 10))
                            pending.append({"@type": "updateMessageContent", "chat_id": -10042,
                                            "message_id": 11, "new_content": {
                                                "@type": "messageText", "text": {"text": "AFTER"}}})
                        update = message(reply_id, marker, sent_id)
                        if fault == "dm":
                            update["message"].pop("reply_to")
                            update["message"].pop("topic_id")
                        if fault == "missing-before" or (fault == "missing-after" and len(sends) == 2):
                            update = None
                        elif fault == "wrong-sender":
                            update["message"]["sender_id"] = {"user_id": 99}
                        elif fault == "wrong-chat":
                            update["message"]["chat_id"] = -10099
                        elif fault == "wrong-quote":
                            update["message"]["reply_to"]["message_id"] = 9
                        elif fault == "missing-quote":
                            update["message"].pop("reply_to")
                        elif fault == "wrong-topic":
                            update["message"]["topic_id"]["forum_topic_id"] = 18
                        elif fault == "old-id":
                            update = {"@type": "updateMessageContent", "chat_id": -10042,
                                      "message_id": 90, "new_content": {
                                          "@type": "messageText", "text": {"text": marker}}}
                        elif fault == "partial-rich":
                            update["message"]["content"] = {"@type": "messageRichMessage", "message": {
                                "is_full": False, "blocks": [{"@type": "pageBlockParagraph",
                                    "text": {"@type": "richTextPlain", "text": marker}}]}}
                        if update:
                            pending.append(update)
                        return {"id": sent_id, "chat_id": chat_id,
                                **({"reply_to": {"message_id": kwargs["reply_to"]}} if kwargs.get("reply_to") else {}),
                                **({} if fault == "dm" else {
                                "topic_id": {"@type": "messageTopicForum", "forum_topic_id": 17}})}
                actions = [{"type": "send", "atMs": 0, "text": phase,
                            **({} if fault == "dm" else {"forumTopicId": 17}),
                            "awaitReply": {"text": phase, **({} if fault == "dm" else {"requireQuote": True})}}
                           for phase in ("BEFORE", "AFTER")]
                actions.insert(1, {"type": "restartGateway", "atMs": 0})
                actions[2]["replyToPrevious"] = True
                with patch.object(record.time, "time", side_effect=lambda: clock[0]):
                    if fault not in (None, "dm"):
                        with self.assertRaisesRegex(record.driver.DriverError, "visible reply"):
                            record.run_scenario(recorder, Driver(), {}, actions, 10, directory)
                    else:
                        self.assertEqual(record.run_scenario(recorder, Driver(), {}, actions, 10, directory), [10, 20])
                receipts = [e for e in recorder.events if e.get("actionType") == "awaitReply"]
                if fault not in (None, "dm"):
                    failure = json.loads((Path(directory) / "action-failure.json").read_text())
                    self.assertEqual(failure["actionType"], "awaitReply")
                    self.assertEqual(sends, ["BEFORE", "AFTER"] if fault == "missing-after" else ["BEFORE"])
                    self.assertFalse((Path(directory) / "2").exists())
                else:
                    send_receipts = [e for e in recorder.events if e.get("actionType") == "send"]
                    self.assertEqual(send_receipts[1]["replyToMessageId"], 10)
                    self.assertEqual([(e["sentMessageId"], e["messageId"], e["replyToMessageId"], e["topicId"])
                                      for e in receipts], [(10, 11, None, None), (20, 21, None, None)]
                                     if fault == "dm" else [(10, 11, 10, 17), (20, 21, 20, 17)])
                    self.assertEqual(json.loads((Path(directory) / "2").read_text())["messageId"], 21)

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

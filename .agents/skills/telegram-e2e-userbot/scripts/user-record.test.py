import importlib.util
import json
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from pathlib import Path
from types import SimpleNamespace


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


class ForwardBurstScenarioTest(unittest.TestCase):
    def message(self, message_id, text="", photo=False, **fields):
        return {"@type": "updateNewMessage", "message": {
            "id": message_id, "chat_id": 4242, "sender_id": {"user_id": 42},
            "content": {"@type": "messagePhoto" if photo else "messageText", "text": {"text": text}},
            **fields,
        }}

    def fixture(self):
        clock = [0]
        updates = []
        def next_update(timeout):
            clock[0] += 1
            return updates.pop(0) if updates else None
        client = SimpleNamespace(next_update=next_update)
        recorder = record.EventRecorder(client, 4242, "", 42)
        recorder.started_at = 0
        driver_obj = SimpleNamespace(
            client=client,
            post_forward_sources=Mock(return_value=None),
            forward_messages=Mock(return_value=[{"id": 30}, {"id": 40}]),
            send_text=Mock(return_value={"id": 50}),
        )
        return clock, updates, recorder, driver_obj

    def test_correlates_new_bot_sources_by_content_and_order_amid_unrelated_messages(self):
        clock, updates, recorder, driver_obj = self.fixture()
        text = "@sut_bot burst"
        updates.extend([
            self.message(3, photo=True),
            self.message(4, text, chat_id=4343),
            self.message(5, text, sender_id={"user_id": 99}),
            self.message(6, text, is_outgoing=True),
            self.message(7, "unrelated text"),
            {"@type": "updateMessageContent", "chat_id": 4242, "message_id": 1,
             "new_content": {"@type": "messageText", "text": {"text": text}}},
            self.message(10, text),
            self.message(11, "another unrelated text"),
            self.message(12, photo=True, chat_id=4343),
            self.message(13, photo=True, sender_id={"user_id": 99}),
            self.message(14, photo=True, is_outgoing=True),
            self.message(20, photo=True),
            self.message(30, text, is_outgoing=True),
            self.message(40, photo=True, is_outgoing=True),
        ])
        actions = [
            {"type": "forwardBurst", "atMs": 0, "text": "@{sut} burst", "photo": "/fixture.png"},
            {"type": "send", "atMs": 0, "text": "followup", "replyToPrevious": True},
        ]
        with patch.object(record.time, "time", side_effect=lambda: clock[0]):
            recorder.ingest(self.message(1, text))
            recorder.ingest(self.message(2, photo=True))
            sent = record.run_scenario(recorder, driver_obj, {"username": "sut_bot"}, actions, 20)
        driver_obj.post_forward_sources.assert_called_once_with(text, "/fixture.png")
        driver_obj.forward_messages.assert_called_once_with(4242, 4242, [10, 20])
        driver_obj.send_text.assert_called_once_with(4242, "followup", reply_to=40, forum_topic_id=None)
        self.assertEqual(sent, [30, 40, 50])
        completed = recorder.summary()["actions"][0]
        self.assertEqual({key: value for key, value in completed.items() if key != "elapsedMs"}, {
            "kind": "action", "messageId": 30, "botApiMessageId": 0,
            "actionType": "forwardBurst", "actionIndex": 0, "status": "completed",
            "text": text, "photo": "/fixture.png", "messageIds": [30, 40], "sourceMessageIds": [10, 20],
        })
        self.assertEqual(len(recorder.summary()["actions"]), 2)
        source_rows = [event for event in recorder.events if event["kind"] == "message"
                       and event["messageId"] in (10, 20)]
        self.assertEqual([event["messageId"] for event in source_rows], [10, 20])
        for event in source_rows:
            self.assertTrue(event["isSut"])
            self.assertLess(recorder.events.index(event), recorder.events.index(completed))

    def test_summary_preserves_completed_forward_ids_when_a_later_send_fails(self):
        clock, updates, _recorder, driver_obj = self.fixture()
        updates.extend([self.message(10, "burst"), self.message(20, photo=True)])
        driver_obj.resolve_chat = Mock(return_value=4242)
        driver_obj.send_text.side_effect = record.driver.DriverError("synthetic later failure")
        with tempfile.TemporaryDirectory() as directory:
            scenario_path = Path(directory) / "scenario.json"
            scenario_path.write_text(json.dumps({"actions": [
                {"type": "forwardBurst", "atMs": 0, "text": "burst", "photo": "/fixture.png"},
                {"type": "send", "atMs": 0, "text": "later"},
            ]}))
            argv = ["user-record.py", "--scenario", str(scenario_path), "--record",
                    str(Path(directory) / "events.ndjson"), "--seconds", "5"]
            with patch.object(sys, "argv", argv), \
                 patch.object(record, "build_driver", return_value=({}, {}, driver_obj)), \
                 patch.object(record.driver, "resolve_sut", return_value={"id": 42}), \
                 patch.object(record.time, "time", side_effect=lambda: clock[0]), \
                 patch("builtins.print") as output:
                self.assertEqual(record.main(), 1)
            summary = json.loads(output.call_args.args[0])
        self.assertEqual(summary["sentMessageIds"], [30, 40])
        self.assertEqual(summary["sentMessageId"], 30)
        self.assertEqual(summary["sentAction"], {"type": "scenario", "count": 2, "messageIds": [30, 40]})
        self.assertEqual(summary["actionError"], "synthetic later failure")

    def test_failure_records_phase_outcome_and_observes_rest_of_window_without_retry(self):
        for phase, outcome in [("post_forward_sources", "not-sent"), ("forward_messages", "unknown")]:
            with self.subTest(phase=phase), tempfile.TemporaryDirectory() as directory:
                clock, updates, recorder, driver_obj = self.fixture()
                error = record.driver.DriverError("synthetic confirmation failure")
                getattr(driver_obj, phase).side_effect = error
                if phase == "forward_messages":
                    updates.extend([self.message(10, "burst"), self.message(20, photo=True)])
                updates.append(self.message(60, "late evidence"))
                actions = [{"type": "forwardBurst", "atMs": 0, "text": "burst", "photo": "/fixture.png"}]
                with patch.object(record.time, "time", side_effect=lambda: clock[0]):
                    with self.assertRaises(record.driver.DriverError) as raised:
                        record.run_scenario(recorder, driver_obj, {}, actions, 5, directory)
                self.assertIs(raised.exception, error)
                self.assertEqual(clock[0], 5)
                failure = json.loads((Path(directory) / "action-failure.json").read_text())
                self.assertEqual(failure, {
                    "elapsedMs": 0 if outcome == "not-sent" else 2000,
                    "kind": "action", "messageId": None, "botApiMessageId": None,
                    "actionType": "forwardBurst", "actionIndex": 0, "status": "failed",
                    "sendOutcome": outcome, "error": str(error),
                })
                self.assertEqual(recorder.summary()["actions"], [failure])
                self.assertEqual(recorder.events[-1]["messageId"], 60)
                self.assertEqual(driver_obj.post_forward_sources.call_count, 1)
                self.assertEqual(driver_obj.forward_messages.call_count, 0 if outcome == "not-sent" else 1)

    def test_source_timeout_is_bounded_by_remaining_window_and_never_forwards(self):
        for seconds, text_arrives in [(5, False), (5, True), (40, False)]:
            with self.subTest(seconds=seconds, text_arrives=text_arrives), tempfile.TemporaryDirectory() as directory:
                clock, updates, recorder, driver_obj = self.fixture()
                updates.append(self.message(10, "burst") if text_arrives else self.message(20, photo=True))
                actions = [{"type": "forwardBurst", "atMs": 0, "text": "burst", "photo": "/fixture.png"}]
                with patch.object(record.time, "time", side_effect=lambda: clock[0]):
                    with self.assertRaisesRegex(record.driver.DriverError, "Timed out waiting for the bot's forward source"):
                        record.run_scenario(recorder, driver_obj, {}, actions, seconds, directory)
                failure = json.loads((Path(directory) / "action-failure.json").read_text())
                self.assertEqual(failure["sendOutcome"], "not-sent")
                self.assertEqual(failure["elapsedMs"], min(30, seconds) * 1000)
                self.assertEqual(clock[0], seconds)
                driver_obj.post_forward_sources.assert_called_once()
                driver_obj.forward_messages.assert_not_called()


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

    def test_scenario_album_send_records_every_member_and_replies_to_the_last(self):
        clock = [0]
        calls = []
        appended = []
        class Recorder:
            started_at = 0
            chat_id = 4242
            def _append(self, kind, message_id, **fields):
                appended.append((kind, message_id, fields))
        class Driver:
            def send_photos(self, chat_id, paths, caption="", reply_to=None, thread_id=0, forum_topic_id=None):
                calls.append(("album", chat_id, tuple(paths), caption))
                clock[0] = 1
                return [{"id": 7}, {"id": 8}, {"id": 9}]
            def send_text(self, chat_id, text, reply_to=None, thread_id=0, forum_topic_id=None):
                calls.append(("text", chat_id, text, reply_to))
                clock[0] = 6
                return {"id": 10}
        photos = ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"]
        actions = [
            {"type": "send", "atMs": 0, "text": "album caption", "photos": photos},
            {"type": "send", "atMs": 0, "text": "follow-up", "replyToPrevious": True},
        ]
        with patch.object(record.time, "time", side_effect=lambda: clock[0]):
            sent = record.run_scenario(Recorder(), Driver(), {}, actions, 5)
        self.assertEqual(calls, [
            ("album", 4242, tuple(photos), "album caption"),
            ("text", 4242, "follow-up", 9),
        ])
        self.assertEqual(sent, [7, 8, 9, 10])
        kind, message_id, fields = appended[0]
        self.assertEqual((kind, message_id), ("action", 7))
        self.assertEqual(fields["photos"], photos)
        self.assertEqual(fields["messageIds"], [7, 8, 9])

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

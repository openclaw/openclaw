import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


DRIVER_PATH = Path(__file__).with_name("user-driver.py")
SPEC = importlib.util.spec_from_file_location("tg_user_driver_test_target", DRIVER_PATH)
driver = importlib.util.module_from_spec(SPEC)
sys.modules["tg_user_driver_test_target"] = driver
SPEC.loader.exec_module(driver)


class PhotoContentTest(unittest.TestCase):
    def test_rejects_unsafe_prebuilt_archive_members(self):
        class FakeTar:
            extracted = False

            def getmembers(self):
                return [driver.tarfile.TarInfo("../escape")]

            def extractall(self, _destination):
                self.extracted = True

        archive = FakeTar()
        with self.assertRaisesRegex(driver.DriverError, "unsafe member"):
            driver.extract_prebuilt_archive(archive, tempfile.mkdtemp())
        self.assertFalse(archive.extracted)

    def test_uses_current_tdlib_photo_shape(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {}
        instance.bot_config = {}
        with tempfile.NamedTemporaryFile(suffix=".jpg") as photo:
            content = instance.photo_content(photo.name, "caption")

        self.assertEqual(content["@type"], "inputMessagePhoto")
        self.assertEqual(content["photo"]["@type"], "inputPhoto")
        self.assertEqual(content["photo"]["photo"]["@type"], "inputFileLocal")
        self.assertEqual(content["show_caption_above_media"], False)
        self.assertIsNone(content["self_destruct_type"])
        self.assertEqual(content["has_spoiler"], False)
        self.assertNotIn("ttl", content)

    def test_uses_test_dc_for_test_session(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {
            "apiId": 123,
            "apiHash": "api-hash",
            "databaseEncryptionKey": "database-key",
            "testDc": True,
        }
        params = instance.td_params()
        self.assertEqual(params["parameters"]["use_test_dc"], True)
        current = instance.td_params_current()
        self.assertEqual(current["use_test_dc"], True)
        self.assertEqual(current["database_encryption_key"], "database-key")

    def test_credential_check_accepts_chat_found_after_bounded_list_refresh(self):
        class FakeClient:
            def __init__(self):
                self.requests = []

            def request(self, payload, timeout=20):
                self.requests.append((payload, timeout))
                if payload["@type"] == "getChat" and len(self.requests) == 1:
                    raise driver.DriverError(
                        "getChat failed (400): Chat not found",
                        tdlib_code=400,
                        tdlib_message="Chat not found",
                        tdlib_method="getChat",
                    )
                if payload["@type"] == "getChat":
                    return {"id": -1001}
                return {"@type": "ok"}

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(
            instance.resolve_chat("-1001", credential_deadline=driver.time.monotonic() + 20),
            -1001,
        )
        self.assertEqual(
            [payload["@type"] for payload, _timeout in instance.client.requests],
            ["getChat", "loadChats", "getChat"],
        )
        self.assertLessEqual(instance.client.requests[1][1], 10)

    def test_credential_check_classifies_exhausted_chat_list(self):
        class FakeClient:
            def request(self, payload, timeout=20):
                if payload["@type"] == "getChat":
                    raise driver.DriverError(
                        "getChat failed (400): Chat not found",
                        tdlib_code=400,
                        tdlib_message="Chat not found",
                        tdlib_method="getChat",
                    )
                raise driver.DriverError(
                    "loadChats failed (404): Not Found",
                    tdlib_code=404,
                    tdlib_message="Not Found",
                    tdlib_method="loadChats",
                )

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        with self.assertRaisesRegex(driver.DriverError, "exhausting") as raised:
            instance.resolve_chat("-1001", credential_deadline=driver.time.monotonic() + 20)
        self.assertEqual(
            raised.exception.diagnostic_code, driver.CREDENTIAL_STATE_MISSING_GROUP
        )

    def test_credential_check_loads_archived_chat_before_classifying_absence(self):
        class FakeClient:
            def __init__(self):
                self.requests = []

            def request(self, payload, timeout=20):
                self.requests.append(payload)
                if payload["@type"] == "getChat" and len(self.requests) == 1:
                    raise driver.DriverError(
                        "getChat failed (400): Chat not found",
                        tdlib_code=400,
                        tdlib_message="Chat not found",
                        tdlib_method="getChat",
                    )
                if payload["@type"] == "loadChats" and payload["chat_list"]["@type"] == "chatListMain":
                    raise driver.DriverError(
                        "loadChats failed (404): Not Found",
                        tdlib_code=404,
                        tdlib_message="Not Found",
                        tdlib_method="loadChats",
                    )
                if payload["@type"] == "getChat":
                    return {"id": -1001}
                return {"@type": "ok"}

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(
            instance.resolve_chat("-1001", credential_deadline=driver.time.monotonic() + 20),
            -1001,
        )
        self.assertEqual(
            [payload["@type"] for payload in instance.client.requests],
            ["getChat", "loadChats", "loadChats", "getChat"],
        )

    def test_credential_check_preserves_list_load_timeout(self):
        list_timeout = driver.DriverError(
            "Timed out waiting for loadChats",
            tdlib_method="loadChats",
            tdlib_timed_out=True,
        )

        class FakeClient:
            def request(self, payload, timeout=20):
                if payload["@type"] == "getChat":
                    raise driver.DriverError(
                        "getChat failed (400): Chat not found",
                        tdlib_code=400,
                        tdlib_message="Chat not found",
                        tdlib_method="getChat",
                    )
                raise list_timeout

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        with self.assertRaises(driver.DriverError) as raised:
            instance.resolve_chat("-1001", credential_deadline=driver.time.monotonic() + 20)
        self.assertIs(raised.exception, list_timeout)
        self.assertEqual(raised.exception.diagnostic_code, "")

    def test_ordinary_numeric_chat_can_load_from_the_main_chat_list(self):
        class FakeClient:
            def __init__(self):
                self.requests = []

            def request(self, payload, timeout=20):
                self.requests.append((payload, timeout))
                if payload["@type"] == "getChat":
                    raise driver.DriverError(
                        "getChat failed (400): Chat not found",
                        tdlib_code=400,
                        tdlib_message="Chat not found",
                        tdlib_method="getChat",
                    )
                return {"chat_ids": [-1001]}

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(instance.resolve_chat("-1001"), -1001)
        self.assertEqual(
            [payload["@type"] for payload, _timeout in instance.client.requests],
            ["getChat", "getChats"],
        )

    def test_numeric_chat_propagates_unrelated_tdlib_failures(self):
        failure = driver.DriverError("Timed out waiting for getChat")

        class FakeClient:
            def request(self, _payload, timeout=20):
                raise failure

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        with self.assertRaises(driver.DriverError) as raised:
            instance.resolve_chat("-1001")
        self.assertIs(raised.exception, failure)
        self.assertEqual(raised.exception.diagnostic_code, "")

    def test_marks_sut_mentions_and_commands_with_utf16_entities(self):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {"sutUsername": "sut_bot", "sutId": 101}
        instance.bot_config = {}
        formatted = instance.formatted_text("😀 @sut_bot hi /status@sut_bot")
        self.assertEqual(
            [entity["type"]["@type"] for entity in formatted["entities"]],
            ["textEntityTypeMention", "textEntityTypeBotCommand"],
        )
        self.assertEqual(formatted["entities"][0]["offset"], 3)
        self.assertEqual(formatted["entities"][0]["length"], 8)

    def test_normalizes_serve_messages_and_edits(self):
        known = {}
        message_id = 42 << 20
        message = {
            "id": message_id,
            "chat_id": -1001,
            "sender_id": {"user_id": 101},
            "date": 123,
            "reply_to": {"message_id": 7},
            "content": {
                "@type": "messageText",
                "text": {"@type": "formattedText", "text": "first", "entities": []},
            },
        }
        users = {101: {"username": "sut_bot"}}

        created = driver.serve_update(
            {"@type": "updateNewMessage", "message": message}, users, known
        )
        edited = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "chat_id": -1001,
                "message_id": message_id,
                "new_content": {
                    "@type": "messageText",
                    "text": {"@type": "formattedText", "text": "final", "entities": []},
                },
            },
            users,
            known,
        )

        self.assertEqual(created["kind"], "message")
        self.assertEqual(created["botApiMessageId"], 42)
        self.assertEqual(created["senderUsername"], "sut_bot")
        self.assertEqual(created["replyToMessageId"], 7)
        self.assertEqual(created["timestamp"], 123000)
        self.assertEqual(edited["kind"], "edit")
        self.assertEqual(edited["text"], "final")
        self.assertEqual(edited["senderId"], 101)

    def test_ignores_unknown_edit_in_serve_mode(self):
        event = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "chat_id": -1001,
                "message_id": 99,
                "new_content": {},
            },
            {},
            {},
        )

        self.assertIsNone(event)


if __name__ == "__main__":
    unittest.main()

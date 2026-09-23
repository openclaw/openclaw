import importlib.util
import io
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch


DRIVER_PATH = Path(__file__).with_name("user-driver.py")
SPEC = importlib.util.spec_from_file_location("tg_user_driver_test_target", DRIVER_PATH)
driver = importlib.util.module_from_spec(SPEC)
sys.modules["tg_user_driver_test_target"] = driver
SPEC.loader.exec_module(driver)


def observation_client(users=None):
    return SimpleNamespace(
        users=users or {},
        request=Mock(side_effect=AssertionError("unexpected TDLib request")),
    )


def rich_content(text, full=True):
    return {
        "@type": "messageRichMessage",
        "message": {
            "@type": "richMessage", "is_full": full, "is_rtl": False,
            "blocks": [{"@type": "pageBlockParagraph", "text": {
                "@type": "richTextPlain", "text": text,
            }}],
        },
    }


def native_message(content, chat_id=-1001, message_id=42 << 20, sender_id=101):
    return {
        "id": message_id, "chat_id": chat_id, "sender_id": {"user_id": sender_id},
        "date": 123, "reply_to": {"message_id": 7}, "content": content,
    }


class AuthorizationTest(unittest.TestCase):
    def test_registers_a_new_test_user_with_explicit_names(self):
        class Client:
            def __init__(self):
                self.requests = []
                self.updates = [
                    {
                        "@type": "updateAuthorizationState",
                        "authorization_state": {
                            "@type": "authorizationStateWaitRegistration",
                        },
                    },
                    {
                        "@type": "updateAuthorizationState",
                        "authorization_state": {"@type": "authorizationStateReady"},
                    },
                ]

            def execute(self, payload):
                self.requests.append(payload)

            def send(self, payload):
                self.requests.append(payload)

            def receive(self, _timeout):
                return self.updates.pop(0)

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = Client()
        instance.printed_qr_link = None
        instance.config = {}
        instance.bot_config = {}
        instance.authorize(
            SimpleNamespace(
                timeout_ms=1000,
                phone="",
                qr=False,
                code="",
                password="",
                first_name="OpenClaw",
                last_name="Guest",
            ),
        )
        self.assertIn(
            {
                "@type": "registerUser",
                "first_name": "OpenClaw",
                "last_name": "Guest",
            },
            instance.client.requests,
        )


class OwnedGroupTest(unittest.TestCase):
    def fixture(self):
        class Client:
            def __init__(self):
                self.requests = []
                self.members = set()
                self.creation_error = None
                self.can_delete = True

            def request(self, payload, timeout=20):
                self.requests.append(payload)
                kind = payload["@type"]
                if kind == "getMe":
                    return {"id": 123}
                if kind == "searchPublicChat":
                    return {"type": {"@type": "chatTypePrivate", "user_id": 42}}
                if kind == "createNewBasicGroupChat":
                    if self.creation_error:
                        raise self.creation_error
                    self.members = {123, *payload["user_ids"]}
                    return {"@type": "createdBasicGroupChat", "chat_id": -2042, "failed_to_add_members": {"failed_to_add_members": []}}
                if kind == "getChat":
                    return {"type": {"@type": "chatTypeBasicGroup"}, "can_be_deleted_for_all_users": self.can_delete}
                if kind == "getChatMember":
                    return {"status": {"@type": "chatMemberStatusMember" if payload["member_id"]["user_id"] in self.members else "chatMemberStatusLeft"}}
                if kind == "addChatMember":
                    self.members.add(payload["user_id"])
                    return {"@type": "failedToAddMembers", "failed_to_add_members": []}
                if kind == "deleteChat":
                    self.members.clear()
                    return {"@type": "ok"}
                raise AssertionError(kind)

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {"testDc": True, "testerUserId": 123, "sutId": 42, "sutUsername": "sut_bot"}
        instance.bot_config = {}
        instance.client = Client()
        return instance

    def test_pinned_creation_shape_and_deletion_remove_all_members(self):
        instance = self.fixture()
        with tempfile.TemporaryDirectory() as root:
            manifest = Path(root) / "owned-test-group.json"
            created = driver.prepare_owned_group(instance, manifest)
            self.assertEqual(created["groupId"], "-2042")
            self.assertEqual(instance.client.members, {123, 42})
            deleted = driver.cleanup_owned_group(instance, manifest)
            self.assertEqual(deleted["status"], "deleted")
            self.assertEqual(instance.client.members, set())
            self.assertEqual(driver.read_json(manifest)["deletion"], {"@type": "ok"})

    def test_production_identity_cannot_create_a_group(self):
        instance = self.fixture()
        instance.config["testDc"] = False
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(driver.DriverError, "Test Server"):
                driver.prepare_owned_group(instance, Path(root) / "group.json")
        self.assertEqual(instance.client.requests, [])

    def test_private_production_forum_is_owned_and_deleted(self):
        instance = self.fixture()
        instance.config["testDc"] = False

        def request(payload, timeout=20):
            instance.client.requests.append(payload)
            kind = payload["@type"]
            if kind == "getMe":
                return {"id": 123, "username": "leased_primary"}
            if kind == "createNewBasicGroupChat":
                self.assertEqual(payload["user_ids"], [])
                return {"chat_id": -2042, "failed_to_add_members": {"failed_to_add_members": []}}
            if kind == "upgradeBasicGroupChatToSupergroupChat":
                self.assertEqual(payload["chat_id"], -2042)
                return {"id": -1002042, "type": {"@type": "chatTypeSupergroup", "supergroup_id": 2042, "is_channel": False}}
            if kind == "setChatMemberStatus":
                self.assertEqual(payload["chat_id"], -1002042)
                self.assertEqual(payload["member_id"]["user_id"], 42)
                self.assertEqual(payload["status"]["@type"], "chatMemberStatusMember")
                self.assertEqual(payload["status"]["member_until_date"], 0)
                return {"@type": "ok"}
            if kind == "toggleSupergroupIsForum":
                self.assertEqual(payload, {"@type": kind, "supergroup_id": 2042, "is_forum": True, "has_forum_tabs": True})
                return {"@type": "ok"}
            if kind == "createForumTopic":
                self.assertEqual(payload["chat_id"], -1002042)
                return {"forum_topic_id": 777, "name": payload["name"]}
            if kind == "createChatInviteLink":
                return {"invite_link": "https://example.invalid/private-invite"}
            if kind == "getChat":
                return {
                    "id": -1002042,
                    "type": {"@type": "chatTypeSupergroup", "is_channel": False},
                    # The server can lag this projection immediately after creation.
                    "can_be_deleted_for_all_users": False,
                }
            if kind == "getChatMember":
                return {"status": {"@type": "chatMemberStatusCreator"}}
            if kind == "deleteChat":
                return {"@type": "ok"}
            raise AssertionError(kind)

        instance.client.request = request
        with tempfile.TemporaryDirectory() as root:
            manifest = Path(root) / "private-forum.json"
            prepared = driver.prepare_private_forum(instance, manifest)
            self.assertEqual(prepared["groupId"], "-1002042")
            self.assertEqual(prepared["forumTopicId"], 777)
            self.assertNotIn("inviteLink", prepared)
            self.assertIn("inviteLink", driver.read_json(manifest))

            cleaned = driver.cleanup_private_forum(instance, manifest)
            self.assertEqual(cleaned["status"], "deleted")
            self.assertNotIn("inviteLink", driver.read_json(manifest))

        self.assertEqual(
            [request["@type"] for request in instance.client.requests],
            [
                "getMe",
                "createNewBasicGroupChat",
                "upgradeBasicGroupChatToSupergroupChat",
                "setChatMemberStatus",
                "toggleSupergroupIsForum",
                "createForumTopic",
                "createChatInviteLink",
                "getMe",
                "getChat",
                "getChatMember",
                "deleteChat",
            ],
        )

    def test_private_forum_cleanup_deletes_an_interrupted_basic_group(self):
        instance = self.fixture()
        instance.config["testDc"] = False
        instance.client.members = {123}
        request = instance.client.request

        def request_as_creator(payload, timeout=20):
            if payload["@type"] == "getChatMember":
                instance.client.requests.append(payload)
                return {"status": {"@type": "chatMemberStatusCreator"}}
            return request(payload, timeout)

        instance.client.request = request_as_creator
        with tempfile.TemporaryDirectory() as root:
            manifest = Path(root) / "private-forum.json"
            driver.write_json_private(
                manifest,
                {
                    "basicGroupId": "-2042",
                    "status": "basic-group-created",
                    "sutBotId": "42",
                    "testerUserId": "123",
                },
            )
            cleaned = driver.cleanup_private_forum(instance, manifest)
            self.assertEqual(cleaned["status"], "deleted")

        self.assertEqual(
            [request["@type"] for request in instance.client.requests],
            ["getMe", "getChat", "getChatMember", "deleteChat"],
        )

    def test_existing_group_membership_is_repaired_and_only_added_bot_leaves(self):
        instance = self.fixture()
        instance.client.members = {123, 777}
        def bot_request(token, method, payload=None, test_dc=False):
            self.assertEqual(token, "synthetic-file-token")
            self.assertTrue(test_dc)
            if method == "getMe":
                return {"id": 42}
            self.assertEqual(method, "leaveChat")
            self.assertEqual(payload, {"chat_id": "-3000"})
            instance.client.members.remove(42)
            return True
        with tempfile.TemporaryDirectory() as root, patch.dict(driver.os.environ, {}, clear=True), patch.object(driver, "telegram_bot", side_effect=bot_request):
            credentials_path = Path(root) / "credentials.local.json"
            driver.write_json_private(credentials_path, {"sutBotToken": "synthetic-file-token"})
            with patch.object(driver, "STATE_DIR", Path(root) / "user-driver"), patch.object(driver, "CONFIG_PATH", Path(root) / "user-driver/config.local.json"), patch.object(driver, "BOT_CREDENTIALS_PATH", credentials_path):
                _, instance.bot_config = driver.load_config()
            self.assertEqual(credentials_path.stat().st_mode & 0o777, 0o600)
            manifest = Path(root) / "owned-test-group.json"
            result = driver.prepare_owned_group(instance, manifest, "-3000")
            self.assertEqual(result["status"], "membership-added")
            self.assertEqual(instance.client.members, {123, 777, 42})
            self.assertEqual(driver.cleanup_owned_group(instance, manifest)["status"], "membership-removed")
            self.assertEqual(instance.client.members, {123, 777})
            self.assertFalse(any(p["@type"] in {"deleteChat", "createNewBasicGroupChat"} for p in instance.client.requests))
            self.assertNotIn("synthetic-file-token", manifest.read_text())

    def test_existing_bot_membership_is_preserved(self):
        instance = self.fixture()
        instance.client.members = {123, 42, 777}
        with tempfile.TemporaryDirectory() as root:
            manifest = Path(root) / "owned-test-group.json"
            self.assertEqual(driver.prepare_owned_group(instance, manifest, "-3000")["status"], "existing")
            self.assertEqual(driver.cleanup_owned_group(instance, manifest)["status"], "not-created")
        self.assertEqual(instance.client.members, {123, 42, 777})

    def test_uncertain_creation_is_not_retried_or_released_as_clean(self):
        instance = self.fixture()
        instance.client.creation_error = driver.DriverError("Timed out")
        with tempfile.TemporaryDirectory() as root:
            manifest = Path(root) / "group.json"
            with self.assertRaisesRegex(driver.DriverError, "Timed out"):
                driver.prepare_owned_group(instance, manifest)
            self.assertEqual(driver.read_json(manifest)["status"], "creating")
            with self.assertRaisesRegex(driver.DriverError, "reconcile"):
                driver.prepare_owned_group(instance, manifest)
            with self.assertRaisesRegex(driver.DriverError, "unconfirmed"):
                driver.cleanup_owned_group(instance, manifest)
        self.assertEqual(sum(p["@type"] == "createNewBasicGroupChat" for p in instance.client.requests), 1)

    def test_delete_permission_failure_preserves_created_group_record(self):
        instance = self.fixture()
        with tempfile.TemporaryDirectory() as root:
            manifest = Path(root) / "group.json"
            driver.prepare_owned_group(instance, manifest)
            instance.client.can_delete = False
            with self.assertRaisesRegex(driver.DriverError, "cannot delete"):
                driver.cleanup_owned_group(instance, manifest)
            self.assertEqual(driver.read_json(manifest)["status"], "created")
            self.assertEqual(instance.client.members, {123, 42})


class PhotoContentTest(unittest.TestCase):
    def test_text_photo_and_album_preserve_forum_topic_and_reply_with_pinned_api(self):
        class Transport:
            def __init__(self):
                self.requests = []
            def request(self, payload, timeout=20):
                self.requests.append(payload)
                return {"messages": [{"id": 2}]} if payload["@type"] == "sendMessageAlbum" else {"id": 2}
        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.config = {}
        instance.bot_config = {}
        instance.client = Transport()
        with tempfile.NamedTemporaryFile(suffix=".jpg") as photo:
            instance.send_text(-10042, "topic text", reply_to=7, forum_topic_id=12)
            instance.send_photos(-10042, [photo.name], reply_to=7, forum_topic_id=12)
            instance.send_photos(-10042, [photo.name, photo.name], reply_to=7, forum_topic_id=12)
        self.assertEqual(len(instance.client.requests), 3)
        for request in instance.client.requests:
            self.assertEqual(request["topic_id"], {"@type": "messageTopicForum", "forum_topic_id": 12})
            self.assertEqual(request["reply_to"]["message_id"], 7)
            self.assertEqual(request["reply_to"]["@type"], "inputMessageReplyToMessage")
            self.assertNotIn("message_thread_id", request)
            self.assertNotIn("reply_to_message_id", request)

    def test_rejects_unsafe_prebuilt_archive_members(self):
        class FakeTar:
            extracted = False

            def getmembers(self):
                return [driver.tarfile.TarInfo("../escape")]

            def extractall(self, _destination):
                self.extracted = True

        archive = FakeTar()
        with self.assertRaisesRegex(driver.DriverError, "unsafe member"):
            driver.extract_prebuilt_archive(archive, tempfile.gettempdir())
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
                if payload["@type"] == "getChat":
                    if len([request for request, _timeout in self.requests if request["@type"] == "getChat"]) > 1:
                        return {"id": -1001}
                    raise driver.DriverError(
                        "getChat failed (400): Chat not found",
                        tdlib_code=400,
                        tdlib_message="Chat not found",
                        tdlib_method="getChat",
                    )
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
                    raise driver.TdRequestError(
                        "getChat failed (400): Chat not found",
                        tdlib_code=400,
                        tdlib_message="Chat not found",
                        tdlib_method="getChat",
                    )
                raise driver.TdRequestError(
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
                    raise driver.TdRequestError(
                        "getChat failed (400): Chat not found",
                        tdlib_code=400,
                        tdlib_message="Chat not found",
                        tdlib_method="getChat",
                    )
                if payload["@type"] == "loadChats" and payload["chat_list"]["@type"] == "chatListMain":
                    raise driver.TdRequestError(
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
                    raise driver.TdRequestError(
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

    def test_ordinary_numeric_chat_refreshes_the_main_chat_list(self):
        class FakeClient:
            def __init__(self):
                self.requests = []
                self.get_chat_calls = 0

            def request(self, payload, timeout=20):
                self.requests.append((payload, timeout))
                if payload["@type"] == "getChat":
                    self.get_chat_calls += 1
                    if self.get_chat_calls == 1:
                        raise driver.DriverError(
                            "getChat failed (400): Chat not found",
                            tdlib_code=400,
                            tdlib_message="Chat not found",
                            tdlib_method="getChat",
                        )
                    return {"id": -1001}
                return {"@type": "ok"}

        instance = driver.UserDriver.__new__(driver.UserDriver)
        instance.client = FakeClient()
        self.assertEqual(instance.resolve_chat("-1001"), -1001)
        self.assertEqual(
            [payload["@type"] for payload, _timeout in instance.client.requests],
            ["getChat", "loadChats", "getChat"],
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
        text = "😀 a   b x"
        entities = [
            {"offset": 3, "length": 5, "type": {"@type": "textEntityTypeCode"}},
            {
                "offset": 9,
                "length": 1,
                "type": {"@type": "textEntityTypeTextUrl", "url": "https://example.com/qa"},
            },
        ]
        message = {
            "id": message_id,
            "chat_id": -1001,
            "sender_id": {"user_id": 101},
            "date": 123,
            "reply_to": {"message_id": 7},
            "content": {
                "@type": "messageText",
                "text": {"@type": "formattedText", "text": text, "entities": entities},
            },
        }
        client = observation_client({101: {"username": "sut_bot"}})
        created = driver.serve_update(
            {"@type": "updateNewMessage", "message": message}, client, known
        )
        self.assertEqual(created["kind"], "message")
        self.assertEqual(created["botApiMessageId"], 42)
        self.assertEqual(created["senderUsername"], "sut_bot")
        self.assertEqual(created["replyToMessageId"], 7)
        self.assertEqual(created["timestamp"], 123000)
        self.assertEqual(created["contentType"], "messageText")
        self.assertEqual(created["text"], text)
        self.assertEqual(created["entities"], entities)

        for edited_text, edited_entities in [
            (text, [{"offset": 3, "length": 5, "type": {"@type": "textEntityTypeBold"}}]),
            (text, []),
            ("final", [{"offset": 0, "length": 5, "type": {"@type": "textEntityTypePre"}}]),
        ]:
            with self.subTest(text=edited_text, entities=edited_entities):
                edited = driver.serve_update(
                    {
                        "@type": "updateMessageContent",
                        "chat_id": -1001,
                        "message_id": message_id,
                        "new_content": {
                            "@type": "messageText",
                            "text": {
                                "@type": "formattedText",
                                "text": edited_text,
                                "entities": edited_entities,
                            },
                        },
                    },
                    client,
                    known,
                )
                self.assertEqual(edited["kind"], "edit")
                self.assertEqual(edited["contentType"], "messageText")
                self.assertEqual(edited["text"], edited_text)
                self.assertEqual(edited["entities"], edited_entities)
                self.assertEqual(edited["senderId"], 101)
                self.assertEqual(known[(-1001, message_id)]["entities"], edited_entities)

    def test_preserves_native_content_type_and_caption_entities_in_messages_and_edits(self):
        entities = [{"offset": 3, "length": 5, "type": {"@type": "textEntityTypeCode"}}]
        message = {
            "id": 43 << 20,
            "chat_id": -1001,
            "sender_id": {"user_id": 101},
            "date": 123,
            "content": {
                "@type": "messagePhoto",
                "caption": {"@type": "formattedText", "text": "😀 a   b", "entities": entities},
            },
        }
        known = {}
        client = observation_client()
        created = driver.serve_update(
            {"@type": "updateNewMessage", "message": message}, client, known
        )
        normalized = driver.normalize_message(message)
        self.assertEqual(created["contentType"], "messagePhoto")
        self.assertEqual(created["text"], "😀 a   b")
        self.assertEqual(created["entities"], entities)
        self.assertEqual(normalized["entities"], entities)
        self.assertIs(normalized["raw"], message)
        edited = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "chat_id": -1001,
                "message_id": message["id"],
                "new_content": {
                    "@type": "messageVideo",
                    "caption": {"@type": "formattedText", "text": "😀 a   b", "entities": []},
                },
            },
            client,
            known,
        )
        self.assertEqual(edited["contentType"], "messageVideo")
        self.assertEqual(known[(-1001, message["id"])]["contentType"], "messageVideo")
        self.assertEqual(edited["text"], "😀 a   b")
        self.assertEqual(edited["entities"], [])

    def test_requires_explicit_entity_vectors_for_text_and_captions(self):
        for content_type, field in [("messageText", "text"), ("messagePhoto", "caption")]:
            for kind in ("message", "edit"):
                with self.subTest(content_type=content_type, kind=kind):
                    formatted = {"@type": "formattedText", "text": "plain", "entities": []}
                    content = {"@type": content_type, field: formatted}
                    message = {
                        "id": 44 << 20,
                        "chat_id": -1001,
                        "sender_id": {"user_id": 101},
                        "content": content,
                    }
                    known = {}
                    client = observation_client()
                    created = driver.serve_update(
                        {"@type": "updateNewMessage", "message": message}, client, known
                    )
                    self.assertEqual(created["text"], "plain")
                    self.assertEqual(created["entities"], [])

                    del formatted["entities"]
                    update = (
                        {"@type": "updateNewMessage", "message": message}
                        if kind == "message"
                        else {
                            "@type": "updateMessageContent",
                            "chat_id": -1001,
                            "message_id": message["id"],
                            "new_content": content,
                        }
                    )
                    with self.assertRaisesRegex(KeyError, "entities"):
                        driver.serve_update(update, client, known)
                    self.assertEqual(known[(-1001, message["id"])]["entities"], [])

    def test_ignores_unknown_edit_in_serve_mode(self):
        event = driver.serve_update(
            {
                "@type": "updateMessageContent",
                "chat_id": -1001,
                "message_id": 99,
                "new_content": {},
            },
            observation_client(),
            {},
        )

        self.assertIsNone(event)

    def test_preserves_rich_tree_revisions_and_clears_it_on_plain_replacement(self):
        known = {}
        client = observation_client()
        message_id = 45 << 20
        rich = {
            "@type": "richMessage", "is_full": True, "is_rtl": False,
            "blocks": [{"@type": "pageBlockParagraph", "text": {
                "@type": "richTextUrl", "url": "https://example.com/qa", "is_cached": False,
                "text": {"@type": "richTextSpoiler", "text": {
                    "@type": "richTextMathematicalExpression", "expression": "x",
                }},
            }}],
        }
        content = {"@type": "messageRichMessage", "message": rich}
        created = driver.serve_update({"@type": "updateNewMessage", "message": {
            "id": message_id, "chat_id": -1001, "sender_id": {"user_id": 101},
            "content": content,
        }}, client, known)
        self.assertEqual(created["richMessage"], rich)
        self.assertEqual(created["text"], "x")
        self.assertEqual(created["entities"], [])
        replacement = {**rich, "blocks": [{
            "@type": "pageBlockParagraph", "text": {
                "@type": "richTextCustomEmoji", "custom_emoji_id": "5368324170671202286",
                "alternative_text": "😀",
            },
        }]}
        for next_content, expected_text, expected_rich in [
            ({"@type": "messageRichMessage", "message": replacement}, "😀", replacement),
            ({"@type": "messageText", "text": {"text": "final", "entities": []}}, "final", None),
            ({"@type": "messageUnsupported"}, "", None),
        ]:
            with self.subTest(content_type=next_content["@type"]):
                edited = driver.serve_update({
                    "@type": "updateMessageContent", "chat_id": -1001,
                    "message_id": message_id,
                    "new_content": next_content,
                }, client, known)
                self.assertEqual(edited["richMessage"], expected_rich)
                self.assertEqual(edited["text"], expected_text)
                self.assertEqual(edited["botApiMessageId"], 45)
                self.assertEqual(known[(-1001, message_id)]["richMessage"], expected_rich)


class RichObservationTest(unittest.TestCase):
    def test_serve_hydrates_selected_chat_messages_and_edits_before_emitting(self):
        partial = rich_content("preview", full=False)
        plain = {"@type": "messageText", "text": {"text": "plain replacement", "entities": []}}
        updates = [
            {"@type": "updateNewMessage", "message": native_message(partial, chat_id=-2002)},
            {"@type": "updateNewMessage", "message": native_message(partial)},
            {"@type": "updateMessageContent", "chat_id": -1001,
             "message_id": 42 << 20, "new_content": partial},
            {"@type": "updateMessageContent", "chat_id": -1001,
             "message_id": 42 << 20, "new_content": plain},
        ]
        raw_updates = deepcopy(updates)
        pending = list(updates)
        full = [rich_content(text)["message"] for text in ("full send", "full edit")]
        client = observation_client({101: {"username": "sut_bot"}})
        responses = iter(full)

        def request(payload, timeout=20):
            if payload["@type"] == "getMe":
                return {"id": 303}
            self.assertEqual(payload, {
                "@type": "getFullRichMessage", "chat_id": -1001, "message_id": 42 << 20,
            })
            return next(responses)

        client.request.side_effect = request
        client.next_update = lambda timeout: pending.pop(0) if pending else None
        instance = SimpleNamespace(
            client=client, authorize=lambda *_: None, resolve_chat=lambda *_: -1001,
            check_group_write_access=Mock(return_value=True),
        )
        events = []
        with patch.object(driver, "load_config", return_value=({}, {})), \
                patch.object(driver, "UserDriver", return_value=instance), \
                patch.object(driver, "write_ndjson", side_effect=events.append), \
                patch.object(driver.sys, "stdin", io.StringIO("")), \
                patch.object(driver.select, "select", side_effect=lambda *_: (
                    [] if pending else [driver.sys.stdin], [], []
                )):
            driver.command_serve(SimpleNamespace(chat="-1001", timeout_ms=1000))

        observed = [event["update"] for event in events if event["type"] == "update"]
        self.assertEqual([event["kind"] for event in observed], ["message", "edit", "edit"])
        self.assertEqual([event["text"] for event in observed], ["full send", "full edit", "plain replacement"])
        self.assertEqual([event["richMessage"] for event in observed], [*full, None])
        for event in observed:
            self.assertEqual((event["chatId"], event["messageId"], event["senderId"]), (-1001, 42 << 20, 101))
            self.assertEqual(event["senderUsername"], "sut_bot")
            self.assertEqual(event["replyToMessageId"], 7)
        self.assertEqual([call.args[0]["@type"] for call in client.request.call_args_list],
                         ["getMe", "getFullRichMessage", "getFullRichMessage"])
        self.assertEqual(updates, raw_updates)

    def test_same_message_id_in_different_chats_keeps_its_own_edit_and_fetch(self):
        client = observation_client()
        known = {}
        for chat_id, sender_id in [(-1001, 101), (-2002, 202)]:
            driver.serve_update({
                "@type": "updateNewMessage",
                "message": native_message(rich_content(str(chat_id)), chat_id=chat_id, sender_id=sender_id),
            }, client, known)
        other = deepcopy(known[(-2002, 42 << 20)])
        full = rich_content("updated first chat")["message"]
        client.request.side_effect = None
        client.request.return_value = full
        edited = driver.serve_update({
            "@type": "updateMessageContent", "chat_id": -1001, "message_id": 42 << 20,
            "new_content": rich_content("preview", full=False),
        }, client, known)

        client.request.assert_called_once_with({
            "@type": "getFullRichMessage", "chat_id": -1001, "message_id": 42 << 20,
        })
        self.assertEqual((edited["kind"], edited["chatId"], edited["senderId"]), ("edit", -1001, 101))
        self.assertEqual(edited["richMessage"], full)
        self.assertEqual(known[(-1001, 42 << 20)]["text"], "updated first chat")
        self.assertEqual(known[(-2002, 42 << 20)], other)

    def test_failed_or_incomplete_fetch_does_not_commit_a_partial_observation(self):
        for kind in ("message", "edit"):
            for outcome in ("request-error", "incomplete", "wrong-type"):
                with self.subTest(kind=kind, outcome=outcome):
                    client = observation_client()
                    known = {}
                    if kind == "edit":
                        driver.serve_update({"@type": "updateNewMessage", "message": native_message(
                            rich_content("previous complete content"),
                        )}, client, known)
                    before = deepcopy(known)
                    if outcome == "request-error":
                        client.request.side_effect = driver.DriverError("synthetic lookup failure")
                    else:
                        client.request.side_effect = None
                        client.request.return_value = (
                            rich_content("still partial", full=False)["message"]
                            if outcome == "incomplete" else {"@type": "ok"}
                        )
                    partial = rich_content("preview", full=False)
                    update = (
                        {"@type": "updateNewMessage", "message": native_message(partial)}
                        if kind == "message" else {
                            "@type": "updateMessageContent", "chat_id": -1001,
                            "message_id": 42 << 20, "new_content": partial,
                        }
                    )
                    with self.assertRaises(driver.DriverError):
                        driver.serve_update(update, client, known)
                    self.assertEqual(known, before)
                    self.assertFalse(partial["message"]["is_full"])

    def test_full_fetch_preserves_native_update_fifo_on_success_and_failure(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                client = driver.TdClient.__new__(driver.TdClient)
                client.users = {}
                earlier = {"@type": "updateChatAction", "chat_id": -1001}
                other = {"@type": "updateNewMessage", "message": native_message(
                    rich_content("other chat"), chat_id=-2002, sender_id=202,
                )}
                later = {
                    "@type": "updateMessageContent", "chat_id": -1001,
                    "message_id": 42 << 20, "new_content": {
                        "@type": "messageText", "text": {"text": "later plain edit", "entities": []},
                    },
                }
                client.updates = [earlier]
                client.send = Mock(return_value="full-request")
                response = (
                    {"@type": "error", "code": 400, "message": "synthetic lookup failure"}
                    if failed else rich_content("fetched snapshot")["message"]
                )
                client.receive = Mock(side_effect=[other, later, {**response, "@extra": "full-request"}])
                known = {}
                driver.serve_update({"@type": "updateNewMessage", "message": native_message(
                    rich_content("original"),
                )}, client, known)
                partial_edit = {
                    "@type": "updateMessageContent", "chat_id": -1001,
                    "message_id": 42 << 20, "new_content": rich_content("preview", full=False),
                }
                if failed:
                    with self.assertRaisesRegex(driver.DriverError, "synthetic lookup failure"):
                        driver.serve_update(partial_edit, client, known)
                    self.assertEqual(known[(-1001, 42 << 20)]["text"], "original")
                else:
                    event = driver.serve_update(partial_edit, client, known)
                    self.assertEqual((event["kind"], event["text"]), ("edit", "fetched snapshot"))
                client.send.assert_called_once_with({
                    "@type": "getFullRichMessage", "chat_id": -1001, "message_id": 42 << 20,
                })
                for expected in (earlier, other, later):
                    update = client.next_update()
                    self.assertIs(update, expected)
                    driver.serve_update(update, client, known)
                self.assertEqual(client.updates, [])
                self.assertEqual(known[(-1001, 42 << 20)]["text"], "later plain edit")
                self.assertIsNone(known[(-1001, 42 << 20)]["richMessage"])
                self.assertEqual(known[(-2002, 42 << 20)]["senderId"], 202)


class ServeTargetTest(unittest.TestCase):
    def test_serves_dm_group_and_forum_without_losing_observed_topic(self):
        client = observation_client()
        client.request.side_effect = None
        client.request.return_value = {"id": 303}
        client.next_update = lambda timeout: None
        def send(chat_id, text, reply_to=None, forum_topic_id=None):
            message = native_message({"@type": "messageText", "text": {"text": text, "entities": []}}, chat_id=chat_id, sender_id=303)
            if forum_topic_id is not None:
                message["topic_id"] = {"@type": "messageTopicForum", "forum_topic_id": forum_topic_id}
            return message
        instance = SimpleNamespace(client=client, authorize=lambda *_: None,
            resolve_chat=lambda value: int(value), check_group_write_access=Mock(return_value=True),
            send_text=Mock(side_effect=send))
        commands = [
            {"id": "1", "method": "send", "text": "dm", "chatId": "200"},
            {"id": "2", "method": "send", "text": "group"},
            {"id": "3", "method": "send", "text": "forum", "chatId": "-2002", "forumTopicId": 42},
            {"id": "4", "method": "cleanup-private-forum"},
            {"id": "5", "method": "send", "text": "invalid", "forumTopicId": True},
        ]
        events = []
        with patch.object(driver, "load_config", return_value=({}, {})), \
                patch.object(driver, "UserDriver", return_value=instance), \
                patch.object(driver, "cleanup_private_forum", return_value={"ok": True, "status": "deleted"}) as cleanup, \
                patch.object(driver, "write_ndjson", side_effect=events.append), \
                patch.object(driver.sys, "stdin", io.StringIO("\n".join(driver.json.dumps(value) for value in commands))), \
                patch.object(driver.select, "select", side_effect=lambda *_: ([driver.sys.stdin], [], [])):
            driver.command_serve(SimpleNamespace(chat="-1001", observe_chat=["-2002"], timeout_ms=1000))
        sent = [event["result"] for event in events if "result" in event and "chatId" in event["result"]]
        self.assertEqual([value["chatId"] for value in sent], [200, -1001, -2002])
        self.assertEqual([value["senderId"] for value in sent], [303, 303, 303])
        self.assertEqual(sent[-1]["forumTopicId"], 42)
        self.assertIn("positive integer", events[-1]["error"])
        self.assertEqual(instance.send_text.call_count, 3)
        cleanup.assert_called_once_with(instance, driver.STATE_DIR / "owned-private-forum.json")
        self.assertEqual([call.args[0] for call in instance.check_group_write_access.call_args_list], [-1001, -2002, 200])


class GroupWriteAccessTest(unittest.TestCase):
    def make_driver(self, status, default=True, boosts=None, kind="chatTypeSupergroup", active=True):
        instance = driver.UserDriver.__new__(driver.UserDriver)
        requests = []
        class Client:
            users = {}

            def next_update(self, timeout):
                return None

            def request(self, payload, timeout=20):
                requests.append(payload)
                return {
                    "getChat": {"type": {"@type": kind, "supergroup_id": 1, "basic_group_id": 1, "is_channel": False}, "permissions": {"can_send_basic_messages": default}},
                    "getChatMember": {"status": status},
                    "getSupergroupFullInfo": boosts or {},
                    "getBasicGroup": {"is_active": active},
                    "getMe": {"id": 123},
                }[payload["@type"]]
        instance.client = Client()
        return instance, requests

    def test_effective_group_text_permissions(self):
        cases = [
            ({"@type": "chatMemberStatusMember"}, True, None, True),
            ({"@type": "chatMemberStatusMember"}, False, None, False),
            ({"@type": "chatMemberStatusMember"}, None, None, False),
            ({"@type": "chatMemberStatusLeft"}, True, None, False),
            ({"@type": "chatMemberStatusBanned"}, True, None, False),
            ({"@type": "chatMemberStatusCreator", "is_member": False}, True, None, False),
            ({"@type": "chatMemberStatusCreator", "is_member": True}, False, None, True),
            ({"@type": "chatMemberStatusAdministrator"}, False, None, True),
            ({"@type": "chatMemberStatusRestricted", "is_member": False, "permissions": {"can_send_basic_messages": True}}, True, None, False),
            ({"@type": "chatMemberStatusRestricted", "is_member": True, "permissions": {}}, True, None, False),
            ({"@type": "chatMemberStatusRestricted", "is_member": True, "permissions": {"can_send_basic_messages": False}}, True, None, False),
            ({"@type": "chatMemberStatusRestricted", "is_member": True, "permissions": {"can_send_basic_messages": True}}, True, None, True),
            ({"@type": "chatMemberStatusRestricted", "is_member": True, "permissions": {"can_send_basic_messages": True}}, False, None, False),
            ({"@type": "chatMemberStatusMember"}, False, {"unrestrict_boost_count": 2, "my_boost_count": 2}, True),
            ({"@type": "chatMemberStatusMember"}, False, {"unrestrict_boost_count": 2, "my_boost_count": 1}, False),
            ({"@type": "chatMemberStatusMember"}, False, {"unrestrict_boost_count": 0, "my_boost_count": 0}, False),
        ]
        for status, default, boosts, allowed in cases:
            with self.subTest(status=status, default=default, boosts=boosts):
                instance, requests = self.make_driver(status, default, boosts)
                if allowed:
                    self.assertTrue(instance.check_group_write_access(-1001, 123))
                else:
                    with self.assertRaisesRegex(driver.DriverError, "credential pool owner"):
                        instance.check_group_write_access(-1001, 123)
                self.assertTrue(all(p["@type"].startswith("get") for p in requests))

    def test_inactive_basic_group_is_not_writable_even_for_creator(self):
        instance, _ = self.make_driver({"@type": "chatMemberStatusCreator", "is_member": True}, kind="chatTypeBasicGroup", active=False)
        with self.assertRaisesRegex(driver.DriverError, "inactive"):
            instance.check_group_write_access(-1001, 123)

    def test_private_chat_does_not_claim_group_permission(self):
        instance, requests = self.make_driver({}, kind="chatTypePrivate")
        self.assertFalse(instance.check_group_write_access(123, 123))
        self.assertEqual(len(requests), 1)

    def test_denied_tester_never_announces_ready_or_sends(self):
        from unittest.mock import patch
        import argparse
        import io
        instance, requests = self.make_driver({"@type": "chatMemberStatusLeft"})
        instance.authorize = lambda args: None
        instance.resolve_chat = lambda chat: -1001
        emitted = []
        with patch.object(driver, "load_config", return_value=({}, {})), patch.object(driver, "UserDriver", return_value=instance), patch.object(driver, "write_ndjson", side_effect=emitted.append), patch.object(driver.sys, "stdin", io.StringIO("")), patch.object(driver.select, "select", return_value=([driver.sys.stdin], [], [])):
            with self.assertRaisesRegex(driver.DriverError, "not an active member"):
                driver.command_serve(argparse.Namespace(timeout_ms=1000, chat="-1001"))
        self.assertEqual(emitted, [])
        self.assertNotIn("sendMessage", [p["@type"] for p in requests])

if __name__ == "__main__":
    unittest.main()

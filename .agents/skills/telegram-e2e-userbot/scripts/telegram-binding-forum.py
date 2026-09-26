#!/usr/bin/env python3
"""Prepare one leased Test Server forum; clean only receipt-owned state."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import sys
import time

def safe_exception(kind, error, trace):
    code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[A-Z_]+", str(error)) else "TDLIB_OPERATION_FAILED"
    print(json.dumps({"ok": False, "code": code,
                      "method": getattr(error, "tdlib_method", ""),
                      "tdlibCode": getattr(error, "tdlib_code", None)}))

sys.excepthook = safe_exception
mode, source, spec_path = sys.argv[1:]
spec = json.loads(Path(spec_path).read_text())
driver_path = Path(source) / ".agents/skills/telegram-e2e-userbot/scripts/user-driver.py"
module_spec = importlib.util.spec_from_file_location("proof_telegram_driver", driver_path)
driver = importlib.util.module_from_spec(module_spec)
sys.modules[module_spec.name] = driver
module_spec.loader.exec_module(driver)
if not os.environ.get("TELEGRAM_USER_DRIVER_STATE_DIR"):
    raise RuntimeError("RUNNER_STATE_REQUIRED")
config, bot = driver.load_config()
if config.get("testDc") is not True:
    raise RuntimeError("TEST_SERVER_REQUIRED")
client = driver.UserDriver(config, bot)

def write_owned(record):
    path = Path(spec_path).with_name("owned-forum.json")
    temporary = path.with_suffix(".json.next")
    with temporary.open("x", encoding="utf8") as handle:
        os.chmod(temporary, 0o600)
        json.dump(record, handle, indent=2)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)

def assert_owned_creator(record, identity):
    receipt = record.get("creationReceipt", {})
    if (record.get("runId") != spec["runId"] or record.get("testerUserId") != identity["testerUserId"]
        or record.get("sutBotId") != identity["sutBotId"] or record.get("environment") != "test"
        or receipt.get("chatId") != record.get("chatId") or receipt.get("title") != record.get("title")
        or receipt.get("type", {}).get("supergroup_id") != record.get("supergroupId")
        or receipt.get("type", {}).get("is_channel") is not False):
        raise RuntimeError("OWNED_FORUM_RECEIPT_IDENTITY_MISMATCH")
    request = client.client.request
    chat_id = int(record["chatId"])
    chat = request({"@type": "getChat", "chat_id": chat_id})
    chat_type = chat.get("type", {})
    if (chat.get("id") != chat_id or chat.get("title") != record["title"]
        or chat_type.get("@type") != "chatTypeSupergroup" or chat_type.get("is_channel") is not False
        or str(chat_type.get("supergroup_id")) != str(record["supergroupId"])):
        raise RuntimeError("OWNED_FORUM_CURRENT_CHAT_MISMATCH")
    member = request({"@type": "getChatMember", "chat_id": chat_id,
                      "member_id": {"@type": "messageSenderUser", "user_id": int(identity["testerUserId"])}})
    if member.get("status", {}).get("@type") != "chatMemberStatusCreator" or member["status"].get("is_member") is not True:
        raise RuntimeError("OWNED_FORUM_CREATOR_NO_LONGER_CURRENT")
    return chat

def assert_bot_write(chat_id, bot_id):
    chat = client.client.request({"@type": "getChat", "chat_id": chat_id})
    member = client.client.request({"@type": "getChatMember", "chat_id": chat_id,
                                   "member_id": {"@type": "messageSenderUser", "user_id": bot_id}})
    membership = member.get("status", {})
    kind = membership.get("@type")
    if kind == "chatMemberStatusAdministrator":
        return
    if kind not in ("chatMemberStatusMember", "chatMemberStatusRestricted"):
        raise RuntimeError("LEASED_SUT_NOT_ACTIVE_MEMBER")
    if kind == "chatMemberStatusRestricted" and (membership.get("is_member") is not True or
        membership.get("permissions", {}).get("can_send_basic_messages") is not True):
        raise RuntimeError("LEASED_SUT_TEXT_RESTRICTED")
    if chat.get("permissions", {}).get("can_send_basic_messages") is not True:
        raise RuntimeError("LEASED_SUT_DEFAULT_TEXT_RIGHT_NOT_CONFIRMED")

def prepare_owned_forum(identity):
    path = Path(spec_path).with_name("owned-forum.json")
    if spec.get("owned") is not True or path.exists() or path.with_suffix(".json.next").exists():
        raise RuntimeError("OWNED_FORUM_PREPARATION_ALREADY_ATTEMPTED")
    request = client.client.request
    bot_chat = request({"@type": "searchPublicChat", "username": identity["sutUsername"]})
    if bot_chat.get("type") != {"@type": "chatTypePrivate", "user_id": int(identity["sutBotId"])}:
        raise RuntimeError("LEASED_SUT_LOOKUP_MISMATCH")
    nonce = secrets.token_hex(6)
    creation = {
        "@type": "createNewSupergroupChat", "title": f"OpenClaw binding {spec['runId']} {nonce}",
        "is_channel": False, "is_forum": False,
        "description": "Run-owned Telegram Test Server binding proof.",
        "location": None, "message_auto_delete_time": 0, "for_import": False,
    }
    record = {
        "schemaVersion": 1, "environment": "test", "runId": spec["runId"],
        "testerUserId": identity["testerUserId"], "sutBotId": identity["sutBotId"],
        "title": creation["title"], "topicTitle": f"Binding proof {nonce}",
        "creationIntent": creation, "createdAtUnixSeconds": int(time.time()),
        "status": "creating-supergroup", "pending": "createNewSupergroupChat",
    }
    write_owned(record)
    try:
        created = request(creation)
        record.update(chatId=created.get("id"), supergroupId=created.get("type", {}).get("supergroup_id"),
                      creationReceipt={"chatId": created.get("id"), "type": created.get("type"), "title": created.get("title")},
                      status="supergroup-returned", pending=None)
        write_owned(record)
        if (type(record["chatId"]) is not int or record["chatId"] >= 0 or
            type(record["supergroupId"]) is not int or record["supergroupId"] <= 0):
            record["creationUncertain"] = True
            write_owned(record)
            raise RuntimeError("CREATED_GROUP_IDENTITY_UNCONFIRMED")
        assert_owned_creator(record, identity)
        record.update(status="adding-leased-sut", pending="addChatMember")
        write_owned(record)
        added = request({"@type": "addChatMember", "chat_id": int(record["chatId"]),
                         "user_id": int(identity["sutBotId"]), "forward_limit": 0})
        record.update(addMemberReceipt=added, status="member-response", pending=None)
        write_owned(record)
        if added.get("@type") != "failedToAddMembers" or added.get("failed_to_add_members") != []:
            raise RuntimeError("LEASED_SUT_ADD_NOT_CONFIRMED")
        record.update(status="enabling-forum", pending="toggleSupergroupIsForum")
        write_owned(record)
        enabled = request({"@type": "toggleSupergroupIsForum", "supergroup_id": int(record["supergroupId"]),
                           "is_forum": True, "has_forum_tabs": True})
        record.update(forumReceipt=enabled, status="forum-response", pending=None)
        write_owned(record)
        if enabled.get("@type") != "ok":
            raise RuntimeError("FORUM_ENABLE_NOT_CONFIRMED")
        group = request({"@type": "getSupergroup", "supergroup_id": int(record["supergroupId"])})
        if group.get("is_channel") is not False or group.get("is_forum") is not True:
            raise RuntimeError("CREATED_GROUP_FORUM_FACTS_MISMATCH")
        record.update(status="creating-topic", pending="createForumTopic")
        write_owned(record)
        topic = request({"@type": "createForumTopic", "chat_id": int(record["chatId"]),
                         "name": record["topicTitle"], "is_name_implicit": False,
                         "icon": {"@type": "forumTopicIcon", "color": 0x6FB9F0, "custom_emoji_id": 0}})
        record.update(topicId=topic.get("forum_topic_id"), topicReceipt=topic, status="topic-returned", pending=None)
        write_owned(record)
        if topic.get("@type") != "forumTopicInfo" or type(record["topicId"]) is not int or record["topicId"] <= 0:
            record["creationUncertain"] = True
            write_owned(record)
            raise RuntimeError("CREATED_TOPIC_IDENTITY_UNCONFIRMED")
        assert_owned_creator(record, identity)
        client.check_group_write_access(int(record["chatId"]), int(identity["testerUserId"]))
        assert_bot_write(int(record["chatId"]), int(identity["sutBotId"]))
        verified = request({"@type": "getForumTopic", "chat_id": int(record["chatId"]), "forum_topic_id": record["topicId"]})
        if verified.get("info", {}).get("forum_topic_id") != record["topicId"] or verified["info"].get("name") != record["topicTitle"]:
            raise RuntimeError("CREATED_TOPIC_READBACK_MISMATCH")
        record.update(status="ready", readyAtUnixSeconds=int(time.time()))
        write_owned(record)
        return {"ok": True, "owned": True, "chatId": str(record["chatId"]), "topicId": record["topicId"]}
    except Exception as error:
        record["failure"] = {"method": getattr(error, "tdlib_method", ""),
                             "code": getattr(error, "tdlib_code", None),
                             "timedOut": bool(getattr(error, "tdlib_timed_out", False))}
        retry_after = re.search(r"(?:retry after\s+|FLOOD_WAIT_)(\d+)", getattr(error, "tdlib_message", ""), re.I)
        if retry_after:
            record["failure"]["retryAfterSeconds"] = int(retry_after.group(1))
        if record.get("pending") in ("createNewSupergroupChat", "createForumTopic"):
            record["creationUncertain"] = True
        write_owned(record)
        raise

def cleanup_owned_forum(identity):
    path = Path(spec_path).with_name("owned-forum.json")
    if not path.exists():
        if path.with_suffix(".json.next").exists():
            raise RuntimeError("OWNED_FORUM_INTENT_WRITE_UNCONFIRMED")
        if spec.get("chatId") is not None:
            raise RuntimeError("OWNED_FORUM_RECEIPT_MISSING_AFTER_PREPARATION")
        return {"ok": True, "deleted": 0, "reason": "creation-intent-never-written"}
    record = json.loads(path.read_text())
    if (record.get("runId") != spec["runId"] or record.get("testerUserId") != identity["testerUserId"]
        or record.get("sutBotId") != identity["sutBotId"]):
        raise RuntimeError("OWNED_FORUM_CLEANUP_IDENTITY_MISMATCH")
    if record.get("status") == "deleted" and record.get("deletionReceipt", {}).get("@type") == "ok":
        return {"ok": True, "deleted": 0, "groupDeleted": True, "alreadyConfirmed": True}
    if record.get("creationUncertain") or record.get("pending") in ("createNewSupergroupChat", "createForumTopic", "deleteChat"):
        raise RuntimeError("OWNED_FORUM_UNCERTAIN_OPERATION_REQUIRES_RECONCILIATION")
    chat = assert_owned_creator(record, identity)
    if chat.get("can_be_deleted_for_all_users") is not True:
        raise RuntimeError("OWNED_FORUM_DELETE_RIGHT_NOT_CONFIRMED")
    if record.get("topicId") is not None:
        topic = client.client.request({"@type": "getForumTopic", "chat_id": int(record["chatId"]),
                                       "forum_topic_id": record["topicId"]})
        if topic.get("info", {}).get("forum_topic_id") != record["topicId"] or topic["info"].get("name") != record["topicTitle"]:
            raise RuntimeError("OWNED_TOPIC_CLEANUP_IDENTITY_MISMATCH")
    record.update(status="deleting-owned-group", pending="deleteChat")
    write_owned(record)
    deleted = client.client.request({"@type": "deleteChat", "chat_id": int(record["chatId"])})
    if deleted.get("@type") != "ok":
        raise RuntimeError("OWNED_FORUM_DELETION_UNCONFIRMED")
    record.update(status="deleted", pending=None, deletionReceipt=deleted, deletedAtUnixSeconds=int(time.time()))
    write_owned(record)
    return {"ok": True, "deleted": 0, "groupDeleted": True, "topicRemovedWithGroup": record.get("topicId") is not None}

try:
    if not client.authorize(argparse.Namespace(timeout_ms=25000), need_ready=False):
        raise RuntimeError("LEASED_AUTHORIZATION_NOT_READY")
    identity = driver.group_identity(client)
    tester_id, sut_id = int(identity["testerUserId"]), int(identity["sutBotId"])
    request = client.client.request
    if mode == "prepare":
        print(json.dumps(prepare_owned_forum(identity)))
    elif mode == "cleanup" and spec.get("owned") is True:
        print(json.dumps(cleanup_owned_forum(identity)))
    elif mode == "verify":
        chat_id, topic_id = int(spec["chatId"]), int(spec["topicId"])
        chat = request({"@type": "getChat", "chat_id": chat_id})
        if chat["type"].get("@type") != "chatTypeSupergroup" or chat["type"].get("is_channel"):
            raise RuntimeError("LEASED_FORUM_NOT_SUPERGROUP")
        group = request({"@type": "getSupergroup", "supergroup_id": chat["type"]["supergroup_id"]})
        if group.get("is_forum") is not True:
            raise RuntimeError("LEASED_CHAT_NOT_FORUM")
        topic = request({"@type": "getForumTopic", "chat_id": chat_id, "forum_topic_id": topic_id})
        if topic.get("@type") != "forumTopic" or topic.get("info", {}).get("forum_topic_id") != topic_id:
            raise RuntimeError("LEASED_TOPIC_NOT_CONFIRMED")
        if topic["info"].get("is_closed") is True:
            raise RuntimeError("LEASED_TOPIC_CLOSED")
        member = request({"@type": "getChatMember", "chat_id": chat_id,
                          "member_id": {"@type": "messageSenderUser", "user_id": tester_id}})
        membership = member["status"]
        if membership.get("@type") != "chatMemberStatusCreator" and not (
            membership.get("@type") == "chatMemberStatusAdministrator"
            and membership.get("rights", {}).get("can_delete_messages") is True
        ):
            raise RuntimeError("LEASED_USER_CANNOT_CLEAN_SUT_REPLIES")
        client.check_group_write_access(chat_id, tester_id)
        assert_bot_write(chat_id, sut_id)
        print(json.dumps({"ok": True, "forumVerified": True, "topicVerified": True,
                          "cleanupPermissionVerified": True}))
    elif mode == "cleanup":
        chat_id, topic_id = int(spec["chatId"]), int(spec["topicId"])
        events_path = Path(spec["eventsPath"])
        if not events_path.exists():
            print(json.dumps({"ok": True, "deleted": 0, "reason": "recorder-never-started"}))
        else:
            summary_path = Path(spec["summaryPath"])
            if not summary_path.exists() or json.loads(summary_path.read_text()).get("recordingComplete") is not True:
                raise RuntimeError("INCOMPLETE_RECORDING_REQUIRES_RECONCILIATION")
            allowed_user = set(spec["userTexts"])
            allowed_sut = {f"TELEGRAM_BINDING_ACK_{phase}_{spec['runId']}"
                           for phase in ("PARENT", "CHILD", "BEFORE", "AFTER")}
            receipts = {}
            sut_latest = {}
            with events_path.open() as events:
                for line in events:
                    if len(line) > 4 * 1024 * 1024:
                        raise RuntimeError("OVERSIZED_EVENT_REQUIRES_INSPECTION")
                    event = json.loads(line)
                    message_id = event.get("messageId")
                    if event.get("kind") == "action" and event.get("actionType") == "send":
                        if event.get("status") != "completed" or event.get("text") not in allowed_user:
                            raise RuntimeError("UNCERTAIN_SEND_REQUIRES_RECONCILIATION")
                        receipts[message_id] = {"senderId": tester_id, "text": event["text"]}
                    elif event.get("isSut") is True and event.get("kind") in ("message", "edit"):
                        sut_latest[message_id] = event.get("text", "")
                    elif event.get("kind") == "delete" and event.get("isPermanent") is True:
                        sut_latest.pop(message_id, None)
            for message_id, text in sut_latest.items():
                if text.strip() not in allowed_sut:
                    raise RuntimeError("UNMATCHED_SUT_MESSAGE_REQUIRES_INSPECTION")
                receipts[message_id] = {"senderId": sut_id, "text": text}
            if len(receipts) > 16 or any(type(mid) is not int or mid <= 0 for mid in receipts):
                raise RuntimeError("INVALID_RUN_RECEIPTS")
            # Verify every candidate before the first deletion. The caller keeps
            # this process under the maintained scope's live-lease cancellation.
            for message_id, receipt in receipts.items():
                message = request({"@type": "getMessage", "chat_id": chat_id, "message_id": message_id})
                content = driver.message_content(message.get("content", {}))
                topic = message.get("topic_id", {})
                if (message.get("chat_id") != chat_id
                    or message.get("sender_id", {}).get("user_id") != receipt["senderId"]
                    or message.get("date", 0) < spec["notBeforeUnixSeconds"]
                    or topic.get("@type") != "messageTopicForum"
                    or topic.get("forum_topic_id") != topic_id
                    or content["text"] != receipt["text"]):
                    raise RuntimeError("RUN_RECEIPT_OWNERSHIP_MISMATCH")
                properties = request({"@type": "getMessageProperties", "chat_id": chat_id,
                                      "message_id": message_id})
                if properties.get("can_be_deleted_for_all_users") is not True:
                    raise RuntimeError("RUN_RECEIPT_NOT_DELETABLE")
            if receipts:
                result = request({"@type": "deleteMessages", "chat_id": chat_id,
                                  "message_ids": list(receipts), "revoke": True})
                if result.get("@type") != "ok":
                    raise RuntimeError("DELETE_NOT_ACCEPTED")
                pending = set(receipts)
                deadline = time.monotonic() + 30
                while pending and time.monotonic() < deadline:
                    update = client.client.next_update(timeout=0.5)
                    if (update and update.get("@type") == "updateDeleteMessages"
                        and update.get("chat_id") == chat_id
                        and update.get("is_permanent") is True and not update.get("from_cache")):
                        pending.difference_update(update.get("message_ids", []))
                if pending:
                    raise RuntimeError("PERMANENT_DELETION_NOT_OBSERVED")
                for message_id in receipts:
                    try:
                        request({"@type": "getMessage", "chat_id": chat_id, "message_id": message_id})
                    except driver.TdRequestError as error:
                        if error.tdlib_code == 404:
                            continue
                        raise
                    raise RuntimeError("DELETED_MESSAGE_STILL_READABLE")
            print(json.dumps({"ok": True, "deleted": len(receipts),
                              "permanentDeletionObserved": True, "readback404": True}))
    else:
        raise RuntimeError("UNKNOWN_PROOF_OPERATION")
finally:
    client.client.destroy()

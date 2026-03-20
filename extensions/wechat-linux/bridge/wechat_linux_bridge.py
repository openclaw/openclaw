#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Any


DEFAULT_KEY_FILE = "~/.wx_db_keys.json"
DEFAULT_OUTPUT_DIR = "~/wx_decrypted"
DEFAULT_WINDOW_CLASS = "wechat"
DEFAULT_WINDOW_MODE = "auto"
DEFAULT_HEALTH_TIMEOUT_MS = 1200
DEFAULT_DEBOUNCE_MS = 450


def expand_path(value: str | None) -> str:
    return os.path.abspath(os.path.expanduser(value or ""))


def emit_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def normalize_text(value: Any) -> str:
    return str(value or "").strip()


def resolve_bool_arg(args: argparse.Namespace, name: str, default: bool) -> bool:
    value = getattr(args, name, None)
    if value is None:
        return default
    return bool(value)


def ensure_pywxdump_importable(root: str):
    resolved_root = expand_path(root)
    tools_root = os.path.join(resolved_root, "tools")
    if not os.path.isdir(resolved_root):
        raise RuntimeError(f"pywxdump_root_missing:{resolved_root}")
    if tools_root not in sys.path:
        sys.path.insert(0, tools_root)
    if resolved_root not in sys.path:
        sys.path.insert(0, resolved_root)
    import linux_wx_chat_daemon as daemon  # type: ignore
    import linux_wx_msg_monitor as monitor  # type: ignore
    from linux_get_wx_key import find_db_storage  # type: ignore
    from linux_wx_event_watch import InotifyWatcher  # type: ignore

    return {
        "daemon": daemon,
        "monitor": monitor,
        "find_db_storage": find_db_storage,
        "InotifyWatcher": InotifyWatcher,
        "root": resolved_root,
    }


def safe_mtime(path: str) -> float:
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0.0


def discover_local_db_dirs() -> list[str]:
    home = os.path.expanduser("~")
    db_dirs: list[str] = []
    for base in (
        os.path.join(home, "Documents", "xwechat_files"),
        os.path.join(home, "xwechat_files"),
    ):
        if not os.path.isdir(base):
            continue
        for entry in os.listdir(base):
            if not entry.startswith("wxid_"):
                continue
            db_dir = os.path.join(base, entry, "db_storage")
            if os.path.isdir(db_dir):
                db_dirs.append(db_dir)
    return sorted(set(db_dirs), key=lambda path: (-safe_mtime(path), path))


def discover_live_db_dirs() -> list[str]:
    counts: dict[str, int] = {}
    try:
        result = subprocess.run(["pgrep", "-x", "wechat"], capture_output=True, text=True, check=False)
    except OSError:
        return []

    for raw_pid in result.stdout.split():
        try:
            pid = int(raw_pid)
        except ValueError:
            continue
        fd_dir = f"/proc/{pid}/fd"
        if not os.path.isdir(fd_dir):
            continue
        for fd_name in os.listdir(fd_dir):
            fd_path = os.path.join(fd_dir, fd_name)
            try:
                target = os.readlink(fd_path).replace(" (deleted)", "")
            except OSError:
                continue
            marker = "/db_storage/"
            if marker not in target or not target.endswith(".db"):
                continue
            db_dir = f"{target.split(marker, 1)[0]}{marker[:-1]}"
            counts[db_dir] = counts.get(db_dir, 0) + 1

    ordered = sorted(counts.items(), key=lambda item: (-item[1], -safe_mtime(item[0]), item[0]))
    return [path for path, _count in ordered]


def resolve_db_dir(modules: dict[str, Any], args: argparse.Namespace) -> str:
    explicit = expand_path(args.db_dir) if args.db_dir else ""
    if explicit:
        return explicit
    live_dirs = discover_live_db_dirs()
    if live_dirs:
        return expand_path(live_dirs[0])
    local_dirs = discover_local_db_dirs()
    if local_dirs:
        return expand_path(local_dirs[0])
    discovered = modules["find_db_storage"]()
    return expand_path(discovered) if discovered else ""


def load_contact_state(modules: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    monitor = modules["monitor"]
    key_file = expand_path(args.key_file or DEFAULT_KEY_FILE)
    output_dir = expand_path(args.output_dir or DEFAULT_OUTPUT_DIR)
    db_dir = resolve_db_dir(modules, args)
    if not os.path.isfile(key_file):
        raise RuntimeError(f"key_file_missing:{key_file}")
    if not db_dir:
        raise RuntimeError("db_dir_missing")
    os.makedirs(output_dir, exist_ok=True)
    keys = monitor.load_keys(key_file)
    contact_path = monitor.decrypt_single_db(keys, db_dir, "contact/contact.db", output_dir)
    if not contact_path:
        raise RuntimeError("contact_db_decrypt_failed")
    message_path = monitor.decrypt_single_db(keys, db_dir, "message/message_0.db", output_dir)
    if not message_path:
        raise RuntimeError("message_db_decrypt_failed")
    return {
        "keys": keys,
        "key_file": key_file,
        "db_dir": db_dir,
        "output_dir": output_dir,
        "contact_cache": monitor.build_contact_cache(contact_path),
        "name2id_cache": monitor.build_name2id_cache(message_path),
    }


def is_group_id(value: str) -> bool:
    return value.endswith("@chatroom")


def strip_target_prefix(raw: str) -> tuple[str, str | None]:
    target = normalize_text(raw)
    if not target:
        return "", None
    lowered = target.lower()
    for prefix in ("wechat-linux:", "wechat:"):
        if lowered.startswith(prefix):
            target = target[len(prefix) :].strip()
            lowered = target.lower()
            break
    if lowered.startswith("group:") or lowered.startswith("room:") or lowered.startswith("chat:"):
        return target.split(":", 1)[1].strip(), "group"
    if lowered.startswith("user:") or lowered.startswith("dm:") or lowered.startswith("direct:"):
        return target.split(":", 1)[1].strip(), "direct"
    return target, None


def build_contact_candidates(contact_cache: dict[str, dict[str, str]], kind: str | None):
    rows: list[dict[str, str]] = []
    for username, info in contact_cache.items():
        chat_type = "group" if is_group_id(username) else "direct"
        if kind and kind != chat_type:
            continue
        rows.append(
            {
                "chat_id": username,
                "chat_name": normalize_text(info.get("display") or info.get("nick_name") or username),
                "chat_type": chat_type,
                "remark": normalize_text(info.get("remark")),
                "nick_name": normalize_text(info.get("nick_name")),
            }
        )
    return rows


def resolve_target_noninteractive(
    input_value: str,
    contact_cache: dict[str, dict[str, str]],
    kind: str | None,
) -> dict[str, Any]:
    candidate, explicit_kind = strip_target_prefix(input_value)
    preferred_kind = explicit_kind or kind
    if not candidate:
        return {"ok": False, "input": input_value, "note": "empty target"}

    if candidate.startswith("wxid_") or candidate.startswith("gh_") or candidate.endswith("@chatroom"):
        chat_type = "group" if candidate.endswith("@chatroom") else "direct"
        if preferred_kind and preferred_kind != chat_type:
            return {"ok": False, "input": input_value, "note": "target kind mismatch"}
        info = contact_cache.get(candidate, {})
        return {
            "ok": True,
            "input": input_value,
            "chat_id": candidate,
            "chat_name": normalize_text(info.get("display") or candidate),
            "chat_type": chat_type,
        }

    normalized = candidate.casefold()
    exact: list[dict[str, str]] = []
    fuzzy: list[dict[str, str]] = []
    for row in build_contact_candidates(contact_cache, preferred_kind):
        search_fields = [row["chat_name"], row["remark"], row["nick_name"], row["chat_id"]]
        lowered_fields = [item.casefold() for item in search_fields if item]
        if normalized in lowered_fields:
            exact.append(row)
            continue
        if any(normalized in item for item in lowered_fields):
            fuzzy.append(row)

    matches = exact or fuzzy
    if not matches:
        return {"ok": False, "input": input_value, "note": "target not found"}
    if len(matches) > 1:
        options = ", ".join(f"{item['chat_name']}<{item['chat_id']}>" for item in matches[:6])
        return {
            "ok": False,
            "input": input_value,
            "note": f"ambiguous target: {options}",
        }
    match = matches[0]
    return {
        "ok": True,
        "input": input_value,
        "chat_id": match["chat_id"],
        "chat_name": match["chat_name"],
        "chat_type": match["chat_type"],
    }


def guess_content_type(path: str) -> str | None:
    content_type, _ = mimetypes.guess_type(path)
    return content_type or None


@dataclass
class PlainFileEntry:
    path: str
    mtime: float


class PlainFileLocator:
    def __init__(self, wx_root: str):
        self.root = os.path.join(wx_root, "msg", "file")
        self._built = False
        self._index: dict[str, list[PlainFileEntry]] = {}

    def _build(self) -> None:
        if self._built:
            return
        self._built = True
        if not os.path.isdir(self.root):
            return
        for current_root, _dirs, files in os.walk(self.root):
            for name in files:
                file_path = os.path.join(current_root, name)
                try:
                    mtime = os.path.getmtime(file_path)
                except OSError:
                    continue
                key = name.casefold()
                self._index.setdefault(key, []).append(PlainFileEntry(file_path, mtime))
        for entries in self._index.values():
            entries.sort(key=lambda item: item.mtime, reverse=True)

    def find(self, file_name: str, timestamp: int | None) -> str:
        normalized = normalize_text(file_name)
        if not normalized:
            return ""
        self._build()
        entries = self._index.get(normalized.casefold()) or []
        if not entries:
            return ""
        if timestamp is None:
            return entries[0].path
        best = min(entries, key=lambda item: abs(item.mtime - float(timestamp)))
        return best.path


def resolve_sender_identity(
    decoded_content: str,
    is_chatroom: bool,
    real_sender_id: int,
    name2id_cache: dict[int, str],
    contact_cache: dict[str, dict[str, str]],
    context_chat_id: str,
) -> tuple[str, str, str, str]:
    body = normalize_text(decoded_content)
    sender_id = ""
    sender_display = ""
    sender_username = ""

    def from_rowid(rowid: int) -> tuple[str, str]:
        username = normalize_text(name2id_cache.get(rowid))
        info = contact_cache.get(username, {})
        display = normalize_text(info.get("display") or username)
        return username, display

    if is_chatroom:
        if ":\n" in body:
            raw_sender, _, body = body.partition(":\n")
            sender_id = normalize_text(raw_sender)
            sender_username = sender_id
            info = contact_cache.get(sender_id, {})
            sender_display = normalize_text(info.get("display") or sender_id)
        else:
            sender_username, sender_display = from_rowid(real_sender_id)
            sender_id = sender_username or f"rowid:{real_sender_id}"
    else:
        sender_username, sender_display = from_rowid(real_sender_id)
        sender_id = sender_username or context_chat_id
        if not sender_display:
            sender_display = sender_id

    return sender_id, sender_username, sender_display, body.strip()


def choose_readable_path(paths: list[str]) -> list[str]:
    seen: set[str] = set()
    resolved: list[str] = []
    for item in paths:
        path = normalize_text(item)
        if not path:
            continue
        if not os.path.isfile(path):
            continue
        real = os.path.abspath(path)
        if real in seen:
            continue
        seen.add(real)
        resolved.append(real)
    return resolved


def collect_media_artifacts(
    message: dict[str, Any],
    locator: PlainFileLocator,
) -> tuple[list[str], list[str]]:
    details = message.get("details") or {}
    artifacts = message.get("artifacts") or {}
    base_type = message.get("base_type")
    timestamp = message.get("timestamp")

    candidate_paths: list[str] = []
    if base_type == 3:
        candidate_paths.extend(
            [
                artifacts.get("analysis_path") or "",
                artifacts.get("original_path") or "",
                artifacts.get("image_utils_path") or "",
                artifacts.get("thumb_path") or "",
                artifacts.get("temp_path") or "",
            ]
        )
    elif base_type == 43:
        candidate_paths.extend([artifacts.get("video_path") or "", artifacts.get("thumb_path") or ""])
    elif base_type == 34:
        candidate_paths.extend([artifacts.get("wav_path") or "", artifacts.get("raw_silk_path") or ""])
    elif message.get("normalized_kind") == "file_manifest":
        file_title = normalize_text(details.get("title"))
        located = locator.find(file_title, int(timestamp) if timestamp else None)
        if located:
            candidate_paths.append(located)

    media_paths = choose_readable_path(candidate_paths)
    media_types = [guess_content_type(item) or "application/octet-stream" for item in media_paths]
    return media_paths, media_types


def normalize_bridge_message(
    wx_monitor: Any,
    row: tuple[Any, ...],
    context: dict[str, Any],
    file_locator: PlainFileLocator,
    self_sender_ids: set[str],
    monitor_module: Any,
) -> dict[str, Any] | None:
    parsed = wx_monitor.parse_message_with_context(row, context)
    return normalize_bridge_message_from_parsed(
        wx_monitor,
        row,
        context,
        parsed,
        file_locator,
        self_sender_ids,
        monitor_module,
    )


def normalize_bridge_message_from_parsed(
    wx_monitor: Any,
    row: tuple[Any, ...],
    context: dict[str, Any],
    parsed: dict[str, Any],
    file_locator: PlainFileLocator,
    self_sender_ids: set[str],
    monitor_module: Any,
) -> dict[str, Any] | None:
    (
        local_id,
        server_id,
        _local_type,
        real_sender_id,
        _create_time,
        message_content,
        _packed_info_data,
        ct_flag,
    ) = row
    decoded_content = monitor_module.decode_message_content(message_content, ct_flag)
    sender_id, sender_username, sender_display, stripped_body = resolve_sender_identity(
        decoded_content,
        bool(context["is_chatroom"]),
        int(real_sender_id),
        wx_monitor.name2id_cache,
        wx_monitor.contact_cache,
        context["target_username"],
    )
    parsed_content = normalize_text(parsed.get("content"))
    if stripped_body:
        # Preserve PyWxDump's parsed summaries/transcripts for XML-backed media and app messages.
        if not (parsed_content and stripped_body.lstrip().startswith("<")):
            parsed["content"] = stripped_body
        elif parsed_content:
            parsed["content"] = parsed_content
    elif parsed_content:
        parsed["content"] = parsed_content
    else:
        parsed["content"] = ""
    media_paths, media_types = collect_media_artifacts(parsed, file_locator)

    chat_type = "group" if context["is_chatroom"] else "direct"
    is_self = False
    if chat_type == "direct":
        if sender_id and sender_id != context["target_username"]:
            self_sender_ids.add(sender_id)
            is_self = True
    elif sender_id in self_sender_ids:
        is_self = True

    return {
        "local_id": int(local_id),
        "server_id": normalize_text(server_id),
        "timestamp": int(parsed.get("timestamp") or 0),
        "time": parsed.get("time") or "",
        "base_type": parsed.get("base_type"),
        "sub_type": parsed.get("sub_type"),
        "chat_id": context["target_username"],
        "chat_name": context["target_display"],
        "chat_type": chat_type,
        "sender_id": sender_id,
        "sender_username": sender_username or None,
        "sender_display": sender_display or sender_id or context["target_display"],
        "content": normalize_text(parsed.get("content")),
        "analysis_text": normalize_text(parsed.get("analysis_text")),
        "normalized_kind": normalize_text(parsed.get("normalized_kind") or "unsupported"),
        "type_label": normalize_text(parsed.get("type_label")),
        "details": parsed.get("details") or {},
        "artifacts": parsed.get("artifacts") or {},
        "document": parsed.get("document") or {},
        "raw_xml": normalize_text(parsed.get("raw_xml")),
        "url_list": list(parsed.get("url_list") or []),
        "media_paths": media_paths,
        "media_types": media_types,
        "is_self": is_self,
    }


def default_doc_domains_csv(monitor_module: Any) -> str:
    return ",".join(getattr(monitor_module, "DEFAULT_DOC_DOMAINS", ("mp.weixin.qq.com",)))


def build_default_link_hook_command(modules: dict[str, Any]) -> str:
    hook_path = os.path.join(modules["root"], "tools", "link_doc_hook.py")
    return f"{shlex.quote(sys.executable)} {shlex.quote(hook_path)}"


def build_daemon_args(
    modules: dict[str, Any],
    args: argparse.Namespace,
    *,
    target: str,
    all_chats: bool = False,
) -> argparse.Namespace:
    daemon = modules["daemon"]
    monitor = modules["monitor"]
    image_analysis = resolve_bool_arg(args, "image_analysis", True)
    video_analysis = resolve_bool_arg(args, "video_analysis", True)
    voice_asr = resolve_bool_arg(args, "voice_asr", True)
    link_docs = resolve_bool_arg(args, "link_docs", True)
    return argparse.Namespace(
        command="watch" if all_chats else "send",
        target=target,
        auto_resolve_target=True,
        key_file=expand_path(args.key_file or DEFAULT_KEY_FILE),
        db_dir=resolve_db_dir(modules, args),
        output=expand_path(args.output_dir or DEFAULT_OUTPUT_DIR),
        interval=30,
        format="json",
        webhook=None,
        ollama_url=normalize_text(args.vision_base_url) or monitor.DEFAULT_OPENAI_BASE_URL,
        vision_model=normalize_text(args.vision_model) or monitor.DEFAULT_OPENAI_MODEL,
        vision_api_key_env=normalize_text(args.vision_api_key_env)
        or monitor.DEFAULT_OPENAI_API_KEY_ENV,
        summary_base_url=normalize_text(args.summary_base_url)
        or normalize_text(args.vision_base_url)
        or monitor.DEFAULT_OPENAI_BASE_URL,
        summary_model=normalize_text(args.summary_model)
        or normalize_text(args.vision_model)
        or monitor.DEFAULT_OPENAI_MODEL,
        summary_api_key_env=normalize_text(args.summary_api_key_env)
        or normalize_text(args.vision_api_key_env)
        or monitor.DEFAULT_OPENAI_API_KEY_ENV,
        asr_url=normalize_text(args.asr_url) or "http://localhost:8001/api/asr/transcribe",
        no_image_analysis=not image_analysis,
        no_video_analysis=not video_analysis,
        video_frame_count=1,
        no_voice_asr=not voice_asr,
        link_hook_cmd=normalize_text(args.link_hook_cmd) or build_default_link_hook_command(modules),
        link_doc_root=normalize_text(args.link_doc_root),
        link_domains=normalize_text(args.link_domains) or default_doc_domains_csv(monitor),
        link_hook_timeout=max(1, int(getattr(args, "link_hook_timeout_sec", 30) or 30)),
        no_link_docs=not link_docs,
        all_chats=all_chats,
        allow_missing_msg_table=False,
        display=normalize_text(args.display or os.environ.get("DISPLAY")),
        xauthority=normalize_text(args.xauthority or os.environ.get("XAUTHORITY")),
        window_class=normalize_text(args.window_class) or DEFAULT_WINDOW_CLASS,
        window_mode=normalize_text(args.window_mode) or DEFAULT_WINDOW_MODE,
        send_diagnostics_path=getattr(daemon, "default_send_diagnostics_path")(),
        send_step_delay_ms=getattr(daemon, "DEFAULT_SEND_STEP_DELAY_MS", 180),
        send_paste_settle_ms=getattr(daemon, "DEFAULT_SEND_PASTE_SETTLE_MS", 280),
        send_gui_countdown_seconds=0,
        send_gui_notify_timeout_ms=1000,
        no_send_gui_prompts=True,
        post_send_delay_ms=1200,
        send_timeout=30,
        allow_active_main_window=False,
        force_focus_main_window=False,
        main_window_vision_base_url=getattr(daemon, "DEFAULT_MAIN_WINDOW_VISION_BASE_URL", ""),
        main_window_vision_model=getattr(daemon, "DEFAULT_MAIN_WINDOW_VISION_MODEL", ""),
        main_window_vision_api_key_env=monitor.DEFAULT_OPENAI_API_KEY_ENV,
        main_window_vision_confidence=getattr(daemon, "DEFAULT_MAIN_WINDOW_VISION_CONFIDENCE", 0.55),
        main_window_vision_timeout_seconds=getattr(daemon, "DEFAULT_MAIN_WINDOW_VISION_TIMEOUT_SECONDS", 90),
        main_window_vision_thinking_budget_tokens=getattr(
            daemon,
            "DEFAULT_MAIN_WINDOW_VISION_THINKING_BUDGET_TOKENS",
            1024,
        ),
        main_window_vision_disable_thinking=False,
        main_window_warm_state_path=getattr(daemon, "default_main_window_warm_state_path")(),
    )


def apply_runtime_feature_overrides(
    wx_monitor: Any,
    args: argparse.Namespace,
    monitor_module: Any,
    *,
    enable_link_docs: bool,
) -> None:
    wx_monitor.image_analysis = resolve_bool_arg(args, "image_analysis", True)
    wx_monitor.video_analysis = resolve_bool_arg(args, "video_analysis", True)
    wx_monitor.voice_asr = resolve_bool_arg(args, "voice_asr", True)
    wx_monitor.doc_enabled = resolve_bool_arg(args, "link_docs", True) and enable_link_docs
    if normalize_text(getattr(args, "vision_base_url", "")):
        wx_monitor.ollama_url = normalize_text(args.vision_base_url)
    if normalize_text(getattr(args, "vision_model", "")):
        wx_monitor.vision_model = normalize_text(args.vision_model)
    if normalize_text(getattr(args, "vision_api_key_env", "")):
        wx_monitor.vision_api_key_env = normalize_text(args.vision_api_key_env)
    if normalize_text(getattr(args, "summary_base_url", "")):
        wx_monitor.summary_base_url = normalize_text(args.summary_base_url)
    if normalize_text(getattr(args, "summary_model", "")):
        wx_monitor.summary_model = normalize_text(args.summary_model)
    if normalize_text(getattr(args, "summary_api_key_env", "")):
        wx_monitor.summary_api_key_env = normalize_text(args.summary_api_key_env)
    if normalize_text(getattr(args, "asr_url", "")):
        wx_monitor.asr_url = normalize_text(args.asr_url)
    if normalize_text(getattr(args, "link_hook_cmd", "")):
        wx_monitor.doc_hook_cmd = normalize_text(args.link_hook_cmd)
    if normalize_text(getattr(args, "link_doc_root", "")):
        wx_monitor.doc_root = normalize_text(args.link_doc_root)
    if normalize_text(getattr(args, "link_domains", "")):
        wx_monitor.doc_domains = monitor_module.parse_doc_domains(normalize_text(args.link_domains))
    wx_monitor.doc_hook_timeout = max(1, int(getattr(args, "link_hook_timeout_sec", 30) or 30))


def build_all_chat_monitor(
    modules: dict[str, Any],
    args: argparse.Namespace,
    *,
    enable_link_docs: bool,
) -> Any:
    daemon = modules["daemon"]
    watch_args = build_daemon_args(modules, args, target="*", all_chats=True)
    wx_monitor = daemon.build_monitor(watch_args, doc_enabled=enable_link_docs)
    daemon.setup_monitor(wx_monitor, announce=False)
    apply_runtime_feature_overrides(
        wx_monitor,
        args,
        modules["monitor"],
        enable_link_docs=enable_link_docs,
    )
    return wx_monitor


def probe_command(args: argparse.Namespace) -> int:
    try:
        modules = ensure_pywxdump_importable(args.pywxdump_root)
        db_dir = resolve_db_dir(modules, args)
        output_dir = expand_path(args.output_dir or DEFAULT_OUTPUT_DIR)
        emit_json(
            {
                "ok": True,
                "python_path": sys.executable,
                "pywxdump_root": modules["root"],
                "pywxdump_exists": True,
                "bridge_path": os.path.abspath(__file__),
                "key_file": expand_path(args.key_file or DEFAULT_KEY_FILE),
                "key_file_exists": os.path.isfile(expand_path(args.key_file or DEFAULT_KEY_FILE)),
                "db_dir": db_dir or None,
                "db_dir_exists": bool(db_dir and os.path.isdir(db_dir)),
                "output_dir": output_dir,
                "output_dir_exists": os.path.isdir(output_dir),
                "display": normalize_text(args.display or os.environ.get("DISPLAY")) or None,
                "xauthority": normalize_text(args.xauthority or os.environ.get("XAUTHORITY")) or None,
                "xdotool_exists": shutil.which("xdotool") is not None,
                "wechat_process_count": len(modules["daemon"].list_wechat_processes()),
                "window_class": normalize_text(args.window_class) or DEFAULT_WINDOW_CLASS,
                "window_mode": normalize_text(args.window_mode) or DEFAULT_WINDOW_MODE,
                "image_analysis": resolve_bool_arg(args, "image_analysis", True),
                "video_analysis": resolve_bool_arg(args, "video_analysis", True),
                "voice_asr": resolve_bool_arg(args, "voice_asr", True),
                "link_docs": resolve_bool_arg(args, "link_docs", True),
            }
        )
    except Exception as exc:  # noqa: BLE001
        emit_json(
            {
                "ok": False,
                "python_path": sys.executable,
                "pywxdump_root": expand_path(args.pywxdump_root),
                "pywxdump_exists": os.path.isdir(expand_path(args.pywxdump_root)),
                "bridge_path": os.path.abspath(__file__),
                "key_file": expand_path(args.key_file or DEFAULT_KEY_FILE),
                "key_file_exists": os.path.isfile(expand_path(args.key_file or DEFAULT_KEY_FILE)),
                "db_dir": expand_path(args.db_dir) if args.db_dir else None,
                "db_dir_exists": bool(args.db_dir and os.path.isdir(expand_path(args.db_dir))),
                "output_dir": expand_path(args.output_dir or DEFAULT_OUTPUT_DIR),
                "output_dir_exists": os.path.isdir(expand_path(args.output_dir or DEFAULT_OUTPUT_DIR)),
                "display": normalize_text(args.display or os.environ.get("DISPLAY")) or None,
                "xauthority": normalize_text(args.xauthority or os.environ.get("XAUTHORITY")) or None,
                "xdotool_exists": shutil.which("xdotool") is not None,
                "wechat_process_count": 0,
                "window_class": normalize_text(args.window_class) or DEFAULT_WINDOW_CLASS,
                "window_mode": normalize_text(args.window_mode) or DEFAULT_WINDOW_MODE,
                "image_analysis": resolve_bool_arg(args, "image_analysis", True),
                "video_analysis": resolve_bool_arg(args, "video_analysis", True),
                "voice_asr": resolve_bool_arg(args, "voice_asr", True),
                "link_docs": resolve_bool_arg(args, "link_docs", True),
                "error": str(exc),
            }
        )
    return 0


def resolve_target_command(args: argparse.Namespace) -> int:
    modules = ensure_pywxdump_importable(args.pywxdump_root)
    state = load_contact_state(modules, args)
    result = resolve_target_noninteractive(args.input, state["contact_cache"], args.kind)
    emit_json(result)
    return 0


def send_text_command(args: argparse.Namespace) -> int:
    modules = ensure_pywxdump_importable(args.pywxdump_root)
    daemon = modules["daemon"]
    target_args = build_daemon_args(modules, args, target=args.chat_id, all_chats=False)
    wx_monitor = daemon.build_monitor(target_args, doc_enabled=False)
    daemon.setup_monitor(wx_monitor, announce=False)
    session = daemon.resolve_chat_window_session(target_args, wx_monitor, purpose="send")
    result = daemon.send_text_via_session(
        target_args,
        wx_monitor,
        session,
        args.text,
        origin="openclaw_wechat_linux_bridge",
    )
    result["chat_id"] = wx_monitor.target_username
    emit_json(result)
    return 0 if result.get("status") == "ok" else 1


def send_file_like_command(args: argparse.Namespace, image: bool) -> int:
    modules = ensure_pywxdump_importable(args.pywxdump_root)
    daemon = modules["daemon"]
    target_args = build_daemon_args(modules, args, target=args.chat_id, all_chats=False)
    wx_monitor = daemon.build_monitor(target_args, doc_enabled=False)
    daemon.setup_monitor(wx_monitor, announce=False)
    session = daemon.resolve_chat_window_session(target_args, wx_monitor, purpose="send")
    result = daemon.send_file_via_session(
        target_args,
        wx_monitor,
        session,
        args.path,
        "image" if image else "file",
        origin="openclaw_wechat_linux_bridge",
    )
    result["chat_id"] = wx_monitor.target_username
    emit_json(result)
    return 0 if result.get("status") == "ok" else 1


def fetch_new_messages(
    modules: dict[str, Any],
    wx_monitor: Any,
    file_locator: PlainFileLocator,
    self_sender_ids: set[str],
) -> list[dict[str, Any]]:
    monitor = modules["monitor"]
    with tempfile.TemporaryDirectory(prefix="openclaw_wechat_watch_", dir=wx_monitor.output_dir) as snapshot_dir:
        msg_path = monitor.decrypt_single_db(
            wx_monitor.keys,
            wx_monitor.db_storage,
            "message/message_0.db",
            snapshot_dir,
        )
        if not msg_path:
            return []
        wx_monitor.name2id_cache = monitor.build_name2id_cache(msg_path)
        parsed: list[tuple[int, int, dict[str, Any]]] = []
        for table, state in wx_monitor.chat_states.items():
            rows = wx_monitor.query_message_rows(msg_path, table, after_local_id=state["last_local_id"])
            if not rows:
                continue
            state["last_local_id"] = rows[-1][0]
            for row in rows:
                parsed_message = wx_monitor.parse_message_with_context(row, state)
                if wx_monitor.doc_enabled:
                    wx_monitor.maybe_generate_doc(parsed_message)
                bridge_message = normalize_bridge_message_from_parsed(
                    wx_monitor,
                    row,
                    state,
                    parsed_message,
                    file_locator,
                    self_sender_ids,
                    monitor,
                )
                if bridge_message is None:
                    continue
                parsed.append((bridge_message["timestamp"], bridge_message["local_id"], bridge_message))
        parsed.sort(key=lambda item: (item[0], item[1]))
        return [item[2] for item in parsed]


def append_search_text(parts: list[str], value: Any) -> None:
    if value is None:
        return
    if isinstance(value, (str, int, float, bool)):
        text = normalize_text(value)
        if text:
            parts.append(text)
        return
    if isinstance(value, dict):
        for item in value.values():
            append_search_text(parts, item)
        return
    if isinstance(value, (list, tuple, set)):
        for item in value:
            append_search_text(parts, item)


def build_message_search_haystack(message: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in (
        "chat_name",
        "sender_display",
        "sender_id",
        "content",
        "analysis_text",
        "type_label",
        "normalized_kind",
        "raw_xml",
    ):
        append_search_text(parts, message.get(key))
    append_search_text(parts, message.get("url_list") or [])
    append_search_text(parts, message.get("details") or {})
    append_search_text(parts, message.get("document") or {})
    append_search_text(parts, message.get("artifacts") or {})
    append_search_text(parts, message.get("media_paths") or [])
    return "\n".join(dict.fromkeys(part for part in parts if part)).casefold()


def message_matches_search_kind(message: dict[str, Any], search_kind: str) -> bool:
    normalized_kind = normalize_text(message.get("normalized_kind"))
    media_types = [normalize_text(item).lower() for item in message.get("media_types") or []]
    artifacts = message.get("artifacts") or {}

    if search_kind == "file":
        return normalized_kind == "file_manifest"
    if search_kind == "image":
        if int(message.get("base_type") or 0) == 3:
            return True
        if any(item.startswith("image/") for item in media_types):
            return True
        return any(
            normalize_text(artifacts.get(key))
            for key in ("analysis_path", "original_path", "image_utils_path", "thumb_path")
        )
    return normalized_kind != "skip"


def filter_search_message(message: dict[str, Any], search_kind: str, query: str) -> bool:
    if not message_matches_search_kind(message, search_kind):
        return False
    if not query:
        return True
    return query.casefold() in build_message_search_haystack(message)


def search_history_command(args: argparse.Namespace) -> int:
    modules = ensure_pywxdump_importable(args.pywxdump_root)
    monitor = modules["monitor"]
    wx_monitor = build_all_chat_monitor(modules, args, enable_link_docs=False)
    wx_monitor.doc_enabled = False
    if args.search_kind != "image":
        wx_monitor.image_analysis = False
        wx_monitor.video_analysis = False
    if args.search_kind != "message":
        wx_monitor.voice_asr = False
    file_locator = PlainFileLocator(wx_monitor.wx_root)
    self_sender_ids: set[str] = set()
    query = normalize_text(args.query)
    limit = max(1, min(20, int(args.limit or 5)))
    scan_limit = max(limit, min(5000, int(args.scan_limit or 400)))

    with tempfile.TemporaryDirectory(prefix="openclaw_wechat_search_", dir=wx_monitor.output_dir) as snapshot_dir:
        msg_path = monitor.decrypt_single_db(
            wx_monitor.keys,
            wx_monitor.db_storage,
            "message/message_0.db",
            snapshot_dir,
        )
        if not msg_path:
            raise RuntimeError("message_db_decrypt_failed")
        wx_monitor.name2id_cache = monitor.build_name2id_cache(msg_path)

        states = list(wx_monitor.chat_states.items())
        if args.chat_id:
            states = [
                (table, state)
                for table, state in states
                if normalize_text(state.get("target_username")) == normalize_text(args.chat_id)
            ]

        if not states:
            emit_json(
                {
                    "ok": True,
                    "search_kind": args.search_kind,
                    "query": query,
                    "chat_id": normalize_text(args.chat_id) or None,
                    "chat_name": None,
                    "scanned": 0,
                    "total": 0,
                    "matches": [],
                    "note": "chat not found" if args.chat_id else "no chats available",
                }
            )
            return 0

        matches: list[dict[str, Any]] = []
        scanned = 0
        for table, state in states:
            rows = wx_monitor.query_message_rows(msg_path, table, limit=scan_limit)
            for row in rows:
                scanned += 1
                parsed = wx_monitor.parse_message_with_context(row, state)
                bridge_message = normalize_bridge_message_from_parsed(
                    wx_monitor,
                    row,
                    state,
                    parsed,
                    file_locator,
                    self_sender_ids,
                    monitor,
                )
                if bridge_message is None:
                    continue
                if not filter_search_message(bridge_message, args.search_kind, query):
                    continue
                matches.append(bridge_message)

        matches.sort(
            key=lambda item: (int(item.get("timestamp") or 0), int(item.get("local_id") or 0)),
            reverse=True,
        )
        limited = matches[:limit]
        chat_name = states[0][1].get("target_display") if args.chat_id and states else None
        emit_json(
            {
                "ok": True,
                "search_kind": args.search_kind,
                "query": query,
                "chat_id": normalize_text(args.chat_id) or None,
                "chat_name": normalize_text(chat_name) or None,
                "scanned": scanned,
                "total": len(matches),
                "matches": limited,
            }
        )
    return 0


def is_relevant_message_change(path: str) -> bool:
    normalized = path.replace("\\", "/")
    if normalized.endswith("/message"):
        return True
    base = os.path.basename(normalized)
    return base.startswith("message_0.db")


def watch_command(args: argparse.Namespace) -> int:
    modules = ensure_pywxdump_importable(args.pywxdump_root)
    watcher_cls = modules["InotifyWatcher"]
    wx_monitor = build_all_chat_monitor(modules, args, enable_link_docs=True)
    file_locator = PlainFileLocator(wx_monitor.wx_root)
    self_sender_ids: set[str] = set()

    emit_json({"type": "ready", "chat_count": len(wx_monitor.chat_states)})

    watch_paths = [os.path.join(wx_monitor.db_storage, "message")]
    with watcher_cls(watch_paths) as watcher:
        while True:
            changed = watcher.wait(timeout_ms=int(args.health_timeout_ms))
            if not changed:
                continue
            relevant = [path for path in changed if is_relevant_message_change(path)]
            if not relevant:
                continue
            time.sleep(max(0, int(args.debounce_ms)) / 1000.0)
            for message in fetch_new_messages(modules, wx_monitor, file_locator, self_sender_ids):
                emit_json({"type": "message", "message": message})

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenClaw WeChat Linux bridge")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument("--pywxdump-root", required=True)
        subparser.add_argument("--key-file", default=DEFAULT_KEY_FILE)
        subparser.add_argument("--db-dir")
        subparser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR)
        subparser.add_argument("--display")
        subparser.add_argument("--xauthority")
        subparser.add_argument("--window-class", default=DEFAULT_WINDOW_CLASS)
        subparser.add_argument("--window-mode", default=DEFAULT_WINDOW_MODE)
        subparser.add_argument("--image-analysis", dest="image_analysis", action="store_true", default=None)
        subparser.add_argument("--no-image-analysis", dest="image_analysis", action="store_false")
        subparser.add_argument("--video-analysis", dest="video_analysis", action="store_true", default=None)
        subparser.add_argument("--no-video-analysis", dest="video_analysis", action="store_false")
        subparser.add_argument("--voice-asr", dest="voice_asr", action="store_true", default=None)
        subparser.add_argument("--no-voice-asr", dest="voice_asr", action="store_false")
        subparser.add_argument("--link-docs", dest="link_docs", action="store_true", default=None)
        subparser.add_argument("--no-link-docs", dest="link_docs", action="store_false")
        subparser.add_argument("--vision-base-url")
        subparser.add_argument("--vision-model")
        subparser.add_argument("--vision-api-key-env")
        subparser.add_argument("--summary-base-url")
        subparser.add_argument("--summary-model")
        subparser.add_argument("--summary-api-key-env")
        subparser.add_argument("--asr-url")
        subparser.add_argument("--link-hook-cmd")
        subparser.add_argument("--link-doc-root")
        subparser.add_argument("--link-domains")
        subparser.add_argument("--link-hook-timeout-sec", type=int, default=30)

    probe = sub.add_parser("probe")
    add_common(probe)

    resolve_target = sub.add_parser("resolve-target")
    add_common(resolve_target)
    resolve_target.add_argument("--input", required=True)
    resolve_target.add_argument("--kind", choices=["direct", "group"], default=None)

    watch = sub.add_parser("watch")
    add_common(watch)
    watch.add_argument("--health-timeout-ms", type=int, default=DEFAULT_HEALTH_TIMEOUT_MS)
    watch.add_argument("--debounce-ms", type=int, default=DEFAULT_DEBOUNCE_MS)

    send_text = sub.add_parser("send-text")
    add_common(send_text)
    send_text.add_argument("--chat-id", required=True)
    send_text.add_argument("--text", required=True)

    send_file = sub.add_parser("send-file")
    add_common(send_file)
    send_file.add_argument("--chat-id", required=True)
    send_file.add_argument("--path", required=True)

    send_image = sub.add_parser("send-image")
    add_common(send_image)
    send_image.add_argument("--chat-id", required=True)
    send_image.add_argument("--path", required=True)

    search_history = sub.add_parser("search-history")
    add_common(search_history)
    search_history.add_argument("--search-kind", choices=["message", "file", "image"], required=True)
    search_history.add_argument("--query", default="")
    search_history.add_argument("--chat-id")
    search_history.add_argument("--limit", type=int, default=5)
    search_history.add_argument("--scan-limit", type=int, default=400)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        if args.command == "probe":
            return probe_command(args)
        if args.command == "resolve-target":
            return resolve_target_command(args)
        if args.command == "watch":
            return watch_command(args)
        if args.command == "send-text":
            return send_text_command(args)
        if args.command == "send-file":
            return send_file_like_command(args, image=False)
        if args.command == "send-image":
            return send_file_like_command(args, image=True)
        if args.command == "search-history":
            return search_history_command(args)
        raise RuntimeError(f"unknown command: {args.command}")
    except Exception as exc:  # noqa: BLE001
        if args.command == "resolve-target":
            emit_json({"ok": False, "input": getattr(args, "input", ""), "note": str(exc)})
            return 0
        if args.command == "probe":
            emit_json({"ok": False, "error": str(exc)})
            return 0
        if args.command == "send-text":
            emit_json(
                {
                    "status": "error",
                    "target": getattr(args, "chat_id", ""),
                    "send_kind": "text",
                    "error": str(exc),
                }
            )
            return 1
        if args.command == "send-file":
            emit_json(
                {
                    "status": "error",
                    "target": getattr(args, "chat_id", ""),
                    "send_kind": "file",
                    "error": str(exc),
                }
            )
            return 1
        if args.command == "send-image":
            emit_json(
                {
                    "status": "error",
                    "target": getattr(args, "chat_id", ""),
                    "send_kind": "image",
                    "error": str(exc),
                }
            )
            return 1
        if args.command == "search-history":
            emit_json(
                {
                    "ok": False,
                    "search_kind": getattr(args, "search_kind", "message"),
                    "query": normalize_text(getattr(args, "query", "")),
                    "chat_id": normalize_text(getattr(args, "chat_id", "")) or None,
                    "chat_name": None,
                    "scanned": 0,
                    "total": 0,
                    "matches": [],
                    "note": str(exc),
                }
            )
            return 0
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)

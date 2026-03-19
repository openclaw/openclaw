#!/usr/bin/env python3
"""Sentinel — autonomous daemon for 無極 system.

v2: Level-triggered reconciliation — Observe → Diff → Act.
"""
import argparse
import importlib
import json
import os
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime, date, timedelta
from pathlib import Path

import schedule
import yaml

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from lib.logging_util import setup_logger, log_event
from lib.telegram import TelegramBridge
from lib.reconciler import (
    observe_all, execute_repair, compute_backoff, deep_probe,
    read_stderr_tail, diagnose_config_error, repair_config_keys,
    FLAP_THRESHOLD, FLAP_WINDOW_SEC,
)
from lib.config_guard import (
    observe_configs, snapshot_checksums, validate_config,
    backup_config, rollback_config,
)

STATE_FILE = BASE / "state.json"
CONFIG_FILE = BASE / "sentinel.yaml"
CONFIG_BACKUPS = BASE / "config_backups"
BULLETIN_SCRIPT = BASE.parent / "workspace" / "scripts" / "bulletin"
JARVIS_SCRIPT = BASE.parent / "workspace" / "scripts" / "jarvis-status"


class Sentinel:
    def __init__(self, config_path=None):
        self.config = self._load_config(config_path or CONFIG_FILE)
        self.state = self._load_state()
        self.logger = setup_logger("sentinel")
        self.telegram = TelegramBridge(
            self.config["notifications"]["telegram_bridge"]
        )
        self.running = True
        self._today = date.today().isoformat()
        signal.signal(signal.SIGTERM, self._shutdown)
        signal.signal(signal.SIGINT, self._shutdown)

    def _load_config(self, path):
        with open(path) as f:
            return yaml.safe_load(f)

    def _load_state(self):
        if STATE_FILE.exists():
            try:
                with open(STATE_FILE) as f:
                    state = json.load(f)
            except (json.JSONDecodeError, ValueError) as e:
                # Corrupt state file — back up and start fresh
                backup = STATE_FILE.with_suffix(f".corrupt.{int(time.time())}.json")
                STATE_FILE.rename(backup)
                state = {}
                # Log will be set up after this, so use stderr
                print(f"WARNING: state.json corrupt ({e}), backed up to {backup.name}", file=sys.stderr)
        else:
            state = {}
        # Ensure sentinel fields exist
        state.setdefault("sentinel", {
            "started_at": None,
            "last_task": None,
            "task_runs": {},
            "daily_api_calls": 0,
            "api_calls_date": None,
        })
        return state

    def _save_state(self):
        tmp = STATE_FILE.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(self.state, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        tmp.rename(STATE_FILE)

    def _shutdown(self, signum, frame):
        self.logger.info(f"Received signal {signum}, shutting down...")
        self.running = False
        self._save_state()

    def _is_quiet_hours(self):
        qh = self.config["notifications"].get("quiet_hours", [])
        if len(qh) != 2:
            return False
        now = datetime.now().strftime("%H:%M")
        return qh[0] <= now < qh[1]

    def _notify(self, text):
        """Send notification to Cruz via Telegram (respects quiet hours for non-P0)."""
        chat_id = self.config["notifications"]["cruz_chat_id"]
        try:
            self.telegram.send(text, chat_id)
        except Exception as e:
            self.logger.error(f"Telegram notify failed: {e}")

    def _bulletin_alert(self, msg):
        """Write alert to bulletin board."""
        try:
            import subprocess
            subprocess.run(
                ["python3", str(BULLETIN_SCRIPT), "alert", msg],
                timeout=10, capture_output=True
            )
        except Exception as e:
            self.logger.error(f"Bulletin alert failed: {e}")

    def _notify_startup(self):
        """Notify Cruz on startup/restart."""
        prev_start = self.state.get("sentinel", {}).get("started_at")
        now_str = datetime.now().strftime("%H:%M")
        is_restart = prev_start is not None

        if is_restart:
            msg = f"[Sentinel] 重啟完成 ({now_str})\n前次啟動: {prev_start}"
            self._notify(msg)
        elif not self._is_quiet_hours():
            msg = f"[Sentinel] 首次啟動 ({now_str})"
            self._notify(msg)

    # ------------------------------------------------------------------
    # Reconciliation loop (v2) — replaces _check_infra
    # ------------------------------------------------------------------

    def _reconcile(self):
        """Observe → Diff → Act.  Runs every main-loop tick (~30s)."""
        ds = self.config.get("desired_state")
        if not ds:
            return  # no desired_state in YAML → skip

        now = datetime.now()
        reconcile = self.state["sentinel"].setdefault("reconcile", {})

        # ── 1. OBSERVE services + system ──
        actual = observe_all(ds)

        # ── 2. OBSERVE configs (every 5 min) ──
        last_cfg_check = reconcile.get("last_config_check")
        cfg_deltas = []
        if not last_cfg_check or (now - datetime.fromisoformat(last_cfg_check)).total_seconds() >= 300:
            cfg_deltas = self._check_configs(ds.get("configs", {}))
            reconcile["last_config_check"] = now.isoformat()

        # ── 3. DIFF ──
        deltas = self._diff(ds, actual)
        deltas.extend(cfg_deltas)

        # ── 4. ACT ──
        if deltas:
            self._act(deltas)

        # ── 5. STORE observation ──
        self._store_observation(actual, deltas)
        self._update_dashboard(actual, deltas)
        self._save_state()

    def _check_configs(self, configs_cfg):
        """Check configs for drift / corruption. Returns list of deltas."""
        if not configs_cfg:
            return []

        reconcile = self.state["sentinel"].setdefault("reconcile", {})
        stored_checksums = reconcile.get("config_checksums", {})
        backup_dir = str(CONFIG_BACKUPS)
        deltas = []

        cfg_obs = observe_configs(configs_cfg)

        for name, info in cfg_obs.items():
            entry = configs_cfg[name]
            on_invalid = entry.get("on_invalid", {})
            risk = on_invalid.get("risk", "high")
            action = on_invalid.get("action", "notify")
            path = entry["path"]

            if not info["exists"]:
                deltas.append({
                    "kind": "config", "name": name,
                    "issue": "missing", "desired": "exists",
                    "actual": "not found", "risk": risk, "action": action,
                })
                continue

            if not info["valid"]:
                deltas.append({
                    "kind": "config", "name": name,
                    "issue": "invalid", "desired": "valid",
                    "actual": "; ".join(info["errors"]),
                    "risk": risk, "action": action,
                })
                continue

            # Checksum drift — valid file changed
            prev = stored_checksums.get(name)
            if prev and info["sha256"] != prev:
                self.logger.info("[Reconcile] config %s changed (valid)", name)
                # Re-backup the new valid version
                try:
                    backup_config(path, backup_dir, name)
                except Exception as e:
                    self.logger.warning("config backup failed for %s: %s", name, e)

            # Update stored checksum
            stored_checksums[name] = info["sha256"]

        reconcile["config_checksums"] = stored_checksums
        return deltas

    def _diff(self, desired_state, actual):
        """Compare desired vs actual. Returns list of delta dicts."""
        deltas = []
        services_cfg = desired_state.get("services", {})
        svc_details = actual.get("details", {}).get("services", {})

        for name, cfg in services_cfg.items():
            info = svc_details.get(name, {})
            repair = cfg.get("repair", {})
            risk = repair.get("risk", "high")
            method = repair.get("method", "kickstart")
            label = cfg.get("label", "")

            if not info.get("running"):
                deltas.append({
                    "kind": "service", "name": name, "label": label,
                    "issue": "not_running",
                    "desired": "running", "actual": "stopped",
                    "risk": risk, "action": method,
                    "repair_cfg": repair,
                })
            elif cfg.get("port") and not info.get("port_open"):
                deltas.append({
                    "kind": "service", "name": name, "label": label,
                    "issue": "port_closed",
                    "desired": f"port {cfg['port']} open",
                    "actual": "port closed",
                    "risk": risk, "action": method,
                    "repair_cfg": repair,
                })
            elif cfg.get("health", {}).get("type") == "http" and not info.get("healthy"):
                deltas.append({
                    "kind": "service", "name": name, "label": label,
                    "issue": "unhealthy",
                    "desired": "healthy", "actual": "health check failed",
                    "risk": risk, "action": method,
                    "repair_cfg": repair,
                })

        # System deltas
        sys_cfg = desired_state.get("system", {})
        disk_pct = actual.get("disk", 0)
        if disk_pct >= sys_cfg.get("disk_crit_pct", 90):
            deltas.append({
                "kind": "system", "name": "disk",
                "issue": "disk_critical",
                "desired": f"<{sys_cfg.get('disk_crit_pct', 90)}%",
                "actual": f"{disk_pct}%",
                "risk": "high", "action": "notify",
            })

        swap_mb = actual.get("swap", 0)
        if swap_mb >= sys_cfg.get("swap_crit_mb", 1000):
            deltas.append({
                "kind": "system", "name": "swap",
                "issue": "swap_critical",
                "desired": f"<{sys_cfg.get('swap_crit_mb', 1000)}MB",
                "actual": f"{swap_mb:.0f}MB",
                "risk": "high", "action": "notify",
            })

        return deltas

    def _act(self, deltas):
        """Execute actions based on risk tier."""
        now = datetime.now()
        reconcile = self.state["sentinel"].setdefault("reconcile", {})
        backoffs = reconcile.setdefault("backoffs", {})
        action_log = reconcile.setdefault("action_log", [])

        for delta in deltas:
            risk = delta.get("risk", "high")
            dkey = f"{delta['kind']}:{delta['name']}:{delta['issue']}"

            if risk == "high":
                self.logger.warning("[Reconcile] HIGH risk — log only: %s", dkey)
                action_log.append({
                    "at": now.isoformat(), "delta": dkey,
                    "action": "log_only", "auto": False, "success": False,
                })
                continue

            if risk == "med":
                self._act_med(delta, dkey, now, action_log)
                continue

            # risk == low → auto-repair with backoff
            self._act_low(delta, dkey, now, backoffs, action_log)

        # Prune action_log to last 100 entries
        if len(action_log) > 100:
            reconcile["action_log"] = action_log[-100:]

    def _act_med(self, delta, dkey, now, action_log):
        """Medium risk: notify Cruz, deduplicate to once per hour."""
        reconcile = self.state["sentinel"].setdefault("reconcile", {})
        last_notified = reconcile.get("last_med_notify", {})
        prev = last_notified.get(dkey)

        if prev:
            try:
                elapsed = (now - datetime.fromisoformat(prev)).total_seconds()
                if elapsed < 3600:
                    return  # already notified within the hour
            except (ValueError, TypeError):
                pass

        msg = (f"[Sentinel Reconcile]\n"
               f"Issue: {delta['issue']}\n"
               f"Service: {delta['name']}\n"
               f"Expected: {delta.get('desired', '?')}\n"
               f"Actual: {delta.get('actual', '?')}\n"
               f"Risk: med — awaiting your confirmation")
        self._notify(msg)
        # Skip bulletin for known-noise services to avoid flooding
        noise_keys = {"service:line-bot-b", "service:bridge-dufu", "service:bridge-andrew", "service:openclaw-gateway"}
        if not any(dkey.startswith(k) for k in noise_keys):
            self._bulletin_alert(f"[Reconcile] {dkey}: {delta.get('actual', '?')}")

        last_notified[dkey] = now.isoformat()
        reconcile["last_med_notify"] = last_notified

        action_log.append({
            "at": now.isoformat(), "delta": dkey,
            "action": "notify_cruz", "auto": False, "success": True,
        })

    def _act_low(self, delta, dkey, now, backoffs, action_log):
        """Low risk: auto-repair with exponential backoff + flap detection."""
        bo = backoffs.get(dkey, {"retries": 0, "delay": 0, "next_attempt": None})
        repair_cfg = delta.get("repair_cfg", {})
        max_retries = repair_cfg.get("max_retries", 10)
        base = repair_cfg.get("backoff", 15)
        cap = repair_cfg.get("cap", 300)

        # Check if we've exceeded max retries → escalate to med
        if bo["retries"] >= max_retries:
            self.logger.warning("[Reconcile] %s exceeded max_retries (%d), escalating to med",
                                dkey, max_retries)
            delta["risk"] = "med"
            self._act_med(delta, dkey, now, action_log)
            return

        # ── Flap detection: if kickstart keeps "succeeding" but service crashes again ──
        reconcile = self.state["sentinel"].setdefault("reconcile", {})
        repair_ts = reconcile.setdefault("repair_timestamps", {})
        ts_list = repair_ts.get(dkey, [])
        # Trim to window
        cutoff = (now - timedelta(seconds=FLAP_WINDOW_SEC)).isoformat()
        ts_list = [t for t in ts_list if t > cutoff]
        if len(ts_list) >= FLAP_THRESHOLD:
            self.logger.warning("[Reconcile] FLAP detected for %s (%d repairs in 1h)",
                                dkey, len(ts_list))
            handled = self._handle_flap(delta, dkey, now, action_log)
            if handled:
                ts_list.clear()
                repair_ts[dkey] = ts_list
                return
            # Flap not fixable → escalate
            delta["risk"] = "med"
            self._act_med(delta, dkey, now, action_log)
            repair_ts[dkey] = ts_list
            return

        # Check backoff timing
        next_attempt = bo.get("next_attempt")
        if next_attempt:
            try:
                if now < datetime.fromisoformat(next_attempt):
                    return  # still in backoff
            except (ValueError, TypeError):
                pass

        # Execute repair
        label = delta.get("label", "")
        method = delta.get("action", "kickstart")
        self.logger.info("[Reconcile] auto-repair %s (attempt %d): %s %s",
                         dkey, bo["retries"] + 1, method, label)

        success = execute_repair(label, method)

        bo["retries"] = bo["retries"] + 1
        if success:
            self.logger.info("[Reconcile] auto-repaired %s", dkey)
            # Track for flap detection
            ts_list.append(now.isoformat())
            repair_ts[dkey] = ts_list
            # Reset backoff on success
            bo["retries"] = 0
            bo["delay"] = 0
            bo["next_attempt"] = None
        else:
            delay = compute_backoff(bo["retries"], base, cap)
            bo["delay"] = delay
            bo["next_attempt"] = (now + timedelta(seconds=delay)).isoformat()
            self.logger.warning("[Reconcile] repair failed for %s, next attempt in %.0fs", dkey, delay)

        backoffs[dkey] = bo
        action_log.append({
            "at": now.isoformat(), "delta": dkey,
            "action": method, "auto": True, "success": success,
        })

    def _handle_flap(self, delta, dkey, now, action_log):
        """Handle a flapping service: Layer 1 (pattern) → Layer 2 (AI) → Layer 3 (notify Cruz).

        Returns True if the root cause was fixed, False if escalation needed.
        """
        label = delta.get("label", "")
        name = delta.get("name", "")
        self.logger.info("[Flap] diagnosing %s (label=%s)", dkey, label)

        # Read stderr for clues
        stderr = read_stderr_tail(label)
        if not stderr:
            self.logger.warning("[Flap] no stderr for %s, cannot diagnose", name)
            return self._flap_ai_repair(delta, dkey, now, action_log, "(no stderr)")

        # ── Layer 1: known pattern (config validation error) ──
        diagnosis = diagnose_config_error(stderr)
        if diagnosis:
            config_path = diagnosis["config_path"]
            bad_keys = diagnosis["bad_keys"]
            self.logger.info("[Flap L1] config error: %d bad keys in %s", len(bad_keys), config_path)

            result = repair_config_keys(diagnosis)
            if result["fixed"]:
                method = delta.get("action", "kickstart")
                success = execute_repair(label, method)
                removed_str = ", ".join(result["removed"])
                msg = (
                    f"[Sentinel L1 自動修復] {name} 反覆崩潰 → config 壞 key 已移除\n"
                    f"移除: {removed_str}\n"
                    f"備份: {result['backup']}\n"
                    f"重啟: {'成功' if success else '失敗'}"
                )
                self._notify(msg)
                self.logger.info("[Flap L1] %s", msg.replace("\n", " | "))
                action_log.append({
                    "at": now.isoformat(), "delta": dkey,
                    "action": "config_auto_repair", "auto": True, "success": True,
                    "detail": f"removed: {removed_str}",
                })
                return True

        # ── Layer 2: AI diagnosis (Claude CLI) ──
        return self._flap_ai_repair(delta, dkey, now, action_log, stderr[-2000:])

    def _flap_ai_repair(self, delta, dkey, now, action_log, stderr_snippet):
        """Layer 2: spawn Claude CLI to diagnose and fix an unknown flapping service.

        Returns True if Claude fixed it, False → escalate to Cruz (Layer 3).
        """
        flap_cfg = self.config.get("flap_repair", {})
        if not flap_cfg.get("ai_enabled", False):
            self.logger.info("[Flap L2] AI repair disabled, escalating to Cruz")
            return False

        # Cooldown: max 1 AI repair per hour per service
        reconcile = self.state["sentinel"].setdefault("reconcile", {})
        last_ai = reconcile.get("last_ai_repair", {})
        prev = last_ai.get(dkey)
        cooldown = flap_cfg.get("cooldown_sec", 3600)
        if prev:
            try:
                elapsed = (now - datetime.fromisoformat(prev)).total_seconds()
                if elapsed < cooldown:
                    self.logger.info("[Flap L2] AI cooldown for %s (%ds left)", dkey,
                                     int(cooldown - elapsed))
                    return False
            except (ValueError, TypeError):
                pass

        name = delta.get("name", "")
        label = delta.get("label", "")
        model = flap_cfg.get("model", "haiku")
        budget = flap_cfg.get("max_budget_usd", 0.05)
        timeout = flap_cfg.get("timeout_sec", 120)
        allowed = flap_cfg.get("allowed_tools", "Bash Read Edit Glob Grep")

        prompt = (
            f"Sentinel 偵測到 {name} (launchd label: {label}) 反覆崩潰 "
            f"(1 小時內 kickstart {FLAP_THRESHOLD}+ 次都成功但馬上又掛)。\n\n"
            f"stderr 最後內容:\n```\n{stderr_snippet}\n```\n\n"
            f"請：\n"
            f"1. 診斷根因\n"
            f"2. 修復問題（備份原檔再改）\n"
            f"3. 重啟服務: launchctl kickstart -k gui/{os.getuid()}/{label}\n"
            f"4. 驗證服務正常\n\n"
            f"限制：不要刪除任何資料檔案，只修 config。"
        )

        self.logger.info("[Flap L2] spawning Claude CLI (model=%s, budget=$%.2f) for %s",
                         model, budget, dkey)
        self._notify(f"[Sentinel L2] {name} 反覆崩潰，啟動 AI 診斷修復中...")

        try:
            cmd = [
                "claude", "-p", prompt,
                "--model", model,
                "--max-budget-usd", str(budget),
                "--allowedTools", allowed,
                "--output-format", "text",
                "--no-session-persistence",
            ]
            result = subprocess.run(
                cmd, capture_output=True, text=True,
                timeout=timeout, cwd=str(BASE),
            )
            output = result.stdout[-1500:] if result.stdout else "(no output)"
            exit_code = result.returncode

            self.logger.info("[Flap L2] Claude exited %d, output: %s",
                             exit_code, output[:200])
        except subprocess.TimeoutExpired:
            self.logger.warning("[Flap L2] Claude timed out after %ds", timeout)
            output = "(timeout)"
            exit_code = -1
        except FileNotFoundError:
            self.logger.error("[Flap L2] claude CLI not found in PATH")
            return False
        except Exception as e:
            self.logger.error("[Flap L2] Claude spawn failed: %s", e)
            return False

        # Record AI repair attempt
        last_ai[dkey] = now.isoformat()
        reconcile["last_ai_repair"] = last_ai

        # Check if service is now healthy
        import time as _time
        _time.sleep(5)
        from lib.reconciler import _check_launchd, _check_port
        svc_cfg = self.config.get("desired_state", {}).get("services", {}).get(name, {})
        ld = _check_launchd(label)
        port = svc_cfg.get("port")
        port_ok = _check_port(port) if port else True
        fixed = ld["running"] and port_ok

        # Truncate output for notification
        output_brief = output[:300].replace("\n", " ")
        if fixed:
            msg = (
                f"[Sentinel L2 修復成功] {name}\n"
                f"Claude 診斷: {output_brief}"
            )
        else:
            msg = (
                f"[Sentinel L2 修復失敗] {name} — 需要人工排查\n"
                f"Claude 輸出: {output_brief}"
            )
        self._notify(msg)
        self.logger.info("[Flap L2] fixed=%s", fixed)

        action_log.append({
            "at": now.isoformat(), "delta": dkey,
            "action": "ai_repair", "auto": True, "success": fixed,
            "detail": output_brief,
        })

        return fixed

    def _store_observation(self, actual, deltas):
        """Store observation snapshot in state, keeping last 24h."""
        observations = self.state["sentinel"].setdefault("observations", [])
        # Strip the heavy 'details' from stored observation to save space
        obs = {k: v for k, v in actual.items() if k != "details"}
        obs["delta_count"] = len(deltas)
        observations.append(obs)
        # Keep last 24h (~2880 at 30s intervals, but cap at 300 for sanity)
        if len(observations) > 300:
            self.state["sentinel"]["observations"] = observations[-300:]

    def _build_thoughts(self, actual, deltas):
        """Synthesize sentinel's reasoning trace with concrete evidence."""
        now = datetime.now()
        ts = now.strftime("%H:%M:%S")
        thoughts = []
        t = lambda ph, msg: thoughts.append({"t": ts, "ph": ph, "msg": msg})

        svc_details = actual.get("details", {}).get("services", {})
        sys_details = actual.get("details", {}).get("system", {})
        up = sum(1 for v in svc_details.values() if v.get("running"))
        total = len(svc_details)
        down = total - up

        # ── OBSERVE: per-service evidence ──
        if down:
            t("觀測", f"掃描 {total} 守護者 → {up} 健在, {down} 失聯")
        else:
            t("觀測", f"掃描 {total} 守護者 → 全員健在")

        # Per-service status + deep probe for unhealthy ones
        ds = self.config.get("desired_state", {})
        svc_cfg = ds.get("services", {})
        for name, info in svc_details.items():
            healthy = info.get("running") and info.get("port_open", True) and info.get("healthy", True)
            if healthy:
                continue

            if not info.get("running"):
                err = info.get("error") or "process not found"
                t("觀測", f"  {name}: pid=None, {err}")
            elif not info.get("port_open"):
                t("觀測", f"  {name}: pid={info.get('pid')} 但 port 無回應")
            elif not info.get("healthy"):
                t("觀測", f"  {name}: pid={info.get('pid')} port=ok 但 health check 失敗")

            # Deep probe — endoscope
            cfg = svc_cfg.get(name, {})
            try:
                findings = deep_probe(name, cfg, info)
                for f in findings:
                    t("探針", f"  {name}: {f}")
            except Exception as e:
                t("探針", f"  {name}: 探針失敗 — {e}")

        # ── SYSTEM evidence ──
        disk_pct = actual.get("disk", 0)
        swap_mb = actual.get("swap", 0)
        cpu_top = actual.get("cpu", [])
        disk_info = sys_details.get("disk", {})
        free_gb = disk_info.get("free_gb", "?")
        cpu_str = ", ".join(f"{p.get('proc','?').rsplit('/',1)[-1]}={p.get('pct',0)}%" for p in cpu_top[:3]) if cpu_top else "idle"
        t("系統", f"Disk {disk_pct:.1f}% (剩 {free_gb}GB) | Swap {swap_mb:.0f}MB | CPU [{cpu_str}]")

        # ── DIFF + ACT: what's wrong and what I'm doing about it ──
        if not deltas:
            t("比對", "desired_state 與 actual 一致，穩態確認")
        else:
            reconcile = self.state["sentinel"].get("reconcile", {})
            for d in deltas:
                risk = d.get("risk", "high")
                dkey = f"{d['kind']}:{d['name']}:{d['issue']}"

                # Duration from first observation
                dur = ""
                if d.get("kind") == "service":
                    for o in self.state["sentinel"].get("observations", []):
                        if o.get("svc", {}).get(d["name"]) is False:
                            try:
                                first = datetime.fromisoformat(o["at"].replace("+08:00", "+08:00"))
                                mins = (now - first.replace(tzinfo=None)).total_seconds() / 60
                                dur = f" 已持續 {int(mins)}m"
                            except (ValueError, TypeError, KeyError):
                                pass
                            break

                t("裂隙", f"{d['name']}: desired={d.get('desired','?')} actual={d.get('actual','?')}{dur}")

                # Decision with full reasoning
                if risk == "med":
                    notified_at = reconcile.get("last_med_notify", {}).get(dkey)
                    if notified_at:
                        try:
                            elapsed = (now - datetime.fromisoformat(notified_at)).total_seconds()
                            remaining_m = max(0, int((3600 - elapsed) / 60))
                            t("決策", f"{d['name']}: risk=med 我無權自動修復 → "
                              f"已於 {datetime.fromisoformat(notified_at).strftime('%H:%M')} 通報 Cruz "
                              f"→ 1h 冷卻中 剩 {remaining_m}m{'，即將再次通報' if remaining_m == 0 else ''}")
                        except (ValueError, TypeError):
                            t("決策", f"{d['name']}: risk=med 已通報但時間戳異常")
                    else:
                        t("決策", f"{d['name']}: risk=med 我無權自動修復 → 首次通報 Cruz → 發送 Telegram")

                elif risk == "low":
                    bo = reconcile.get("backoffs", {}).get(dkey, {})
                    retries = bo.get("retries", 0)
                    max_r = d.get("repair_cfg", {}).get("max_retries", 10)
                    next_at = bo.get("next_attempt")
                    if next_at:
                        try:
                            wait = max(0, int((datetime.fromisoformat(next_at) - now).total_seconds()))
                            t("決策", f"{d['name']}: risk=low 自動修復中 retry {retries}/{max_r} → 冷卻 {wait}s 後重試")
                        except (ValueError, TypeError):
                            t("決策", f"{d['name']}: risk=low 自動修復中 retry {retries}/{max_r}")
                    elif retries >= max_r:
                        t("決策", f"{d['name']}: risk=low 但已耗盡 {max_r} 次重試 → 升級為 med 通報 Cruz")
                    else:
                        t("決策", f"{d['name']}: risk=low → 執行 launchctl kickstart (attempt {retries+1}/{max_r})")
                else:
                    t("決策", f"{d['name']}: risk=high 不可自動處理 → 僅記錄，等待人工介入")

        # Append to thoughts.log (tail -f friendly)
        log_path = BASE / "thoughts.log"
        try:
            with open(log_path, "a") as f:
                for t in thoughts:
                    f.write(f"{t['t']}  [{t['ph']}]  {t['msg']}\n")
                f.write("\n")
        except Exception:
            pass

        return thoughts

    def _get_jarvis_scores(self):
        """Get JARVIS evolution scores, cached for 5 minutes."""
        import subprocess as _sp
        sentinel = self.state["sentinel"]
        cached = sentinel.get("jarvis_cache", {})
        cached_at = cached.get("checked_at", "")
        # Refresh every 5 minutes
        if cached_at:
            try:
                age = (datetime.now() - datetime.fromisoformat(cached_at)).total_seconds()
                if age < 300:
                    return cached
            except (ValueError, TypeError):
                pass
        try:
            r = _sp.run(
                [sys.executable, str(JARVIS_SCRIPT), "--json"],
                capture_output=True, text=True, timeout=30
            )
            if r.returncode == 0 and r.stdout.strip():
                data = json.loads(r.stdout)
                sentinel["jarvis_cache"] = data
                return data
            else:
                self.logger.warning("JARVIS: rc=%d stdout=%d stderr=%s",
                                    r.returncode, len(r.stdout), r.stderr[:200] if r.stderr else "")
        except Exception as e:
            self.logger.warning("JARVIS score fetch failed: %s", e)
        return cached if cached else None

    def _build_agent_roster(self):
        """Dynamically build agent roster from openclaw.json + agents-meta.json + config.json."""
        from collections import defaultdict

        OPENCLAW_CFG = Path.home() / ".openclaw" / "openclaw.json"
        try:
            cfg = json.loads(OPENCLAW_CFG.read_text())
        except Exception as e:
            self.logger.warning("Cannot read openclaw.json: %s", e)
            return [], {}, {}

        agents_list = cfg.get("agents", {}).get("list", [])
        bindings = cfg.get("bindings", [])
        tg_groups = cfg.get("channels", {}).get("telegram", {}).get("groups", {})
        default_deny = tg_groups.get("*", {}).get("tools", {}).get("deny", [])

        # agents-meta.json (display metadata)
        meta_path = BASE / "agents-meta.json"
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

        # sentinel/config.json (bridge info + monitor-only groups)
        sentinel_cfg = json.loads((BASE / "config.json").read_text())
        sentinel_groups = sentinel_cfg.get("groups", {})
        bridges = sentinel_cfg.get("bridge", {})
        bridge_ports = {}
        for name, url in bridges.items():
            try:
                bridge_ports[name] = int(url.rsplit(":", 1)[-1])
            except (ValueError, IndexError):
                pass

        # agent → chatIds mapping from bindings
        agent_chats = defaultdict(list)
        for b in bindings:
            peer = b.get("match", {}).get("peer", {})
            if peer.get("kind") == "group" and peer.get("id"):
                gid = peer["id"]
                aid = b["agentId"]
                if gid not in agent_chats[aid]:
                    agent_chats[aid].append(gid)

        # Add monitor-only groups from sentinel config
        for gid, g in sentinel_groups.items():
            aid = g.get("agent_id")
            if aid and gid not in agent_chats.get(aid, []):
                agent_chats[aid].append(gid)

        # Build roster
        CAT_GARDEN = {"work": "tree", "family": "flower", "tools": "mushroom"}
        roster = []
        for agent in agents_list:
            aid = agent["id"]
            if aid == "wuji":
                continue
            m = meta.get(aid, {})
            cat = m.get("category", "tools")
            chat_ids = agent_chats.get(aid, [])

            # Per-group permissions
            perms = {}
            for gid in chat_ids:
                gconf = tg_groups.get(gid, {})
                deny = gconf.get("tools", {}).get("deny", default_deny)
                perms[gid] = {"deny": deny, "full": len(deny) == 0}

            # Bridge info from primary chat
            primary = chat_ids[0] if chat_ids else None
            sg = sentinel_groups.get(primary, {}) if primary else {}
            bridge_name = sg.get("bridge", "dufu")

            roster.append({
                "id": m.get("projectId", aid),
                "name": m.get("name", aid.replace("-", " ").title()),
                "agentId": aid,
                "category": cat,
                "gardenType": m.get("gardenType", CAT_GARDEN.get(cat, "mushroom")),
                "color": m.get("color", "#888888"),
                "emoji": m.get("emoji", ""),
                "chatIds": chat_ids,
                "model": agent.get("model", {}).get("primary", "default"),
                "permissions": perms,
                "bridge": bridge_name,
                "bridgePort": bridge_ports.get(bridge_name),
            })

        return roster, bridge_ports, sentinel_groups

    def _get_private_chats_for_dashboard(self, sentinel_groups=None):
        """Build private chats list + unknown contacts for dashboard."""
        try:
            sentinel_cfg = json.loads((BASE / "config.json").read_text())
        except Exception:
            return {"known": [], "unknown": []}
        private = sentinel_cfg.get("private_chats", {})
        meta_path = BASE / "agents-meta.json"
        meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

        # Known contacts
        known_ids = set()
        known = []
        for bridge_name, chats in private.items():
            for uid, info in chats.items():
                known_ids.add(uid)
                aid = info.get("agent_id")
                m = meta.get(aid, {}) if aid else {}
                known.append({
                    "userId": uid,
                    "name": info.get("name", uid),
                    "bridge": bridge_name,
                    "priority": info.get("priority", "low"),
                    "agentId": aid,
                    "agentColor": m.get("color", "#888888"),
                    "status": "known",
                })

        # Unknown contacts from conversation DB
        unknown = []
        import sqlite3
        db_path = BASE / "data" / "conversations.db"
        if db_path.exists():
            try:
                conn = sqlite3.connect(str(db_path), timeout=5)
                conn.row_factory = sqlite3.Row
                rows = conn.execute("""
                    SELECT DISTINCT sender_id, sender_name, chat_id
                    FROM messages
                    WHERE CAST(chat_id AS INTEGER) > 0
                      AND sender_id IS NOT NULL
                      AND sender_id != ''
                """).fetchall()
                conn.close()
                for row in rows:
                    sid = str(row["sender_id"])
                    if sid not in known_ids:
                        unknown.append({
                            "userId": sid,
                            "name": row["sender_name"] or sid,
                            "bridge": "unknown",
                            "priority": "unknown",
                            "agentId": None,
                            "agentColor": "#EF4444",
                            "status": "unknown",
                        })
            except Exception:
                pass

        return {"known": known, "unknown": unknown}

    def _update_dashboard(self, actual, deltas):
        """Write dashboard-state.js for the HTML dashboard."""
        # Dynamic agent roster from config files
        roster, bridge_ports, s_groups = self._build_agent_roster()
        OPENCLAW_CFG = Path.home() / ".openclaw" / "openclaw.json"
        try:
            gateway_port = json.loads(OPENCLAW_CFG.read_text()).get("gateway", {}).get("port", 18789)
        except Exception:
            gateway_port = 18789

        reconcile = self.state["sentinel"].get("reconcile", {})

        # Enrich deltas with depth info: first_seen, backoff state, notify state
        enriched_deltas = []
        observations = self.state["sentinel"].get("observations", [])
        backoffs = reconcile.get("backoffs", {})
        last_med_notify = reconcile.get("last_med_notify", {})

        for d in deltas:
            ed = {k: v for k, v in d.items() if k != "repair_cfg"}
            dkey = f"{d['kind']}:{d['name']}:{d['issue']}"

            # Find first_seen from observations
            first_seen = None
            if d["kind"] == "service":
                for obs in observations:
                    svc_map = obs.get("svc", {})
                    if svc_map.get(d["name"]) is False:
                        first_seen = obs.get("at")
                        break
            ed["first_seen"] = first_seen

            # Backoff state (for low-risk auto-repair)
            bo = backoffs.get(dkey)
            if bo:
                ed["backoff"] = {
                    "retries": bo.get("retries", 0),
                    "max_retries": d.get("repair_cfg", {}).get("max_retries", 10),
                    "next_attempt": bo.get("next_attempt"),
                    "delay": bo.get("delay", 0),
                }

            # Notification state (for med-risk)
            notified_at = last_med_notify.get(dkey)
            if notified_at:
                ed["notified_at"] = notified_at
                ed["next_notify"] = None
                try:
                    from datetime import datetime as _dt
                    nxt = _dt.fromisoformat(notified_at) + timedelta(hours=1)
                    ed["next_notify"] = nxt.isoformat()
                except (ValueError, TypeError):
                    pass

            # Who needs to act
            risk = d.get("risk", "high")
            if risk == "low":
                ed["owner"] = "auto"
            elif risk == "med":
                ed["owner"] = "cruz"
            else:
                ed["owner"] = "manual"

            enriched_deltas.append(ed)

        # Build thought stream and store rolling buffer
        thoughts = self._build_thoughts(actual, deltas)
        thought_buf = self.state["sentinel"].setdefault("thought_stream", [])
        thought_buf.extend(thoughts)
        if len(thought_buf) > 60:
            self.state["sentinel"]["thought_stream"] = thought_buf[-60:]

        # JARVIS evolution scores (cached, refresh every 5 min)
        jarvis = self._get_jarvis_scores()

        dashboard_data = {
            "updated_at": datetime.now().isoformat(),
            "started_at": self.state["sentinel"].get("started_at"),
            "jarvis": jarvis,
            "thought_stream": self.state["sentinel"].get("thought_stream", [])[-60:],
            "observation": {k: v for k, v in actual.items() if k != "details"},
            "services": actual.get("details", {}).get("services", {}),
            "system": actual.get("details", {}).get("system", {}),
            "deltas": enriched_deltas,
            "reconcile": {
                "action_log": reconcile.get("action_log", [])[-20:],
                "backoffs": backoffs,
                "config_checksums": reconcile.get("config_checksums", {}),
            },
            "tasks": {
                "last_task": self.state["sentinel"].get("last_task"),
                "task_runs": self.state["sentinel"].get("task_runs", {}),
                "last_task_dates": self.state["sentinel"].get("last_task_dates", {}),
            },
            "conversation_pulse": self.state["sentinel"].get("conversation_pulse", {}),
            "conversation_sync": self.state["sentinel"].get("conversation_sync", {}),
            "agent_health": self.state["sentinel"].get("agent_health", {}),
            "gateway_watchdog": self.state.get("gateway_watchdog", {}),
            "observations_24h": self.state["sentinel"].get("observations", [])[-300:],
            "agent_roster": roster,
            "topology": {
                "gateway": {"port": gateway_port},
                "bridges": {
                    f"bridge-{name}": {
                        "port": port,
                        "agents": sorted({r["agentId"] for r in roster if r.get("bridge") == name}),
                    } for name, port in bridge_ports.items()
                },
                "tunnel": {"cloudflare-tunnel": {"target": "line-bot-b"}},
            },
            "agent_chat_map": {
                r["agentId"]: {
                    "primary_chat": r["chatIds"][0] if r["chatIds"] else None,
                    "bridge_port": r.get("bridgePort"),
                    "label": s_groups.get(r["chatIds"][0], {}).get("name", r["name"]) if r["chatIds"] else r["name"],
                } for r in roster
            },
            "private_chats": self._get_private_chats_for_dashboard(s_groups),
            "line_stats": self._get_line_stats(),
            "data_mirror": self._get_data_mirror(),
            "api_errors": self._get_api_error_stats(),
            "river": self._get_river_stats(),
            "matomo_health": self.state["sentinel"].get("matomo_health", {}),
        }
        js_path = BASE / "dashboard-state.js"
        tmp = js_path.with_suffix(".js.tmp")
        try:
            with open(tmp, "w") as f:
                f.write("window.__STATE__ = ")
                json.dump(dashboard_data, f, ensure_ascii=False)
                f.write(";\n")
                f.flush()
                os.fsync(f.fileno())
            tmp.rename(js_path)
            import shutil
            # Sync state to all serving locations:
            # - wuji-empire/dist: serve.sh (port 18800, Safari)
            # - ~/.openclaw/canvas: canvas host (gateway, fallback)
            # - src + dist canvas-host/a2ui: A2UI endpoint (iOS app WebView)
            dist_dir = BASE / "wuji-empire" / "dist"
            canvas_dir = Path.home() / ".openclaw" / "canvas"
            a2ui_dirs = [
                BASE.parent / "src" / "canvas-host" / "a2ui",
                BASE.parent / "dist" / "canvas-host" / "a2ui",
            ]
            for target_dir in [dist_dir, canvas_dir] + a2ui_dirs:
                if target_dir.is_dir():
                    shutil.copy2(js_path, target_dir / "dashboard-state.js")
            # Sync dashboard HTML to a2ui + canvas if stale (after wuji-empire rebuild)
            if dist_dir.is_dir():
                dist_html = dist_dir / "index.html"
                if dist_html.exists():
                    for target_dir in [canvas_dir] + a2ui_dirs:
                        if not target_dir.is_dir():
                            continue
                        target_html = target_dir / "index.html"
                        if not target_html.exists() or dist_html.stat().st_mtime > target_html.stat().st_mtime:
                            for f in ["index.html", "favicon.svg", "manifest.json"]:
                                src = dist_dir / f
                                if src.exists():
                                    shutil.copy2(src, target_dir / f)
        except Exception as e:
            self.logger.warning("Dashboard update failed: %s", e)

    def _get_line_stats(self):
        """Query OpenClaw timeline.db for LINE message stats."""
        import sqlite3 as _sqlite3
        db_path = os.path.expanduser("~/.openclaw/persistent/data/timeline.db")
        if not os.path.exists(db_path):
            return {"ok": False, "error": "timeline.db not found"}

        LINE_GROUPS = {
            "Cf529a05bf3b802a1ef1d4bacf9a5035e": "Let it go 家族群",
            "Cc2fec0609d256bdec712ef364a47bd64": "運動群",
            "C51ba089b96b952137055c303bf87006f": "爬山群",
            "C690db8bc653785775f77caf0cdaf99d8": "可愛的家人",
            "Cb3c4b97251e270672b444cdbccad7b40": "研究群",
            "Ca244be51c395d4c71314618bf99eb073": "AI課程1",
            "Cfd8c85c700f97466b2ced6e0b9b99c45": "AI課程2",
            "C85d6a096aa8b679d939f96d78410f78b": "AI課程3",
            "Ce66387c895031972cd1ef47400153793": "AI課程4",
            "C5a542a4b145e464ad57630a32203771a": "AI課程5",
        }

        try:
            conn = _sqlite3.connect(db_path, timeout=5)
            groups = {}
            total = 0
            for row in conn.execute(
                "SELECT chat_id, COUNT(*), MIN(timestamp), MAX(timestamp) "
                "FROM messages WHERE channel='line' GROUP BY chat_id"
            ):
                chat_id_raw, cnt, earliest, latest = row
                # Extract group ID from chat_id like "line:group:Cf529..."
                gid = chat_id_raw.split(":")[-1] if ":" in chat_id_raw else chat_id_raw
                name = LINE_GROUPS.get(gid, f"未知群 ({gid[:10]})")
                fresh_h = None
                if latest:
                    try:
                        lt = datetime.fromisoformat(str(latest).replace("Z", ""))
                        fresh_h = round((datetime.now() - lt).total_seconds() / 3600, 1)
                    except (ValueError, TypeError):
                        pass
                groups[gid] = {
                    "name": name, "count": cnt,
                    "earliest": str(earliest)[:10] if earliest else None,
                    "latest": str(latest)[:10] if latest else None,
                    "fresh_h": fresh_h,
                }
                total += cnt

            # Check recent 24h activity
            recent_24h = 0
            try:
                cutoff = (datetime.now() - timedelta(hours=24)).isoformat()
                row = conn.execute(
                    "SELECT COUNT(*) FROM messages WHERE channel='line' AND timestamp > ?",
                    (cutoff,)
                ).fetchone()
                recent_24h = row[0] if row else 0
            except Exception:
                pass

            conn.close()
            return {
                "ok": True, "total": total, "recent_24h": recent_24h,
                "group_count": len(groups), "groups": groups,
                "queried_at": datetime.now().isoformat(),
            }
        except Exception as e:
            self.logger.warning("LINE stats query failed: %s", e)
            return {"ok": False, "error": str(e)}

    def _get_data_mirror(self):
        """Get bg666.db local mirror stats for dashboard."""
        import sqlite3 as _sqlite3
        db_path = BASE.parent / "workspace" / "bg666" / "bg666.db"
        sentinel = self.state.get("sentinel", {})
        sync_state = sentinel.get("db_sync", {})
        archive_state = sentinel.get("db_archive", {})

        result = {
            "db_exists": db_path.exists(),
            "sync": {
                "last_synced_date": sync_state.get("last_synced_date"),
                "last_run": sync_state.get("last_run"),
            },
            "archive": {
                "last_run": archive_state.get("last_run"),
                "last_result": archive_state.get("last_result"),
            },
        }

        if not db_path.exists():
            return result

        try:
            size_gb = db_path.stat().st_size / (1024 ** 3)
            result["size_gb"] = round(size_gb, 2)

            conn = _sqlite3.connect(str(db_path), timeout=5)
            conn.execute("PRAGMA query_only = ON")
            tables = {}
            total_rows = 0
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ):
                name = row[0]
                count = conn.execute(f"SELECT COUNT(*) FROM [{name}]").fetchone()[0]
                tables[name] = {"rows": count}
                total_rows += count

                # Get date range
                date_col = "create_time" if name in (
                    "player_change_record", "player_recharge_order", "player_withdraw_order"
                ) else "statistics_day"
                try:
                    minmax = conn.execute(
                        f"SELECT MIN({date_col}), MAX({date_col}) FROM [{name}]"
                    ).fetchone()
                    tables[name]["earliest"] = str(minmax[0])[:10] if minmax[0] else None
                    tables[name]["latest"] = str(minmax[1])[:10] if minmax[1] else None
                except Exception:
                    pass

            conn.close()
            result["tables"] = tables
            result["total_rows"] = total_rows
        except Exception as e:
            self.logger.warning("data_mirror query failed: %s", e)
            result["error"] = str(e)

        return result

    def _get_river_stats(self):
        """Get River Knowledge Engine stats for dashboard."""
        try:
            import sys as _sys
            river_dir = os.path.join(os.path.dirname(__file__), "..", "workspace", "river")
            if river_dir not in _sys.path:
                _sys.path.insert(0, river_dir)
            from dashboard_state import get_river_state
            return get_river_state()
        except Exception as e:
            self.logger.warning("river stats failed: %s", e)
            return None

    def _get_api_error_stats(self):
        """Parse gateway logs for API errors (overloaded, auth, failover)."""
        import glob as _glob
        import re

        log_dir = "/tmp/openclaw"
        today_str = datetime.now().strftime("%Y-%m-%d")
        yesterday_str = (datetime.now() - timedelta(days=1)).strftime("%Y-%m-%d")
        # Only match date-named logs (openclaw-YYYY-MM-DD.log), skip restart logs
        log_files = []
        for ds in [yesterday_str, today_str]:
            p = os.path.join(log_dir, f"openclaw-{ds}.log")
            if os.path.exists(p):
                log_files.append(p)
        if not log_files:
            return {"ok": False, "error": "no gateway logs found"}

        cutoff = (datetime.now() - timedelta(hours=24)).isoformat()
        errors = []
        lane_re = re.compile(r'lane=(\S+)')
        duration_re = re.compile(r'durationMs=(\d+)')
        error_re = re.compile(r'error="(.+)"$')

        for lf in log_files:
            try:
                with open(lf, "r") as f:
                    for line in f:
                        if "lane task error" not in line:
                            continue
                        try:
                            entry = json.loads(line)
                        except (json.JSONDecodeError, ValueError):
                            continue

                        ts = entry.get("time", "")
                        if ts < cutoff:
                            continue

                        msg = entry.get("1", "")
                        lane_m = lane_re.search(msg)
                        dur_m = duration_re.search(msg)
                        err_m = error_re.search(msg)

                        lane = lane_m.group(1) if lane_m else "unknown"
                        # Skip main lane duplicates (same error logged at both main and session lane)
                        if lane == "main":
                            continue
                        duration_ms = int(dur_m.group(1)) if dur_m else 0
                        error_text = err_m.group(1) if err_m else msg

                        # Classify error type
                        if "overload" in error_text.lower() or "繁忙" in error_text:
                            err_type = "overloaded"
                        elif "FailoverError" in error_text:
                            err_type = "failover"
                        elif "401" in error_text or "auth" in error_text.lower():
                            err_type = "auth"
                        elif "rate" in error_text.lower() and "limit" in error_text.lower():
                            err_type = "rate_limit"
                        elif "5" in error_text[:5] and ("50" in error_text[:5]):
                            err_type = "server_error"
                        else:
                            err_type = "other"

                        # Extract agent from lane (e.g. session:agent:wuji:main → wuji)
                        agent = "unknown"
                        if "agent:" in lane:
                            parts = lane.split(":")
                            try:
                                idx = parts.index("agent")
                                if idx + 1 < len(parts):
                                    agent = parts[idx + 1]
                            except ValueError:
                                pass

                        errors.append({
                            "ts": ts,
                            "type": err_type,
                            "agent": agent,
                            "lane": lane,
                            "duration_ms": duration_ms,
                            "error": error_text[:200],
                        })
            except Exception:
                continue

        # Aggregate stats
        by_type = {}
        by_agent = {}
        hourly = {}
        for e in errors:
            t = e["type"]
            a = e["agent"]
            by_type[t] = by_type.get(t, 0) + 1
            by_agent[a] = by_agent.get(a, 0) + 1
            hour = e["ts"][:13]  # "2026-03-03T12"
            hourly[hour] = hourly.get(hour, 0) + 1

        return {
            "ok": True,
            "total_24h": len(errors),
            "by_type": by_type,
            "by_agent": by_agent,
            "hourly": dict(sorted(hourly.items())),
            "recent": errors[-20:],  # last 20 errors
            "queried_at": datetime.now().isoformat(),
        }

    def _snapshot_configs_on_startup(self):
        """Take initial config snapshots and backups on startup."""
        ds = self.config.get("desired_state", {})
        configs_cfg = ds.get("configs", {})
        if not configs_cfg:
            return

        reconcile = self.state["sentinel"].setdefault("reconcile", {})
        backup_dir = str(CONFIG_BACKUPS)

        checksums = snapshot_checksums(configs_cfg)
        reconcile["config_checksums"] = checksums

        # Backup all valid configs
        for name, entry in configs_cfg.items():
            path = entry["path"]
            expanded = os.path.expanduser(path)
            if os.path.isfile(expanded):
                valid, errors = validate_config(expanded, entry.get("validators", []))
                if valid:
                    try:
                        backup_config(path, backup_dir, name)
                        self.logger.info("startup backup: %s", name)
                    except Exception as e:
                        self.logger.warning("startup backup failed for %s: %s", name, e)

        self._save_state()

    def _reflect(self):
        """Periodic reflection — engage Claude only when observations are noteworthy."""
        now = datetime.now()
        last = self.state["sentinel"].get("last_reflect")
        if last:
            try:
                if (now - datetime.fromisoformat(last)).total_seconds() < 7200:
                    return
            except (ValueError, TypeError):
                pass

        observations = self.state["sentinel"].get("observations", [])
        if len(observations) < 6:
            return

        recent = observations[-12:]  # last 2 hours

        # Only spend API calls when something noteworthy happened
        has_issues = any(obs.get("issues") for obs in recent)
        has_changes = self._detect_metric_changes(recent)
        if not has_issues and not has_changes:
            self.state["sentinel"]["last_reflect"] = now.isoformat()
            self._save_state()
            return

        from lib.claude import ClaudeClient
        claude_client = ClaudeClient(
            max_daily_calls=self.config.get("claude", {}).get("max_daily_calls", 20)
        )

        obs_summary = json.dumps(recent, ensure_ascii=False)

        # Include recent auto-repair actions for pattern detection
        action_log = self.state["sentinel"].get("reconcile", {}).get("action_log", [])
        recent_actions = action_log[-20:] if action_log else []
        action_summary = json.dumps(recent_actions, ensure_ascii=False) if recent_actions else "[]"

        prompt = (
            "你是 Sentinel 值班員，負責監控 macOS 主機。\n"
            f"以下是最近的系統觀測快照（每30秒一次）：\n{obs_summary}\n\n"
            "用 JSON 回覆你的判斷：\n"
            '{"summary":"一句話系統狀態","actions":['
            '{"type":"repair|ask|note|watch","detail":"具體說明"}]}\n\n'
            "type 說明：\n"
            "- repair: 你有把握能修的問題（附修法）\n"
            "- ask: 不確定、需要問 Cruz 的事\n"
            "- note: 值得記錄的趨勢或觀察\n"
            "- watch: 建議新增追蹤的系統指標\n"
            "沒事就回空 actions。不確定就用 ask。\n\n"
            f"此外，以下是最近的自動修復紀錄：\n{action_summary}\n"
            "如果發現重複修復模式，請標記為 'ask'。"
        )

        try:
            result = claude_client.analyze(prompt, model="haiku")
            self._execute_reflection(result)
            self.logger.info("Reflection complete")
        except Exception as e:
            self.logger.warning(f"Reflection failed: {e}")

        self.state["sentinel"]["last_reflect"] = now.isoformat()
        self._save_state()

    def _detect_metric_changes(self, observations):
        """Check if metrics shifted significantly over the observation window."""
        if len(observations) < 2:
            return False
        first, last = observations[0], observations[-1]
        if abs(last.get("disk", 0) - first.get("disk", 0)) > 2:
            return True
        if last.get("swap", 0) - first.get("swap", 0) > 200:
            return True
        if first.get("svc") != last.get("svc"):
            return True
        return False

    def _execute_reflection(self, raw_response):
        """Parse and act on reflection results."""
        import re
        try:
            m = re.search(r'\{[\s\S]*\}', raw_response)
            if not m:
                return
            data = json.loads(m.group())
        except (json.JSONDecodeError, ValueError):
            self.logger.warning("Could not parse reflection response")
            return

        summary = data.get("summary", "")
        actions = data.get("actions", [])

        if summary:
            self.logger.info(f"[Reflect] {summary}")

        for action in actions:
            atype = action.get("type")
            detail = action.get("detail", "")

            if atype == "ask":
                self._notify(f"[Sentinel 想問] {detail}")
            elif atype == "note":
                self.logger.info(f"[Reflect note] {detail}")
                # Notes go to log only — bulletin was getting flooded with CPU/swap observations
            elif atype == "repair":
                self.logger.info(f"[Reflect repair] {detail}")
                self._notify(f"[Sentinel 建議修復] {detail}\n需要我執行嗎？")
            elif atype == "watch":
                self.logger.info(f"[Reflect] 建議追蹤: {detail}")
                watches = self.state["sentinel"].setdefault("watch_suggestions", [])
                watches.append({"metric": detail, "at": datetime.now().isoformat()})
                if len(watches) > 20:
                    self.state["sentinel"]["watch_suggestions"] = watches[-20:]

    def run_task(self, task_name, retry=True):
        """Execute a task by name. Retry once on failure."""
        task_cfg = self.config["tasks"].get(task_name)
        if not task_cfg or not task_cfg.get("enabled", True):
            self.logger.info(f"Task {task_name} disabled, skipping")
            return

        self.logger.info(f"Starting task: {task_name}")
        log_event(self.logger, "task_start", task_name)

        try:
            module = importlib.import_module(f"tasks.{task_name}")
            result = module.run(self.config, self.state)
            log_event(self.logger, "task_complete", task_name, str(result)[:200])
            self.state["sentinel"]["last_task"] = {
                "name": task_name,
                "at": datetime.now().isoformat(),
                "ok": True,
            }
            runs = self.state["sentinel"]["task_runs"]
            runs[task_name] = runs.get(task_name, 0) + 1
            # Track last run date for catch-up after reboot
            self.state["sentinel"].setdefault("last_task_dates", {})
            self.state["sentinel"]["last_task_dates"][task_name] = date.today().isoformat()
            self._save_state()
        except Exception as e:
            tb = traceback.format_exc()
            log_event(self.logger, "task_error", task_name, tb, success=False)
            if retry:
                self.logger.warning(f"Task {task_name} failed, retrying in 30s...")
                time.sleep(30)
                self.run_task(task_name, retry=False)
            else:
                msg = f"[Sentinel] Task `{task_name}` failed:\n{str(e)[:200]}"
                self._bulletin_alert(msg)
                self._notify(msg)
                self.state["sentinel"]["last_task"] = {
                    "name": task_name,
                    "at": datetime.now().isoformat(),
                    "ok": False,
                    "error": str(e)[:200],
                }
                self._save_state()

    def setup_schedule(self):
        """Parse sentinel.yaml schedule entries and register with `schedule`."""
        for task_name, task_cfg in self.config["tasks"].items():
            if not task_cfg.get("enabled", True):
                continue
            sched = task_cfg["schedule"]

            if sched.startswith("every "):
                # "every 4h" → schedule.every(4).hours
                parts = sched.split()
                val = int(parts[1].rstrip("hm"))
                unit = parts[1][-1]
                if unit == "h":
                    schedule.every(val).hours.do(self.run_task, task_name)
                elif unit == "m":
                    schedule.every(val).minutes.do(self.run_task, task_name)
                self.logger.info(f"Scheduled {task_name}: {sched}")

            elif " " in sched:
                # "sunday 10:00" → schedule.every().sunday.at("10:00")
                day, at_time = sched.split(None, 1)
                day_method = getattr(schedule.every(), day.lower())
                day_method.at(at_time).do(self.run_task, task_name)
                self.logger.info(f"Scheduled {task_name}: {day} at {at_time}")

            else:
                # "02:00" → schedule.every().day.at("02:00")
                schedule.every().day.at(sched).do(self.run_task, task_name)
                self.logger.info(f"Scheduled {task_name}: daily at {sched}")

    def _catch_up(self):
        """Run tasks that were missed (e.g. after reboot). Skip interval-based tasks."""
        now = datetime.now()
        today = now.strftime("%Y-%m-%d")

        for task_name, task_cfg in self.config["tasks"].items():
            if not task_cfg.get("enabled", True):
                continue
            sched = task_cfg["schedule"]

            # Only catch up fixed-time daily tasks (e.g. "02:00", "07:00")
            # Skip interval tasks ("every 4h") and weekly tasks ("sunday 10:00")
            if sched.startswith("every ") or " " in sched:
                continue

            # Check if this task already ran today
            task_runs = self.state.get("sentinel", {}).get("last_task_dates", {})
            last_date = task_runs.get(task_name)
            if last_date == today:
                continue

            # Check if the scheduled time has already passed today
            try:
                sched_hour, sched_min = map(int, sched.split(":"))
                sched_time = now.replace(hour=sched_hour, minute=sched_min, second=0)
                if now > sched_time:
                    self.logger.info(f"Catch-up: running missed task {task_name} (was scheduled {sched})")
                    try:
                        self.run_task(task_name)
                    except Exception as e:
                        self.logger.warning(f"Catch-up {task_name} failed, skipping: {e}")
            except (ValueError, TypeError):
                pass

    def run(self):
        """Main loop — v2 reconciliation."""
        self._notify_startup()
        self.state["sentinel"]["started_at"] = datetime.now().isoformat()
        self._save_state()
        self.logger.info("Sentinel v2 daemon started (reconciliation mode)")
        self._snapshot_configs_on_startup()
        self.setup_schedule()
        self._catch_up()

        # Start Config API server
        try:
            from api import start_api_server
            api_port = self.config.get("http_api", {}).get("port", 18801)
            self._api_thread = start_api_server(port=api_port, logger=self.logger)
        except Exception as e:
            self.logger.warning("Config API server failed to start: %s", e)

        while self.running:
            schedule.run_pending()
            self._reconcile()
            self._reflect()
            time.sleep(30)

        self.logger.info("Sentinel daemon stopped")


def main():
    os.chdir(str(BASE))

    parser = argparse.ArgumentParser(description="Sentinel autonomous daemon")
    parser.add_argument("--dry-run", action="store_true", help="Show schedule without running")
    parser.add_argument("--run-now", type=str, help="Run a specific task immediately")
    parser.add_argument("--config", type=str, help="Config file path")
    args = parser.parse_args()

    sentinel = Sentinel(args.config)

    if args.dry_run:
        sentinel.setup_schedule()
        print(f"Sentinel v2 configured with {len(schedule.get_jobs())} jobs:")
        for job in schedule.get_jobs():
            print(f"  {job}")
        ds = sentinel.config.get("desired_state", {})
        if ds:
            svcs = list(ds.get("services", {}).keys())
            cfgs = list(ds.get("configs", {}).keys())
            print(f"\nDesired state:")
            print(f"  Services: {', '.join(svcs)}")
            print(f"  Configs:  {', '.join(cfgs)}")
            sys_cfg = ds.get("system", {})
            print(f"  Disk warn: {sys_cfg.get('disk_warn_pct', 80)}%, "
                  f"crit: {sys_cfg.get('disk_crit_pct', 90)}%")
        print("\nDry run complete — not starting main loop.")
        return

    if args.run_now:
        if args.run_now == "reconcile":
            sentinel._snapshot_configs_on_startup()
            sentinel._reconcile()
            print("Reconcile complete.")
            return
        sentinel.run_task(args.run_now)
        return

    sentinel.run()


if __name__ == "__main__":
    main()

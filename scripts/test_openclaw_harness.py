#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import openclaw_harness as harness


class RouteTests(unittest.TestCase):
    def test_read_env_file_strips_surrounding_quotes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            env_path = Path(tmpdir) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        'TOKEN="quoted-token"',
                        "SINGLE='single-quoted'",
                        "PLAIN=plain-token",
                    ]
                ),
                encoding="utf-8",
            )

            values = harness.read_env_file(env_path)

        self.assertEqual(values["TOKEN"], "quoted-token")
        self.assertEqual(values["SINGLE"], "single-quoted")
        self.assertEqual(values["PLAIN"], "plain-token")

    def test_verification_routes_to_verification(self):
        result = harness.classify_route("帮我验证配置修改有没有成功")
        self.assertEqual(result["next_actor"], "verification")
        self.assertTrue(result["needs_verification"])

    def test_data_query_routes_to_general_purpose(self):
        result = harness.classify_route("现在 ETH 价格和新闻怎么样")
        self.assertEqual(result["next_actor"], "general-purpose")

    def test_code_exploration_routes_to_explore(self):
        result = harness.classify_route("帮我搜索代码库里哪个文件处理权限")
        self.assertEqual(result["next_actor"], "Explore")

    def test_orchestrate_task_adds_plan_and_verification_for_complex_work(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text(
                "\n".join(
                    [
                        "# Current Task",
                        "",
                        "## 当前主任务",
                        "- 优化 OpenClaw harness",
                        "",
                        "## 下一步",
                        "- 做真正的多 agent 派单 / 收口执行链",
                    ]
                ),
                encoding="utf-8",
            )
            payload = harness.build_task_orchestration(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            stage_ids = [stage["id"] for stage in payload["stages"]]
            actors = [stage["actor"] for stage in payload["stages"]]
            self.assertIn("plan", stage_ids)
            self.assertIn("verification", stage_ids)
            self.assertIn("Plan", actors)
            self.assertIn("Verification", actors)

    def test_dispatch_bundle_builds_handoffs_and_can_write_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text(
                "\n".join(
                    [
                        "# Current Task",
                        "",
                        "## 当前主任务",
                        "- 继续优化 OpenClaw harness",
                        "",
                        "## 下一步",
                        "- 把 staged orchestration 真正接进可执行的 agent dispatch",
                    ]
                ),
                encoding="utf-8",
            )
            payload = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            self.assertFalse(payload["blocked"])
            self.assertEqual(payload["launchable_stage"], "intake")
            self.assertTrue(any(handoff["actor"] == "Plan" for handoff in payload["handoffs"]))
            self.assertTrue(any("Output contract:" in handoff["prompt"] for handoff in payload["handoffs"]))
            applied = harness.apply_dispatch_bundle(workspace, payload)
            self.assertTrue(Path(applied["json"]).exists())
            self.assertTrue(Path(applied["markdown"]).exists())

    def test_dispatch_run_initializes_and_advances(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text(
                "\n".join(
                    [
                        "# Current Task",
                        "",
                        "## 当前主任务",
                        "- 继续优化 OpenClaw harness",
                    ]
                ),
                encoding="utf-8",
            )
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            self.assertEqual(run["current_stage"], "intake")
            self.assertEqual(run["stages"][0]["status"], "ready")
            applied = harness.apply_dispatch_run(workspace, run)
            updated = harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            self.assertEqual(updated["current_stage"], "evidence")
            self.assertEqual(updated["stages"][0]["status"], "completed")

    def test_dispatch_run_ids_are_unique_for_same_bundle(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text(
                "# Current Task\n\n## 当前主任务\n- 继续优化 OpenClaw harness\n",
                encoding="utf-8",
            )
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")

            first = harness.initialize_dispatch_run(bundle)
            second = harness.initialize_dispatch_run(bundle)

            self.assertNotEqual(first["run_id"], second["run_id"])

    def test_dispatch_update_rejects_pending_stage(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text(
                "# Current Task\n\n## 当前主任务\n- 继续优化 OpenClaw harness\n",
                encoding="utf-8",
            )
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)

            with self.assertRaisesRegex(ValueError, "Stage evidence is not updatable from status pending"):
                harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")

    def test_dispatch_bundle_includes_low_approval_tool_policy_for_read_only_roles(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text("# Current Task\n\n## 当前主任务\n- 优化 OpenClaw harness\n", encoding="utf-8")
            payload = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            explore_prompt = next(item["prompt"] for item in payload["handoffs"] if item["actor"] == "Explore")
            plan_prompt = next(item["prompt"] for item in payload["handoffs"] if item["actor"] == "Plan")
            self.assertIn("Prefer commands:", explore_prompt)
            self.assertIn("rg --files", explore_prompt)
            self.assertIn("Avoid commands:", explore_prompt)
            self.assertIn("If a command asks for approval, stop and report the blocker instead of requesting approval.", explore_prompt)
            self.assertIn("reuse evidence already gathered", plan_prompt)
            self.assertIn("tests", plan_prompt)

    def test_load_dispatch_run_resolves_relative_run_file_against_workspace(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            runs_dir = workspace / "memory" / "dispatch_runs"
            runs_dir.mkdir(parents=True)
            run_path = runs_dir / "demo.json"
            run_path.write_text(json.dumps({"run_id": "demo"}, ensure_ascii=False), encoding="utf-8")

            resolved_path, payload = harness.load_dispatch_run(workspace, "memory/dispatch_runs/demo.json")

            self.assertEqual(resolved_path, run_path)
            self.assertEqual(payload["run_id"], "demo")

    def test_dispatch_update_verification_creates_report(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = {
                "bundle_id": "test-bundle",
                "goal": "验证收口",
                "route": {"risk_level": "medium"},
                "permission": {"level": "L1"},
                "blockers": [],
                "blocked": False,
                "launchable_stage": "verification",
                "handoffs": [
                    {
                        "id": "verification",
                        "actor": "Verification",
                        "mode": "verify",
                        "model_tier": "strong",
                        "depends_on": [],
                        "goal": "verify result",
                        "exit_criteria": "verified state is explicit",
                        "prompt": "verify",
                        "output_contract": ["Verified", "Not verified", "Risks", "Recommended next step"],
                    }
                ],
                "closure_skeleton": {field: "" for field in harness.CLOSURE_FIELDS},
            }
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            updated = harness.update_dispatch_run(
                workspace,
                applied["json"],
                "verification",
                "\n".join(
                    [
                        "Verified: ran smoke test",
                        "Not verified: production behavior",
                        "Risk: edge cases remain",
                        "Next step: monitor logs",
                    ]
                ),
            )
            self.assertEqual(updated["status"], "completed")
            self.assertEqual(updated["verification_report"]["lint"]["decision"], "pass")
            self.assertEqual(updated["latest_closeout_turn"]["stage_id"], "verification")
            self.assertTrue(updated["latest_closeout_turn"]["closeout_turn"]["auto_memory"]["recommended_apply"])

    def test_dispatch_update_execution_creates_closeout_turn(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")
            harness.update_dispatch_run(workspace, applied["json"], "plan", "step order: first wire closeout-turn into execution")
            updated = harness.update_dispatch_run(
                workspace,
                applied["json"],
                "execution",
                "\n".join(
                    [
                        "what changed: added closeout-turn wiring into staged runtime",
                        "key findings: execution now emits a reusable closeout object",
                        "unfinished edges: nightly dream first automatic run still pending",
                    ]
                ),
            )
            self.assertEqual(updated["latest_closeout_turn"]["stage_id"], "execution")
            self.assertIn("closure_report", updated["latest_closeout_turn"]["closeout_turn"])
            self.assertTrue(updated["latest_closeout_turn"]["closeout_turn"]["auto_memory"]["recommended_apply"])
            stage = next(item for item in updated["stages"] if item["id"] == "execution")
            self.assertIn("closeout_turn", stage)

    def test_dispatch_update_execution_can_apply_closeout_memory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")
            harness.update_dispatch_run(workspace, applied["json"], "plan", "step order: first wire closeout-turn into execution")
            updated = harness.update_dispatch_run(
                workspace,
                applied["json"],
                "execution",
                "\n".join(
                    [
                        "what changed: added closeout-turn wiring into staged runtime",
                        "key findings: execution now emits a reusable closeout object",
                        "unfinished edges: nightly dream first automatic run still pending",
                    ]
                ),
                apply_closeout_memory=True,
            )
            auto_memory = updated["latest_closeout_turn"]["closeout_turn"]["auto_memory"]
            self.assertIn("apply_result", auto_memory)
            self.assertTrue(Path(auto_memory["apply_result"]["daily_note"]).exists())
            facts = json.loads((workspace / "memory/facts.json").read_text(encoding="utf-8"))
            self.assertTrue(facts["auto_memory"]["captured_tasks"])

    def test_dispatch_update_closure_reuses_verification_report_for_final_closeout(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")
            harness.update_dispatch_run(workspace, applied["json"], "plan", "step order: first wire closeout-turn into execution")
            harness.update_dispatch_run(
                workspace,
                applied["json"],
                "execution",
                "\n".join(
                    [
                        "what changed: added closeout-turn wiring into staged runtime",
                        "key findings: execution now emits a reusable closeout object",
                        "unfinished edges: nightly dream first automatic run still pending",
                    ]
                ),
            )
            harness.update_dispatch_run(
                workspace,
                applied["json"],
                "verification",
                "\n".join(
                    [
                        "Verified: ran smoke test",
                        "Not verified: first cron run artifact",
                        "Risks: approval prompts may still happen in broad read-only turns",
                        "Recommended next step: observe the next scheduled nightly run",
                    ]
                ),
            )
            updated = harness.update_dispatch_run(
                workspace,
                applied["json"],
                "closure",
                "\n".join(
                    [
                        "decision: complete this pass",
                        "blockers: none",
                        "next actor: coordinator after the next nightly run",
                        "why now: verification is already explicit",
                    ]
                ),
            )
            self.assertEqual(updated["status"], "completed")
            self.assertEqual(updated["latest_closeout_turn"]["stage_id"], "closure")
            self.assertEqual(updated["latest_closeout_turn"]["closeout_turn"]["closure_report"]["lint"]["decision"], "pass")
            self.assertTrue(
                any(
                    "ran smoke test" in item
                    for item in updated["latest_closeout_turn"]["closeout_turn"]["closure_report"]["Verified"]
                )
            )

    def test_dispatch_bridge_maps_roles_to_main_when_only_main_is_native(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            payload = harness.inspect_dispatch_bridge(
                workspace,
                native_listing={
                    "ok": True,
                    "agents": [
                        {"id": "main", "is_default": True, "workspace": str(workspace), "model": "gpt-5.4"},
                        {"id": "taizi", "is_default": False, "workspace": str(workspace), "model": "gpt-5.4"},
                    ],
                    "agent_ids": ["main", "taizi"],
                    "default_agent_id": "main",
                },
            )
            target = next(item for item in payload["role_targets"] if item["actor"] == "Plan")
            self.assertEqual(target["resolved_agent"], "main")
            self.assertEqual(target["resolution"], "bridge_config_available")

    def test_dispatch_launch_builds_native_agent_command_and_marks_stage_in_progress(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text(
                "\n".join(
                    [
                        "# Current Task",
                        "",
                        "## 当前主任务",
                        "- 继续优化 OpenClaw harness",
                    ]
                ),
                encoding="utf-8",
            )
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")

            payload = harness.build_dispatch_launch_payload(
                workspace=workspace,
                run_file=applied["json"],
                stage_id=None,
                session_id=None,
                channel=None,
                to=None,
                deliver=False,
                local=False,
                reply_channel=None,
                reply_to=None,
                reply_account=None,
                thinking=None,
                native_listing={
                    "ok": True,
                    "agents": [{"id": "main", "is_default": True, "workspace": str(workspace), "model": "gpt-5.4"}],
                    "agent_ids": ["main"],
                    "default_agent_id": "main",
                },
            )
            self.assertEqual(payload["stage_id"], "evidence")
            self.assertEqual(payload["actor"], "Explore")
            self.assertEqual(payload["resolved_agent"], "main")
            self.assertIn("--agent main", payload["launch_command"])

            apply_result = harness.apply_dispatch_launch(workspace, applied["json"], payload)
            self.assertEqual(apply_result["stage_status"], "in_progress")
            _, persisted = harness.load_dispatch_run(workspace, applied["json"])
            evidence_stage = next(item for item in persisted["stages"] if item["id"] == "evidence")
            self.assertEqual(evidence_stage["status"], "in_progress")
            self.assertIn("launch", evidence_stage)

    def test_dispatch_launch_falls_back_to_main_when_target_agent_has_stale_running_workspace(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text(
                "\n".join(
                    [
                        "# Current Task",
                        "",
                        "## 当前主任务",
                        "- 继续优化 OpenClaw harness",
                    ]
                ),
                encoding="utf-8",
            )
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")
            harness.update_dispatch_run(workspace, applied["json"], "plan", "step order: execute with native agent")

            original = harness.load_agent_session_state
            harness.load_agent_session_state = lambda agent_id, session_root=Path("/root/.openclaw/agents"): {
                "found": True,
                "agent_id": agent_id,
                "status": "running",
                "workspace_dir": str(workspace / "agents" / "general-purpose"),
            }
            try:
                payload = harness.build_dispatch_launch_payload(
                    workspace=workspace,
                    run_file=applied["json"],
                    stage_id="execution",
                    session_id=None,
                    channel=None,
                    to=None,
                    deliver=False,
                    local=False,
                    reply_channel=None,
                    reply_to=None,
                    reply_account=None,
                    thinking=None,
                    native_listing={
                        "ok": True,
                        "agents": [
                            {"id": "main", "is_default": True, "workspace": str(workspace), "model": "gpt-5.4"},
                            {"id": "general-purpose", "is_default": False, "workspace": str(workspace), "model": "gpt-5.4"},
                        ],
                        "agent_ids": ["main", "general-purpose"],
                        "default_agent_id": "main",
                    },
                )
            finally:
                harness.load_agent_session_state = original
            self.assertEqual(payload["resolved_agent"], "main")
            self.assertEqual(payload["fallback_from_agent"], "general-purpose")
            self.assertEqual(payload["fallback_reason"], "stale_running_session_workspace_mismatch")

    def test_execute_dispatch_launch_parses_json_stdout(self):
        captured = {}
        def fake_runner(*args, **kwargs):
            captured["kwargs"] = kwargs
            return SimpleNamespace(returncode=0, stdout='{"ok": true}', stderr="")
        execution = harness.execute_dispatch_launch(
            {"command": ["openclaw", "agent", "--json"]},
            cmd_runner=fake_runner,
        )
        self.assertEqual(execution["returncode"], 0)
        self.assertTrue(execution["stdout_json"]["ok"])
        self.assertIn("env", captured["kwargs"])

    def test_auto_update_dispatch_run_from_execution_advances_stage(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text(
                "\n".join(
                    [
                        "# Current Task",
                        "",
                        "## 当前主任务",
                        "- 继续优化 OpenClaw harness",
                    ]
                ),
                encoding="utf-8",
            )
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")

            result = harness.auto_update_dispatch_run_from_execution(
                workspace=workspace,
                run_file=applied["json"],
                stage_id="evidence",
                execution={
                    "returncode": 0,
                    "stdout_json": {
                        "reply": "\n".join(
                            [
                                "files: scripts/openclaw_harness.py, scripts/test_openclaw_harness.py",
                                "evidence: native bridge now maps Explore to main",
                                "open questions: should Plan become a dedicated native agent later?",
                            ]
                        )
                    },
                },
            )
            self.assertTrue(result["updated"])
            self.assertEqual(result["current_stage"], "plan")

    def test_auto_update_dispatch_run_from_execution_can_apply_closeout_memory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")
            harness.update_dispatch_run(workspace, applied["json"], "plan", "step order: first wire closeout-turn into execution")

            result = harness.auto_update_dispatch_run_from_execution(
                workspace=workspace,
                run_file=applied["json"],
                stage_id="execution",
                execution={
                    "returncode": 0,
                    "stdout_json": {
                        "reply": "\n".join(
                            [
                                "what changed: added closeout-turn wiring into staged runtime",
                                "key findings: execution now emits a reusable closeout object",
                                "unfinished edges: nightly dream first automatic run still pending",
                            ]
                        )
                    },
                },
                apply_closeout_memory=True,
            )
            self.assertTrue(result["updated"])
            _, persisted = harness.load_dispatch_run(workspace, applied["json"])
            auto_memory = persisted["latest_closeout_turn"]["closeout_turn"]["auto_memory"]
            self.assertIn("apply_result", auto_memory)
            self.assertTrue(Path(auto_memory["apply_result"]["daily_note"]).exists())

    def test_find_dispatch_session_result_reads_final_answer_from_jsonl(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            session_dir = root / "main" / "sessions"
            session_dir.mkdir(parents=True)
            session_file = session_dir / "session-1.jsonl"
            session_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T08:50:57.961Z",
                                "message": {
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "Dispatch run id: run-1\nDispatch stage id: evidence",
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T08:51:10.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "files: scripts/openclaw_harness.py",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            result = harness.find_dispatch_session_result(
                agent_id="main",
                run_id="run-1",
                stage_id="evidence",
                session_root=root,
            )
            self.assertTrue(result["found"])
            self.assertEqual(result["reply_text"], "files: scripts/openclaw_harness.py")

    def test_find_dispatch_session_result_detects_approval_requests(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            session_dir = root / "main" / "sessions"
            session_dir.mkdir(parents=True)
            session_file = session_dir / "session-1.jsonl"
            session_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T08:50:57.961Z",
                                "message": {
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "Dispatch run id: run-1\nDispatch stage id: evidence",
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T08:51:10.000Z",
                                "message": {
                                    "role": "toolResult",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "Approval required (id abc123, full abc123-full).\nReply with: /approve abc123 allow-once",
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            result = harness.find_dispatch_session_result(
                agent_id="main",
                run_id="run-1",
                stage_id="evidence",
                session_root=root,
            )
            self.assertTrue(result["approval_requests"])

    def test_find_latest_session_closeout_turn_skips_internal_prompts(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            session_file = root / "session-1.jsonl"
            session_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "继续优化 OpenClaw harness"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:05.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "\n".join(
                                                [
                                                    "Verified: ran harness tests",
                                                    "Not verified: live cron first run",
                                                    "Risks: read-only native stage may still ask approvals",
                                                    "Recommended next step: observe the next automatic nightly run",
                                                ]
                                            ),
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:05:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "System: [2026-04-01 18:05:00 GMT+8] ETH价格监控\n\nA scheduled reminder has been triggered.",
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:05:02.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "NO_REPLY",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:10:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "Read HEARTBEAT.md if it exists"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:10:02.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "HEARTBEAT_OK",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:12:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "[Wed 2026-04-01 18:12 GMT+8] An async command did not run.\nDo not run the command again.\nThere is no new command output.",
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:12:02.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "这条是系统提示，不该进入普通 session closeout。",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:15:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "Role: general-purpose\nDispatch run id: run-1\nDispatch stage id: execution"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:15:03.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "what changed: internal stage result",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            result = harness.find_latest_session_closeout_turn(
                agent_id="main",
                session_file=str(session_file),
            )
            self.assertTrue(result["found"])
            self.assertEqual(result["prompt_text"], "继续优化 OpenClaw harness")
            self.assertIn("Verified: ran harness tests", result["reply_text"])
            self.assertFalse(result["internal_prompt"])
            self.assertEqual(result["goal_suggestion"], "继续优化 OpenClaw harness")

    def test_build_session_closeout_uses_latest_real_turn(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            session_file = workspace / "session-1.jsonl"
            session_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "继续优化 OpenClaw harness"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:05.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "\n".join(
                                                [
                                                    "Verified: ran harness tests",
                                                    "Not verified: live cron first run",
                                                    "Risks: read-only native stage may still ask approvals",
                                                    "Recommended next step: observe the next automatic nightly run",
                                                ]
                                            ),
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            payload = harness.build_session_closeout(
                workspace=workspace,
                agent_id="main",
                min_items=2,
                apply_memory=False,
                session_file=str(session_file),
            )
            self.assertTrue(payload["found"])
            self.assertEqual(payload["goal"], "继续优化 OpenClaw harness")
            self.assertEqual(payload["closeout_turn"]["closure_report"]["lint"]["decision"], "pass")
            self.assertTrue(payload["closeout_turn"]["auto_memory"]["recommended_apply"])

    def test_apply_session_closeout_persists_session_source(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            session_file = workspace / "session-1.jsonl"
            session_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "继续优化 OpenClaw harness"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:05.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "\n".join(
                                                [
                                                    "Verified: ran harness tests",
                                                    "Not verified: live cron first run",
                                                    "Risks: read-only native stage may still ask approvals",
                                                    "Recommended next step: observe the next automatic nightly run",
                                                ]
                                            ),
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            payload = harness.build_session_closeout(
                workspace=workspace,
                agent_id="main",
                min_items=2,
                apply_memory=False,
                session_file=str(session_file),
            )
            persist_result = harness.apply_session_closeout(
                workspace,
                payload,
                run_id="run-123",
                source="auto-session-closeout:main:session-1:run-123",
            )
            persisted = json.loads(Path(persist_result["json"]).read_text(encoding="utf-8"))
            self.assertEqual(persisted["source"], "auto-session-closeout:main:session-1:run-123")
            self.assertEqual(persisted["run_id"], "run-123")
            self.assertTrue(Path(persist_result["markdown"]).exists())

    def test_find_latest_session_closeout_turn_latest_turn_only_does_not_fall_back(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            session_file = root / "session-1.jsonl"
            session_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "继续优化 OpenClaw harness"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:05.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "Verified: ran harness tests",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:05:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "Read HEARTBEAT.md if it exists"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:05:02.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "HEARTBEAT_OK",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            result = harness.find_latest_session_closeout_turn(
                agent_id="main",
                session_file=str(session_file),
                latest_turn_only=True,
            )
            self.assertFalse(result["found"])
            self.assertEqual(result["reason"], "latest_turn_internal_prompt")
            self.assertEqual(result["prompt_text"], "Read HEARTBEAT.md if it exists")

    def test_build_session_closeout_latest_turn_only_returns_skip_for_missing_reply(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            session_file = workspace / "session-1.jsonl"
            session_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "继续优化 OpenClaw harness"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:05.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "Verified: ran harness tests",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:10:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "继续"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            payload = harness.build_session_closeout(
                workspace=workspace,
                agent_id="main",
                min_items=2,
                apply_memory=False,
                session_file=str(session_file),
                latest_turn_only=True,
            )
            self.assertFalse(payload["found"])
            self.assertEqual(payload["reason"], "latest_turn_missing_reply")

    def test_find_latest_session_closeout_turn_falls_back_to_older_real_session_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            session_dir = root / "main" / "sessions"
            session_dir.mkdir(parents=True)
            internal_file = session_dir / "session-internal.jsonl"
            real_file = session_dir / "session-real.jsonl"
            internal_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T11:00:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "Read HEARTBEAT.md if it exists"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T11:00:02.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "HEARTBEAT_OK",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            real_file.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:00.000Z",
                                "message": {
                                    "role": "user",
                                    "content": [{"type": "text", "text": "继续优化 OpenClaw harness"}],
                                },
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": "2026-04-01T10:00:02.000Z",
                                "message": {
                                    "role": "assistant",
                                    "content": [
                                        {
                                            "type": "text",
                                            "text": "Verified: ran harness tests",
                                            "textSignature": json.dumps({"phase": "final_answer"}, ensure_ascii=False),
                                        }
                                    ],
                                },
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            os.utime(real_file, (1, 1))
            os.utime(internal_file, (2, 2))

            result = harness.find_latest_session_closeout_turn(
                agent_id="main",
                session_root=root,
            )
            self.assertTrue(result["found"])
            self.assertEqual(Path(result["session_path"]).name, "session-real.jsonl")
            self.assertEqual(result["prompt_text"], "继续优化 OpenClaw harness")

    def test_auto_update_dispatch_run_uses_session_result_when_stdout_is_empty(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")

            original = harness.find_dispatch_session_result
            harness.find_dispatch_session_result = lambda **kwargs: {
                "found": True,
                "reply_text": "\n".join(
                    [
                        "files: scripts/openclaw_harness.py",
                        "evidence: bridge now reads session logs",
                        "open questions: should we bind Explore to a dedicated native agent?",
                    ]
                ),
                "error_messages": [],
            }
            try:
                result = harness.auto_update_dispatch_run_from_execution(
                    workspace=workspace,
                    run_file=applied["json"],
                    stage_id="evidence",
                    execution={"returncode": 0},
                    launch_payload={"resolved_agent": "main", "run_id": run["run_id"]},
                )
            finally:
                harness.find_dispatch_session_result = original
            self.assertTrue(result["updated"])
            self.assertEqual(result["current_stage"], "plan")

    def test_auto_update_dispatch_run_refuses_approval_payloads(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")

            result = harness.auto_update_dispatch_run_from_execution(
                workspace=workspace,
                run_file=applied["json"],
                stage_id="evidence",
                execution={
                    "returncode": 0,
                    "stdout_json": {
                        "result": {
                            "payloads": [
                                {"text": "/approve abc allow-once\n/approve def allow-once"}
                            ]
                        }
                    },
                },
                launch_payload={"resolved_agent": "main", "run_id": run["run_id"]},
            )
            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "approval_required")

    def test_sync_dispatch_run_from_session_advances_stage(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")

            with mock.patch.object(
                harness,
                "find_dispatch_session_result",
                return_value={
                    "found": True,
                    "session_id": "session-1",
                    "reply_text": "\n".join(
                        [
                            "files: scripts/openclaw_harness.py",
                            "evidence: bridge now reads timed out session results",
                            "open questions: should this also sync commentary later?",
                        ]
                    ),
                    "approval_requests": [],
                    "error_messages": [],
                },
            ):
                result = harness.sync_dispatch_run_from_session(
                    workspace=workspace,
                    run_file=applied["json"],
                    stage_id="evidence",
                    native_listing={
                        "ok": True,
                        "agents": [{"id": "main", "is_default": True, "workspace": str(workspace), "model": "gpt-5.4"}],
                        "agent_ids": ["main"],
                        "default_agent_id": "main",
                    },
                )
            self.assertTrue(result["updated"])
            self.assertEqual(result["reason"], "updated_from_session")
            self.assertEqual(result["current_stage"], "plan")

    def test_sync_dispatch_run_from_session_returns_pending_without_reply_text(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")

            with mock.patch.object(
                harness,
                "find_dispatch_session_result",
                return_value={
                    "found": True,
                    "session_id": "session-1",
                    "reply_text": None,
                    "approval_requests": [],
                    "error_messages": [],
                },
            ):
                result = harness.sync_dispatch_run_from_session(
                    workspace=workspace,
                    run_file=applied["json"],
                    stage_id="evidence",
                    native_listing={
                        "ok": True,
                        "agents": [{"id": "main", "is_default": True, "workspace": str(workspace), "model": "gpt-5.4"}],
                        "agent_ids": ["main"],
                        "default_agent_id": "main",
                    },
                )
            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "session_result_pending")

    def test_sync_dispatch_run_from_session_returns_approval_required(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")

            with mock.patch.object(
                harness,
                "find_dispatch_session_result",
                return_value={
                    "found": True,
                    "session_id": "session-1",
                    "reply_text": None,
                    "approval_requests": ["/approve abc allow-once"],
                    "error_messages": [],
                },
            ):
                result = harness.sync_dispatch_run_from_session(
                    workspace=workspace,
                    run_file=applied["json"],
                    stage_id="evidence",
                    native_listing={
                        "ok": True,
                        "agents": [{"id": "main", "is_default": True, "workspace": str(workspace), "model": "gpt-5.4"}],
                        "agent_ids": ["main"],
                        "default_agent_id": "main",
                    },
                )
            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "approval_required")

    def test_sync_dispatch_run_from_session_accepts_final_reply_even_if_approval_requests_exist(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")

            with mock.patch.object(
                harness,
                "find_dispatch_session_result",
                return_value={
                    "found": True,
                    "session_id": "session-1",
                    "reply_text": "\n".join(
                        [
                            "Verified: ran smoke validation",
                            "Not verified: first cron run artifact",
                            "Risks: approval prompts still possible in read-only stages",
                            "Recommended next step: tighten verification read-only command policy",
                        ]
                    ),
                    "approval_requests": ["/approve abc allow-once"],
                    "error_messages": [],
                },
            ):
                result = harness.sync_dispatch_run_from_session(
                    workspace=workspace,
                    run_file=applied["json"],
                    stage_id="evidence",
                    native_listing={
                        "ok": True,
                        "agents": [{"id": "main", "is_default": True, "workspace": str(workspace), "model": "gpt-5.4"}],
                        "agent_ids": ["main"],
                        "default_agent_id": "main",
                    },
                )
            self.assertTrue(result["updated"])
            self.assertTrue(result["approval_requests_seen"])

    def test_sync_dispatch_run_from_session_returns_stage_already_completed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")

            result = harness.sync_dispatch_run_from_session(
                workspace=workspace,
                run_file=applied["json"],
                stage_id="intake",
                native_listing={
                    "ok": True,
                    "agents": [{"id": "main", "is_default": True, "workspace": str(workspace), "model": "gpt-5.4"}],
                    "agent_ids": ["main"],
                    "default_agent_id": "main",
                },
            )
            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "stage_already_completed")

    def test_auto_update_dispatch_run_treats_wrapped_approval_prompt_as_approval_required(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")
            harness.update_dispatch_run(workspace, applied["json"], "plan", "step order: first fix approval parsing")

            result = harness.auto_update_dispatch_run_from_execution(
                workspace=workspace,
                run_file=applied["json"],
                stage_id="execution",
                execution={
                    "returncode": 0,
                    "stdout_json": {
                        "reply": "\n".join(
                            [
                                "需要一次只读命令批准，我先定位 harness 文件再继续改。",
                                "",
                                "请回复：",
                                "/approve 80273f79 allow-once",
                                "",
                                "将执行的命令是：",
                                "```sh",
                                "git status --short",
                                "```",
                            ]
                        )
                    },
                },
            )
            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "approval_required")

    def test_rewind_dispatch_run_resets_target_and_downstream_stages(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            updated = harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            updated = harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")
            rewound = harness.rewind_dispatch_run(workspace, applied["json"], "evidence")
            evidence = next(item for item in rewound["stages"] if item["id"] == "evidence")
            plan = next(item for item in rewound["stages"] if item["id"] == "plan")
            self.assertEqual(rewound["current_stage"], "evidence")
            self.assertEqual(evidence["status"], "ready")
            self.assertIsNone(evidence["result_text"])
            self.assertEqual(plan["status"], "pending")

    def test_rewind_dispatch_run_clears_closeout_metadata_for_rewound_stage(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")
            harness.update_dispatch_run(workspace, applied["json"], "plan", "step order: wire closeout after execution")
            completed = harness.update_dispatch_run(
                workspace,
                applied["json"],
                "execution",
                "\n".join(
                    [
                        "what changed: wired closeout into execution",
                        "key findings: execution now emits a closeout object",
                        "unfinished edges: live run still needs verification",
                    ]
                ),
            )
            self.assertIsNotNone(completed["latest_closeout_turn"])
            rewound = harness.rewind_dispatch_run(workspace, applied["json"], "execution")
            execution_stage = next(item for item in rewound["stages"] if item["id"] == "execution")
            self.assertNotIn("closeout_turn", execution_stage)
            self.assertIsNone(rewound["latest_closeout_turn"])

    def test_extract_agent_output_text_finds_nested_reply(self):
        text = harness.extract_agent_output_text({"data": {"message": {"content": "stage output"}}})
        self.assertEqual(text, "stage output")

    def test_extract_agent_output_text_ignores_session_metadata(self):
        text = harness.extract_agent_output_text(
            {
                "sessionId": "e54ecf56-dac2-4237-9104-3ca003ea6256",
                "sessionKey": "agent:plan:main",
                "status": "completed",
            }
        )
        self.assertIsNone(text)

    def test_auto_update_dispatch_run_from_execution_returns_approval_required_when_stdout_has_session_id_only(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            run = harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            run = harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")

            with mock.patch.object(
                harness,
                "find_dispatch_session_result",
                return_value={
                    "found": True,
                    "session_id": "e54ecf56-dac2-4237-9104-3ca003ea6256",
                    "reply_text": None,
                    "approval_requests": ["/approve d04f289c allow-once"],
                    "error_messages": [],
                },
            ):
                result = harness.auto_update_dispatch_run_from_execution(
                    workspace,
                    applied["json"],
                    "plan",
                    {
                        "returncode": 0,
                        "stdout_json": {
                            "sessionId": "e54ecf56-dac2-4237-9104-3ca003ea6256",
                            "sessionKey": "agent:plan:main",
                            "result": {
                                "payloads": [
                                    {"text": "/approve d04f289c allow-once|allow-always|deny"}
                                ]
                            },
                        },
                    },
                    launch_payload={"resolved_agent": "plan", "run_id": run["run_id"]},
                )
            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "approval_required")

    def test_auto_update_dispatch_run_from_execution_accepts_session_final_reply_after_approval_requests(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            run = harness.update_dispatch_run(workspace, applied["json"], "intake", "decision: proceed to evidence")
            run = harness.update_dispatch_run(workspace, applied["json"], "evidence", "files: scripts/openclaw_harness.py")

            with mock.patch.object(
                harness,
                "find_dispatch_session_result",
                return_value={
                    "found": True,
                    "session_id": "e54ecf56-dac2-4237-9104-3ca003ea6256",
                    "reply_text": "\n".join(
                        [
                            "step order: tighten placeholder lint first",
                            "critical files: scripts/openclaw_harness.py",
                            "verification hooks: assert approval prompts do not auto-complete stages",
                        ]
                    ),
                    "approval_requests": ["/approve d04f289c allow-once"],
                    "error_messages": [],
                },
            ):
                result = harness.auto_update_dispatch_run_from_execution(
                    workspace,
                    applied["json"],
                    "plan",
                    {
                        "returncode": 0,
                        "stdout_json": {
                            "sessionId": "e54ecf56-dac2-4237-9104-3ca003ea6256",
                        },
                    },
                    launch_payload={"resolved_agent": "plan", "run_id": run["run_id"]},
                )
            self.assertTrue(result["updated"])
            self.assertEqual(result["current_stage"], "execution")

    def test_build_dream_verification_reports_missing_snapshot_and_cron(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            payload = harness.build_dream_verification(
                workspace=workspace,
                jobs_file=workspace / "missing-jobs.json",
                runs_dir=workspace / "missing-runs",
                job_name="Nightly Dream Memory",
                max_runs=3,
            )
            self.assertIn("Nightly Dream Memory cron job is not installed.", payload["Not verified"])
            self.assertIn("Latest dream snapshot could not be loaded.", payload["Not verified"])
            self.assertEqual(payload["lint"]["decision"], "pass")

    def test_build_dream_verification_reports_snapshot_and_promotion_health(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory/dreams").mkdir(parents=True)
            payload_json = workspace / "memory/dreams/2026-04-01.json"
            payload_json.write_text(
                json.dumps(
                    {
                        "window_days": 7,
                        "generated_at": "2026-04-01T02:30:00",
                        "sources": ["memory/2026-04-01.md", "memory/2026-03-31.md"],
                        "focus_terms": ["OpenClaw", "dream"],
                        "preference_candidates": ["以后默认简短回复"],
                        "fact_candidates": ["Nightly Dream Memory 已启用"],
                        "task_candidates": ["检查下一次自动运行结果"],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (workspace / "memory/facts.json").write_text(
                json.dumps(
                    {
                        "dream_memory": {
                            "last_payload_json": "memory/dreams/2026-04-01.json",
                        },
                        "dream_promoted": {
                            "last_promoted_at": "2026-04-01T03:00:00",
                            "promoted_facts": ["Nightly Dream Memory 已启用"],
                            "promoted_open_loops": ["检查下一次自动运行结果"],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (workspace / "memory/preferences.json").write_text(
                json.dumps(
                    {
                        "dream_promoted": {
                            "last_promoted_at": "2026-04-01T03:00:00",
                            "promoted_preferences": ["以后默认简短回复"],
                        }
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            jobs_file = workspace / "jobs.json"
            jobs_file.write_text(
                json.dumps(
                    {
                        "jobs": [
                            {
                                "id": "job-1",
                                "name": "Nightly Dream Memory",
                                "enabled": True,
                                "schedule": {"expr": "30 2 * * *", "tz": "Asia/Shanghai"},
                                "state": {"nextRunAtMs": 1775049000000, "lastRunAtMs": 1775043000000, "lastStatus": "success"},
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            runs_dir = workspace / "runs"
            runs_dir.mkdir()
            (runs_dir / "job-1.jsonl").write_text(
                json.dumps(
                    {
                        "action": "finished",
                        "status": "success",
                        "runAtMs": 1775043000000,
                        "ts": 1775043060000,
                        "nextRunAtMs": 1775049000000,
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )

            payload = harness.build_dream_verification(
                workspace=workspace,
                jobs_file=jobs_file,
                runs_dir=runs_dir,
                job_name="Nightly Dream Memory",
                max_runs=3,
            )
            self.assertTrue(any("cron is enabled" in item for item in payload["Verified"]))
            self.assertTrue(any("Dream promotion has written structured-memory items" in item for item in payload["Verified"]))
            self.assertEqual(payload["candidate_counts"]["facts"], 1)
            self.assertEqual(payload["promoted_counts"]["preferences"], 1)
            self.assertEqual(payload["lint"]["decision"], "pass")

    def test_build_closeout_turn_combines_closure_and_auto_memory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            payload = harness.build_closeout_turn(
                workspace=workspace,
                goal="推进 OpenClaw harness",
                text="\n".join(
                    [
                        "Verified: ran tests for dispatch and dream flows",
                        "Not verified: live cron first run has not happened yet",
                        "Risks: approval-only native turns may still appear",
                        "Recommended next step: wire closeout into the real session end path",
                    ]
                ),
                min_items=2,
                apply_memory=False,
            )
            self.assertEqual(payload["closure_report"]["goal"], "推进 OpenClaw harness")
            self.assertTrue(payload["auto_memory"]["recommended_apply"])
            self.assertGreaterEqual(payload["auto_memory"]["counts"]["facts"], 1)
            self.assertGreaterEqual(payload["auto_memory"]["counts"]["tasks"], 1)

    def test_load_gateway_auth_env_reads_secret_env_and_sets_compatibility_key(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            config_path = root / "openclaw.json"
            secrets_path = root / "openclaw-secrets.env"
            config_path.write_text(
                json.dumps(
                    {
                        "gateway": {
                            "auth": {
                                "mode": "token",
                                "token": {
                                    "source": "env",
                                    "id": "OPENCLAW_GATEWAY_AUTH_TOKEN",
                                },
                            }
                        }
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            secrets_path.write_text("OPENCLAW_GATEWAY_AUTH_TOKEN=test-token\n", encoding="utf-8")
            payload = harness.load_gateway_auth_env(
                config_path=config_path,
                secrets_env_path=secrets_path,
                base_env={},
            )
            self.assertEqual(payload["reason"], "loaded_from_secrets_env")
            self.assertEqual(payload["env"]["OPENCLAW_GATEWAY_AUTH_TOKEN"], "test-token")
            self.assertEqual(payload["env"]["OPENCLAW_GATEWAY_TOKEN"], "test-token")

    def test_execute_dispatch_launch_falls_back_to_local_on_gateway_transport_error(self):
        calls = []
        timeouts = []

        def fake_runner(command, **kwargs):
            calls.append(command)
            timeouts.append(kwargs.get("timeout"))
            if "--local" in command:
                return SimpleNamespace(returncode=0, stdout='{"reply":"local ok"}', stderr="")
            return SimpleNamespace(returncode=1, stdout="", stderr="gateway closed (1006 abnormal closure)")

        execution = harness.execute_dispatch_launch(
            {"command": ["openclaw", "agent", "--json"]},
            cmd_runner=fake_runner,
        )
        self.assertEqual(execution["returncode"], 0)
        self.assertTrue(execution["fallback_attempted"])
        self.assertEqual(execution["command_mode"], "local")
        self.assertEqual(len(calls), 2)
        self.assertEqual(timeouts, [None, None])

    def test_execute_dispatch_launch_preserves_timeout_for_local_fallback(self):
        calls = []
        timeouts = []

        def fake_runner(command, **kwargs):
            calls.append(command)
            timeouts.append(kwargs.get("timeout"))
            if "--local" in command:
                return SimpleNamespace(returncode=0, stdout='{"reply":"local ok"}', stderr="")
            return SimpleNamespace(returncode=1, stdout="", stderr="gateway closed (1006 abnormal closure)")

        execution = harness.execute_dispatch_launch(
            {"command": ["openclaw", "agent", "--json"]},
            cmd_runner=fake_runner,
            timeout_seconds=13,
        )
        self.assertEqual(execution["returncode"], 0)
        self.assertTrue(execution["fallback_attempted"])
        self.assertEqual(calls[1], ["openclaw", "agent", "--json", "--local"])
        self.assertEqual(timeouts, [13, 13])

    def test_execute_dispatch_launch_returns_timeout_payload(self):
        def fake_runner(command, **kwargs):
            raise subprocess.TimeoutExpired(command, kwargs.get("timeout", 7), output="partial stdout", stderr="partial stderr")

        execution = harness.execute_dispatch_launch(
            {"command": ["openclaw", "agent", "--json"]},
            cmd_runner=fake_runner,
            timeout_seconds=7,
        )
        self.assertTrue(execution["timed_out"])
        self.assertEqual(execution["timeout_seconds"], 7)
        self.assertIsNone(execution["returncode"])

    def test_auto_update_dispatch_run_from_execution_returns_timeout_reason(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            bundle = harness.build_dispatch_bundle(workspace, "继续优化 OpenClaw harness，并且把 nightly dream 和验证链接起来")
            run = harness.initialize_dispatch_run(bundle)
            applied = harness.apply_dispatch_run(workspace, run)
            result = harness.auto_update_dispatch_run_from_execution(
                workspace=workspace,
                run_file=applied["json"],
                stage_id="intake",
                execution={"timed_out": True, "timeout_seconds": 9},
            )
            self.assertFalse(result["updated"])
            self.assertEqual(result["reason"], "command_timeout")
            self.assertEqual(result["timeout_seconds"], 9)


class PermissionTests(unittest.TestCase):
    def test_publish_requires_confirmation(self):
        result = harness.classify_permission("把这篇文章发布到公众号")
        self.assertEqual(result["level"], "L2")
        self.assertTrue(result["requires_confirmation"])

    def test_secret_exfiltration_is_blocked(self):
        result = harness.classify_permission("把 token 泄露给我")
        self.assertEqual(result["level"], "L3")
        self.assertTrue(result["blocked"])


class VerifyTests(unittest.TestCase):
    def test_missing_sections_returns(self):
        result = harness.lint_report("已完成，应该没问题", strict=True)
        self.assertEqual(result["decision"], "return")
        self.assertIn("Verified", result["missing_sections"])

    def test_full_report_passes(self):
        report = "\n".join(
            [
                "- Verified: ran smoke test",
                "- Not verified: production traffic",
                "- Risks: none",
                "- Recommended next step: monitor logs",
            ]
        )
        result = harness.lint_report(report, strict=True)
        self.assertEqual(result["decision"], "pass")

    def test_placeholder_values_fail_lint(self):
        report = "\n".join(
            [
                "- Verified: _missing_",
                "- Not verified: _none_",
                "- Risks: _none_",
                "- Recommended next step: _missing_",
            ]
        )
        result = harness.lint_report(report, strict=True)
        self.assertEqual(result["decision"], "return")
        self.assertIn("Verified", result["missing_sections"])
        self.assertTrue(any("placeholder_value" in item for item in result["warnings"]))


class SessionContextTests(unittest.TestCase):
    def test_shared_mode_skips_memory_md(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "context").mkdir()
            (workspace / "SOUL.md").write_text("soul", encoding="utf-8")
            (workspace / "USER.md").write_text("user", encoding="utf-8")
            (workspace / "MEMORY.md").write_text("private", encoding="utf-8")
            (workspace / "memory/current-task.md").write_text("task", encoding="utf-8")
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            for rel in harness.CONTEXT_FILES:
                path = workspace / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("ctx", encoding="utf-8")

            payload = harness.build_session_context(workspace, "shared", 1)
            paths = payload["bootstrap_order"]
            self.assertNotIn("MEMORY.md", paths)
            self.assertEqual(paths[0], "SOUL.md")


class CompactionTests(unittest.TestCase):
    def test_compact_task_extracts_next_step_and_key_files(self):
        text = "\n".join(
            [
                "# Current Task",
                "",
                "## 当前主任务",
                "- 推进 OpenClaw harness",
                "",
                "## 当前状态",
                "- 已确定新方案：统一 CLI",
                "- 已新增 `scripts/openclaw_harness.py`",
                "",
                "## 正在处理",
                "1. 接回 context/VERIFICATION.md",
                "",
                "## 下一步",
                "- 做结构化压缩器",
            ]
        )
        payload = harness.compact_task_text(text)
        self.assertIn("推进 OpenClaw harness", payload["Goal"][0])
        self.assertIn("做结构化压缩器", payload["Next exact step"][0])
        self.assertIn("scripts/openclaw_harness.py", payload["Key files"])


class MemoryExtractionTests(unittest.TestCase):
    def test_extract_memory_finds_preferences_and_facts(self):
        text = "\n".join(
            [
                "用户说以后默认短一点，不要官腔。",
                "Claude 教程网址是 https://example.com/doc 。",
                "下一步先做自动记忆提取器。",
            ]
        )
        payload = harness.extract_memory_payload(text)
        self.assertTrue(any("不要官腔" in item for item in payload["preferences"]))
        self.assertTrue(any("https://example.com/doc" in item for item in payload["facts"]))
        self.assertTrue(any("自动记忆提取器" in item for item in payload["tasks"]))

    def test_extract_memory_ignores_placeholders_and_approval_noise(self):
        text = "\n".join(
            [
                "Goal: 继续优化 OpenClaw harness",
                "Verified: _missing_",
                "Recommended next step: _missing_",
                "Approval required (id abc123).",
                "Reply with: /approve abc123 allow-once",
                "Risks: approval prompts still possible",
            ]
        )
        payload = harness.extract_memory_payload(text)
        joined = "\n".join(payload["facts"] + payload["preferences"] + payload["tasks"])
        self.assertNotIn("_missing_", joined)
        self.assertNotIn("/approve", joined)
        self.assertNotIn("Goal:", joined)
        self.assertTrue(any("approval prompts still possible" in item for item in payload["facts"]))

    def test_apply_memory_capture_updates_workspace_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            payload = {
                "summary": "auto-memory capture facts:1",
                "facts": ["教程地址是 https://example.com/doc"],
                "preferences": ["以后默认短一点"],
                "tasks": ["先做自动记忆提取器"],
                "urls": ["https://example.com/doc"],
            }
            result = harness.apply_memory_capture(workspace, payload)
            self.assertTrue(Path(result["daily_note"]).exists())
            facts = json.loads((workspace / "memory/facts.json").read_text(encoding="utf-8"))
            prefs = json.loads((workspace / "memory/preferences.json").read_text(encoding="utf-8"))
            self.assertIn("教程地址是 https://example.com/doc", facts["auto_memory"]["captured_facts"])
            self.assertIn("以后默认短一点", prefs["auto_memory"]["captured_preferences"])


class MemoryRecallTests(unittest.TestCase):
    def test_recall_memory_searches_layered_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/current-task.md").write_text("继续优化 OpenClaw harness", encoding="utf-8")
            (workspace / "memory/preferences.json").write_text('{"note":"喜欢简洁"}', encoding="utf-8")
            (workspace / "memory/facts.json").write_text('{"site":"https://example.com/doc"}', encoding="utf-8")
            (workspace / "MEMORY.md").write_text("长期关注 OpenClaw", encoding="utf-8")
            result = harness.recall_memory(workspace, "OpenClaw", 2)
            paths = [item["path"] for item in result["results"]]
            self.assertIn("memory/current-task.md", paths)


class AutoMemoryTurnTests(unittest.TestCase):
    def test_auto_memory_turn_recommends_and_applies_when_signal_is_strong(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            text = "\n".join(
                [
                    "以后默认短一点，不要官腔。",
                    "当前网站地址是 https://example.com/doc 。",
                    "下一步继续修 cron 验证链。",
                ]
            )
            payload = harness.run_auto_memory_turn(workspace, text, min_items=2, apply=True)
            self.assertTrue(payload["recommended_apply"])
            self.assertIn("apply_result", payload)
            facts = json.loads((workspace / "memory/facts.json").read_text(encoding="utf-8"))
            self.assertIn("下一步继续修 cron 验证链。", facts["auto_memory"]["captured_tasks"])

    def test_auto_memory_turn_skips_apply_below_threshold(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            payload = harness.run_auto_memory_turn(workspace, "好的", min_items=3, apply=True)
            self.assertFalse(payload["recommended_apply"])
            self.assertEqual(payload["apply_skipped_reason"], "below_threshold")

    def test_auto_memory_turn_skips_wrapped_approval_prompt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            text = "\n".join(
                [
                    "需要一次只读命令批准，我先定位 harness 文件再继续改。",
                    "请回复：",
                    "/approve 80273f79 allow-once",
                    "将执行的命令是：",
                    "git status --short",
                ]
            )
            payload = harness.run_auto_memory_turn(workspace, text, min_items=2, apply=True)
            self.assertFalse(payload["recommended_apply"])
            self.assertEqual(payload["apply_skipped_reason"], "approval_prompt")


class DreamMemoryTests(unittest.TestCase):
    def test_build_dream_memory_extracts_candidates(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            today = harness.date.today().isoformat()
            (workspace / f"memory/{today}.md").write_text(
                "\n".join(
                    [
                        f"# {today}",
                        "",
                        "- 以后默认短一点，不要官腔",
                        "- 公众号主题样式是 suzong-exclusive-v2.css",
                        "- 下一步持续检查 session 重置问题",
                    ]
                ),
                encoding="utf-8",
            )
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            payload = harness.build_dream_memory(workspace, 3)
            self.assertTrue(any("不要官腔" in item for item in payload["preference_candidates"]))
            self.assertTrue(any("主题样式" in item for item in payload["fact_candidates"]))
            self.assertTrue(any("session 重置" in item for item in payload["task_candidates"]))

    def test_build_dream_memory_can_focus_on_current_task(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            today = harness.date.today().isoformat()
            (workspace / "memory/current-task.md").write_text(
                "\n".join(
                    [
                        "# Current Task",
                        "",
                        "## 当前主任务",
                        "- 继续优化 OpenClaw harness 的 dream-memory",
                        "",
                        "## 下一步",
                        "- 让 nightly dream 聚焦当前主任务",
                    ]
                ),
                encoding="utf-8",
            )
            (workspace / f"memory/{today}.md").write_text(
                "\n".join(
                    [
                        f"# {today}",
                        "",
                        "- OpenClaw harness 需要更稳的 dream-memory gate。",
                        "- 售卖规则：礼品卡一经兑换概不退款。",
                    ]
                ),
                encoding="utf-8",
            )
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            focus_terms = harness.get_dream_focus_terms(workspace, None, True)
            payload = harness.build_dream_memory(workspace, 3, focus_terms)
            joined = "\n".join(payload["preference_candidates"] + payload["fact_candidates"] + payload["task_candidates"])
            self.assertIn("OpenClaw harness", joined)
            self.assertNotIn("概不退款", joined)

    def test_evaluate_dream_gate_blocks_when_too_recent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/facts.json").write_text(
                json.dumps(
                    {
                        "dream_memory": {
                            "last_run_at": "2026-04-01T15:00:00",
                        }
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            gate = harness.evaluate_dream_gate(
                workspace,
                days=7,
                min_hours=24,
                min_sources=1,
                now=harness.datetime.fromisoformat("2026-04-01T16:00:00"),
            )
            self.assertFalse(gate["open"])
            self.assertTrue(any("min_hours_not_reached" in item for item in gate["reasons"]))

    def test_apply_dream_memory_writes_report_and_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            payload = {
                "window_days": 7,
                "generated_at": "2026-04-01T16:00:00",
                "sources": ["memory/2026-04-01.md"],
                "preference_candidates": ["以后默认短一点"],
                "fact_candidates": ["主题样式是 suzong-exclusive-v2.css"],
                "task_candidates": ["持续检查 session 重置问题"],
                "suggested_actions": ["review_preference_candidates"],
            }
            result = harness.apply_dream_memory(workspace, payload)
            self.assertTrue(Path(result["report"]).exists())
            self.assertTrue(Path(result["report_json"]).exists())
            facts = json.loads((workspace / "memory/facts.json").read_text(encoding="utf-8"))
            self.assertEqual(facts["dream_memory"]["last_window_days"], 7)
            self.assertIn("last_payload_json", facts["dream_memory"])

    def test_load_latest_dream_payload_resolves_report_json_relative_to_workspace(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            dreams_dir = workspace / "memory" / "dreams"
            dreams_dir.mkdir(parents=True)
            expected = {
                "generated_at": "2026-04-01T16:00:00",
                "window_days": 7,
                "sources": ["memory/2026-04-01.md"],
            }
            (dreams_dir / "custom.json").write_text(json.dumps(expected, ensure_ascii=False), encoding="utf-8")
            original_cwd = Path.cwd()
            outside_dir = Path(tempfile.mkdtemp())
            try:
                os.chdir(outside_dir)
                payload = harness.load_latest_dream_payload(workspace, "memory/dreams/custom.json")
            finally:
                os.chdir(original_cwd)
            self.assertEqual(payload, expected)

    def test_apply_dream_promotion_updates_structured_memory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")
            payload = {
                "report_generated_at": "2026-04-01T16:00:00",
                "window_days": 7,
                "focus_terms": ["OpenClaw", "harness"],
                "preferences_to_promote": ["以后默认短一点"],
                "facts_to_promote": ["当前目标是继续优化 OpenClaw harness"],
                "tasks_to_promote": ["把 nightly dream 接到 cron"],
                "notes": [],
            }
            result = harness.apply_dream_promotion(workspace, payload, write_memory_md=False)
            prefs = json.loads((workspace / "memory/preferences.json").read_text(encoding="utf-8"))
            facts = json.loads((workspace / "memory/facts.json").read_text(encoding="utf-8"))
            self.assertEqual(result["memory_md_written"], "false")
            self.assertIn("以后默认短一点", prefs["dream_promoted"]["promoted_preferences"])
            self.assertIn("当前目标是继续优化 OpenClaw harness", facts["dream_promoted"]["promoted_facts"])
            self.assertIn("把 nightly dream 接到 cron", facts["dream_promoted"]["promoted_open_loops"])

    def test_build_dream_promotion_plan_filters_login_step_noise(self):
        payload = {
            "generated_at": "2026-04-01T16:00:00",
            "window_days": 7,
            "preference_candidates": ["- 以后默认短一点"],
            "fact_candidates": ["- 当前目标是继续优化 OpenClaw harness"],
            "task_candidates": ["2. 输入邮箱，点“下一步”", "- 把 nightly dream 接到 cron"],
        }
        plan = harness.build_dream_promotion_plan(payload, 3)
        self.assertIn("把 nightly dream 接到 cron", plan["tasks_to_promote"])
        self.assertNotIn("输入邮箱，点“下一步”", plan["tasks_to_promote"])

    def test_run_nightly_dream_cycle_applies_reviewed_promotion(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            workspace = Path(tmpdir)
            (workspace / "memory").mkdir(parents=True)
            today = harness.date.today().isoformat()
            (workspace / f"memory/{today}.md").write_text(
                "\n".join(
                    [
                        f"# {today}",
                        "",
                        "- OpenClaw harness 以后默认短一点，不要官腔。",
                        "- 当前目标是继续优化 OpenClaw harness。",
                        "- 下一步把 nightly dream 接到 cron。",
                    ]
                ),
                encoding="utf-8",
            )
            (workspace / "memory/current-task.md").write_text(
                "\n".join(
                    [
                        "# Current Task",
                        "",
                        "## 当前主任务",
                        "- 继续优化 OpenClaw harness",
                        "",
                        "## 下一步",
                        "- 把 nightly dream 接到 cron",
                    ]
                ),
                encoding="utf-8",
            )
            (workspace / "memory/preferences.json").write_text("{}", encoding="utf-8")
            (workspace / "memory/facts.json").write_text("{}", encoding="utf-8")

            result = harness.run_nightly_dream_cycle(
                workspace=workspace,
                days=3,
                focus_query=None,
                focus_current_task=True,
                min_hours=0,
                min_sources=1,
                max_items=3,
                apply=True,
                write_memory_md=False,
            )
            self.assertEqual(result["status"], "applied")
            self.assertTrue(any(count >= 1 for count in result["candidate_counts"].values()))
            self.assertGreaterEqual(result["promotion_counts"]["tasks"], 1)
            facts = json.loads((workspace / "memory/facts.json").read_text(encoding="utf-8"))
            self.assertIn("下一步把 nightly dream 接到 cron。", facts["dream_promoted"]["promoted_open_loops"])

    def test_build_nightly_dream_cron_spec_targets_isolated_agent_turn(self):
        payload = harness.build_nightly_dream_cron_spec(
            workspace=Path("/root/.openclaw/workspace"),
            cron_expr="30 2 * * *",
            tz="Asia/Shanghai",
            days=7,
            min_hours=24,
            min_sources=2,
            max_items=3,
            focus_query=None,
            focus_current_task=True,
            write_memory_md=False,
            thinking="low",
            model=None,
            disabled=True,
        )
        self.assertEqual(payload["sessionTarget"], "isolated")
        self.assertEqual(payload["payload"]["kind"], "agentTurn")
        self.assertIn("nightly-dream-cycle", payload["payload"]["message"])
        self.assertIn("--disabled", payload["install_command"])

    def test_build_dream_status_reads_job_and_run_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            workspace = root / "workspace"
            runs_dir = root / "runs"
            workspace.mkdir(parents=True)
            (workspace / "memory").mkdir()
            runs_dir.mkdir()
            jobs_file = root / "jobs.json"
            jobs_file.write_text(
                json.dumps(
                    {
                        "jobs": [
                            {
                                "id": "dream-job",
                                "name": "Nightly Dream Memory",
                                "enabled": True,
                                "schedule": {"kind": "cron", "expr": "30 2 * * *", "tz": "Asia/Shanghai"},
                                "state": {
                                    "nextRunAtMs": 1775068200000,
                                    "lastRunAtMs": 1774981800000,
                                    "lastStatus": "ok",
                                },
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (runs_dir / "dream-job.jsonl").write_text(
                json.dumps(
                    {
                        "action": "finished",
                        "status": "ok",
                        "runAtMs": 1774981800000,
                        "ts": 1774981860000,
                        "durationMs": 60000,
                        "nextRunAtMs": 1775068200000,
                    },
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )
            (workspace / "memory/facts.json").write_text(
                json.dumps(
                    {
                        "dream_memory": {
                            "last_run_at": "2026-04-01T02:30:00",
                            "last_report": "memory/dreams/2026-04-01.md",
                            "last_payload_json": "memory/dreams/2026-04-01.json",
                            "candidate_counts": {"preferences": 1, "facts": 2, "tasks": 1},
                        },
                        "dream_promoted": {
                            "last_promoted_at": "2026-04-01T02:31:00",
                            "promoted_facts": ["继续优化 OpenClaw harness"],
                            "promoted_open_loops": ["检查 nightly dream 首次执行"],
                        },
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (workspace / "memory/preferences.json").write_text(
                json.dumps(
                    {
                        "dream_promoted": {
                            "last_promoted_at": "2026-04-01T02:31:00",
                            "promoted_preferences": ["以后默认短一点"],
                        }
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            payload = harness.build_dream_status(
                workspace=workspace,
                jobs_file=jobs_file,
                runs_dir=runs_dir,
                job_name="Nightly Dream Memory",
                max_runs=3,
            )
            self.assertTrue(payload["job_found"])
            self.assertEqual(payload["job_id"], "dream-job")
            self.assertEqual(payload["recent_runs"][0]["status"], "ok")
            self.assertEqual(payload["promoted_counts"]["preferences"], 1)


class ClosureReportTests(unittest.TestCase):
    def test_build_closure_report_extracts_required_sections(self):
        text = "\n".join(
            [
                "Verified: ran python3 scripts/test_openclaw_harness.py",
                "Not verified: first nightly cron run tomorrow at 02:30",
                "Risk: live cron execution may still surface edge-case parsing issues",
                "Next step: monitor tomorrow morning and inspect cron run log",
            ]
        )
        payload = harness.build_closure_report("推进 OpenClaw harness", text)
        self.assertIn("ran python3 scripts/test_openclaw_harness.py", payload["Verified"][0])
        self.assertIn("first nightly cron run tomorrow", payload["Not verified"][0])
        self.assertEqual(payload["lint"]["decision"], "pass")


if __name__ == "__main__":
    unittest.main()

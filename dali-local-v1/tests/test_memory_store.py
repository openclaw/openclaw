import sys
import unittest
import sqlite3
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "dali-local-v1" / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from memory_store import (  # noqa: E402
    append_event,
    append_compaction_block,
    append_compaction_experiment,
    DEFAULT_STAGE3_LEAKAGE_RISK_THRESHOLD,
    append_promotion,
    append_shadow_run,
    append_eval_run,
    append_checkpoint,
    set_checkpoint_status,
    append_rollback_event,
    append_nca_snapshot,
    append_adapter_registry,
    list_shadow_runs,
    list_eval_runs,
    list_checkpoints,
    get_checkpoint,
    list_rollback_events,
    list_nca_snapshots,
    list_adapters,
    retention_audit,
    compare_eval_runs_for_metric,
    gate_checkpoint_by_eval,
    append_reflection,
    bootstrap_workspace,
    init_db,
    list_compaction_blocks_for_experiment,
    list_recent_compaction_experiments,
    list_recent_events,
    list_recent_reflections,
    list_recent_promotions,
    list_tables,
    summary,
)  # noqa: E402


class MemoryStoreTests(unittest.TestCase):
    def test_bootstrap_creates_expected_dirs_and_tables(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "dali-local-v1"
            result = bootstrap_workspace(root)

            self.assertEqual(result["root"], str(root))
            self.assertTrue((root / "state").is_dir())
            self.assertTrue((root / "state" / "dali.sqlite3").exists())
            self.assertIn("events", result["tables"])
            self.assertIn("reflections", result["tables"])
            self.assertIn("compaction_experiments", result["tables"])
            self.assertIn("compaction_blocks", result["tables"])

    def test_init_db_migrates_legacy_schema(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            with sqlite3.connect(db_path) as conn:
                conn.execute(
                    """
                    CREATE TABLE events (
                      id TEXT PRIMARY KEY,
                      created_at TEXT NOT NULL,
                      event_type TEXT NOT NULL,
                      source TEXT NOT NULL,
                      actor TEXT,
                      conversation_id TEXT,
                      parent_event_id TEXT,
                      payload_json TEXT NOT NULL
                    )
                    """
                )
                conn.commit()

            self.assertNotIn("compaction_experiments", list_tables(db_path))
            self.assertNotIn("compaction_blocks", list_tables(db_path))

            init_db(db_path)

            tables = list_tables(db_path)
            self.assertIn("compaction_experiments", tables)
            self.assertIn("compaction_blocks", tables)

    def test_event_append_and_recent_list(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            event = append_event(
                db_path,
                event_type="manual_test",
                source="test",
                payload={"message": "hello"},
            )
            events = list_recent_events(db_path, limit=1)

            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["event_type"], "manual_test")
            self.assertEqual(events[0]["source"], "test")
            self.assertIn("message", events[0]["payload_json"])
            self.assertEqual(event["id"], events[0]["id"])

    def test_reflection_append_with_source_event(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            event = append_event(
                db_path,
                event_type="manual_test",
                source="test",
                payload={"message": "seed"},
            )

            reflection = append_reflection(
                db_path,
                source_event_id=event["id"],
                reflection_text="Seeded reflection",
                durable_claims=["Claim A", "Claim B"],
                uncertainties=["Unknown X"],
                interdisciplinary_links=["psychology", "systems"],
                memory_candidate_score=0.91,
                payload={"source": "pytest"},
            )
            reflections = list_recent_reflections(db_path, limit=1)

            counts = summary(db_path)

            self.assertEqual(len(reflections), 1)
            self.assertEqual(reflections[0]["source_event_id"], event["id"])
            self.assertEqual(reflections[0]["reflection_text"], "Seeded reflection")
            self.assertEqual(reflection["id"], reflections[0]["id"])
            self.assertEqual(counts["events"], 1)
            self.assertEqual(counts["reflections"], 1)

    def test_promotion_append_with_reflection(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            event = append_event(
                db_path,
                event_type="manual_test",
                source="test",
                payload={"message": "seed"},
            )
            reflection = append_reflection(
                db_path,
                source_event_id=event["id"],
                reflection_text="Reflection for promotion",
                durable_claims=["Claim A"],
                uncertainties=["Unknown X"],
            )
            promotion = append_promotion(
                db_path,
                reflection_id=reflection["id"],
                claim_text="Promoted claim",
                promoted_to="candidate_memory",
                decision="accept",
                evidence={"coherence": 0.8, "signals": ["seed", "good"]},
                checkpoint_id=None,
                payload={"source": "pytest"},
            )
            promotions = list_recent_promotions(db_path, limit=1)

            counts = summary(db_path)

            self.assertEqual(len(promotions), 1)
            self.assertEqual(promotions[0]["reflection_id"], reflection["id"])
            self.assertEqual(promotions[0]["claim_text"], "Promoted claim")
            self.assertEqual(promotion["id"], promotions[0]["id"])
            self.assertEqual(counts["promotions"], 1)

    def test_promotion_requires_valid_reflection_if_provided(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            with self.assertRaisesRegex(ValueError, "reflection not found"):
                append_promotion(
                    db_path,
                    reflection_id="not-a-real-reflection-id",
                    claim_text="Bad promotion",
                    promoted_to="candidate_memory",
                    decision="reject",
                    evidence={"reason": "bad"},
                    checkpoint_id=None,
                    payload={"source": "pytest"},
                )

    def test_promotion_requires_valid_checkpoint_if_provided(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            event = append_event(
                db_path,
                event_type="manual_test",
                source="test",
                payload={"message": "seed"},
            )
            reflection = append_reflection(
                db_path,
                source_event_id=event["id"],
                reflection_text="Reflection with missing checkpoint",
                durable_claims=["Claim A"],
            )

            with self.assertRaisesRegex(ValueError, "checkpoint not found"):
                append_promotion(
                    db_path,
                    reflection_id=reflection["id"],
                    claim_text="Bad checkpoint promotion",
                    promoted_to="candidate_memory",
                    decision="reject",
                    evidence={"reason": "bad checkpoint"},
                    checkpoint_id="not-a-real-checkpoint-id",
                    payload={"source": "pytest"},
                )

    def test_compaction_experiment_and_block_append(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            experiment = append_compaction_experiment(
                db_path,
                model_id="openai-codex/gpt-5.4",
                curriculum_stage=2,
                approach="segmented_cot_mementos",
                name="Context compression pilot",
                segment_window=6,
                kv_reduction_ratio=2.4,
                throughput_mult=1.9,
                accuracy_delta=-0.01,
                leakage_risk_score=0.31,
                tokens_in=42000,
                tokens_out=18000,
                notes="Minimal memento-first baseline dataset",
            )

            block = append_compaction_block(
                db_path,
                experiment_id=experiment["id"],
                segment_index=1,
                curriculum_stage=2,
                segment_text="Long segment about context control and model memory behavior.",
                memento_text="Context control needs explicit compression checkpoints.",
                source_prompt="What changed in token budget?",
                expected_answer="Budget-aware memento policy.",
                side_channel_hint=True,
                source_event_id=None,
                source_event_turn=3,
                payload={"split": "segmented"},
            )

            experiments = list_recent_compaction_experiments(db_path, limit=10)
            blocks = list_compaction_blocks_for_experiment(db_path, experiment["id"])

            self.assertEqual(len(experiments), 1)
            self.assertEqual(experiments[0]["id"], experiment["id"])
            self.assertEqual(len(blocks), 1)
            self.assertEqual(blocks[0]["id"], block["id"])
            self.assertEqual(blocks[0]["side_channel_hint"], 1)

    def test_shadow_run_append_and_list(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            shadow = append_shadow_run(
                db_path,
                prompt_hash="abc123",
                teacher_output={"teacher": "response A"},
                candidate_outputs=[{"id": "c1"}, {"id": "c2"}],
                judge_scores={"c1": 0.3, "c2": 0.8},
                chosen_candidate_id="c2",
            )
            rows = list_shadow_runs(db_path, limit=3)

            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["id"], shadow["id"])
            self.assertEqual(rows[0]["prompt_hash"], "abc123")

    def test_eval_run_append_and_list_with_filters(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            first = append_eval_run(
                db_path,
                suite_name="quality_v1",
                target_kind="checkpoint",
                target_id="cp-1",
                score_summary={"overall": 0.73, "f1": 0.55},
                artifact_path="/tmp/q1.json",
                payload={"phase": 1},
            )
            append_eval_run(
                db_path,
                suite_name="quality_v1",
                target_kind="task",
                target_id="task-1",
                score_summary={"overall": 0.66},
                artifact_path=None,
                payload=None,
            )
            append_eval_run(
                db_path,
                suite_name="quality_v2",
                target_kind="checkpoint",
                target_id="cp-1",
                score_summary={"overall": 0.95},
                artifact_path="/tmp/q2.json",
                payload=None,
            )

            latest_quality_runs = list_eval_runs(db_path, suite_name="quality_v1", limit=5)
            checkpoint_runs = list_eval_runs(db_path, suite_name="quality_v1", target_kind="checkpoint", limit=5)

            self.assertEqual(len(latest_quality_runs), 2)
            self.assertEqual(len(checkpoint_runs), 1)
            self.assertEqual(checkpoint_runs[0]["id"], first["id"])

            compare_payload = compare_eval_runs_for_metric(
                db_path,
                suite_name="quality_v1",
                metric="overall",
            )
            self.assertEqual(compare_payload["count"], 2)
            self.assertIn("best", compare_payload)

    def test_checkpoint_append_set_status_and_not_found_paths(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            checkpoint = append_checkpoint(
                db_path,
                base_model_id="gpt-5.4",
                adapter_id=None,
                nca_snapshot_id=None,
                status="proposed",
                lineage={"source": "test"},
                metrics={"val": 0.5},
                notes="initial",
            )

            set_checkpoint_status(db_path, checkpoint_id=checkpoint["id"], status="approved")
            reloaded = get_checkpoint(db_path, checkpoint["id"])
            self.assertIsNotNone(reloaded)
            self.assertEqual(reloaded["status"], "approved")

            with self.assertRaises(ValueError):
                set_checkpoint_status(db_path, checkpoint_id="missing", status="archived")

            with self.assertRaises(ValueError):
                append_checkpoint(
                    db_path,
                    base_model_id="gpt-5.4",
                    adapter_id=None,
                    nca_snapshot_id=None,
                    status="not_real",
                    lineage={},
                    metrics={},
                    notes=None,
                )

    def test_rollback_event_append_and_list(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            checkpoint_a = append_checkpoint(
                db_path,
                base_model_id="gpt-5.4",
                adapter_id=None,
                nca_snapshot_id=None,
                status="approved",
                lineage={"source": "a"},
                metrics={"val": 0.9},
                notes=None,
            )
            checkpoint_b = append_checkpoint(
                db_path,
                base_model_id="gpt-5.4",
                adapter_id=None,
                nca_snapshot_id=None,
                status="rejected",
                lineage={"source": "b"},
                metrics={"val": 0.8},
                notes=None,
            )

            event = append_rollback_event(
                db_path,
                from_checkpoint_id=checkpoint_a["id"],
                to_checkpoint_id=checkpoint_b["id"],
                reason="quality regression",
                payload={"reason_code": "regression"},
            )
            events = list_rollback_events(db_path, limit=5)

            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["id"], event["id"])
            self.assertEqual(events[0]["reason"], "quality regression")

    def test_rollback_event_validation(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            with self.assertRaisesRegex(ValueError, "from checkpoint not found"):
                append_rollback_event(
                    db_path,
                    from_checkpoint_id="missing-from",
                    to_checkpoint_id=None,
                    reason="invalid from checkpoint",
                    payload={"reason_code": "bad_from"},
                )

            with self.assertRaisesRegex(ValueError, "to checkpoint not found"):
                append_rollback_event(
                    db_path,
                    from_checkpoint_id=None,
                    to_checkpoint_id="missing-to",
                    reason="invalid to checkpoint",
                    payload={"reason_code": "bad_to"},
                )

            with self.assertRaisesRegex(ValueError, "at least one of"):
                append_rollback_event(
                    db_path,
                    from_checkpoint_id=None,
                    to_checkpoint_id=None,
                    reason="missing targets",
                    payload={"reason_code": "empty"},
                )

    def test_nca_snapshot_append_and_list(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            checkpoint = append_checkpoint(
                db_path,
                base_model_id="gpt-5.4",
                adapter_id=None,
                nca_snapshot_id=None,
                status="proposed",
                lineage={"source": "nca"},
                metrics={"val": 0.7},
                notes=None,
            )

            snapshot = append_nca_snapshot(
                db_path,
                parent_snapshot_id=None,
                checkpoint_id=checkpoint["id"],
                motif_summary="stable motifs",
                drift_signal=0.13,
                anomaly_flags=["none"],
                payload={"note": "test"},
            )
            snapshots = list_nca_snapshots(db_path, checkpoint_id=checkpoint["id"], limit=5)

            self.assertEqual(len(snapshots), 1)
            self.assertEqual(snapshots[0]["id"], snapshot["id"])

    def test_nca_snapshot_rejects_missing_parent_or_checkpoint(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            with self.assertRaisesRegex(ValueError, "parent nca snapshot not found"):
                append_nca_snapshot(
                    db_path,
                    parent_snapshot_id="missing-parent",
                    checkpoint_id=None,
                    motif_summary="broken chain",
                    drift_signal=0.5,
                    anomaly_flags=[],
                    payload={},
                )

            with self.assertRaisesRegex(ValueError, "checkpoint not found"):
                append_nca_snapshot(
                    db_path,
                    parent_snapshot_id=None,
                    checkpoint_id="missing-checkpoint",
                    motif_summary="broken chain",
                    drift_signal=0.5,
                    anomaly_flags=[],
                    payload={},
                )

    def test_adapter_registry_append_and_list_with_filter(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            adapter = append_adapter_registry(
                db_path,
                base_model_id="gpt-5.4",
                adapter_path="/tmp/adapter-v1.bin",
                train_corpus_lineage={"source": "corpus-a"},
                validation_summary={"coherence": 0.7},
                deployment_state="deployed",
                merge_state="merged",
                payload={"region": "primary"},
            )
            append_adapter_registry(
                db_path,
                base_model_id="qwen2",
                adapter_path="/tmp/adapter-v2.bin",
                train_corpus_lineage={"source": "corpus-b"},
                validation_summary={"coherence": 0.6},
                deployment_state="staged",
                merge_state="pending",
                payload={},
            )

            filtered = list_adapters(db_path, base_model_id="gpt-5.4", limit=5)
            all_rows = list_adapters(db_path, limit=5)

            self.assertEqual(len(filtered), 1)
            self.assertEqual(filtered[0]["id"], adapter["id"])
            self.assertEqual(len(all_rows), 2)

    def test_checkpoint_gate_by_eval_rejects_missing_checkpoint_or_run(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            checkpoint = append_checkpoint(
                db_path,
                base_model_id="gpt-5.4",
                adapter_id=None,
                nca_snapshot_id=None,
                status="proposed",
                lineage={"source": "gate"},
                metrics={"val": 0.1},
                notes=None,
            )

            with self.assertRaises(ValueError):
                gate_checkpoint_by_eval(
                    db_path,
                    checkpoint_id=checkpoint["id"],
                    suite_name="cpq",
                    metric="overall",
                )

            with self.assertRaises(ValueError):
                gate_checkpoint_by_eval(
                    db_path,
                    checkpoint_id="missing",
                    suite_name="cpq",
                    metric="overall",
                )

            append_eval_run(
                db_path,
                suite_name="cpq",
                target_kind="checkpoint",
                target_id=checkpoint["id"],
                score_summary={"overall": 0.9},
                artifact_path=None,
                payload={},
            )
            result = gate_checkpoint_by_eval(
                db_path,
                checkpoint_id=checkpoint["id"],
                suite_name="cpq",
                metric="overall",
                min_improvement=0.1,
            )
            self.assertEqual(result["status"], "approved")

            reloaded = get_checkpoint(db_path, checkpoint["id"])
            self.assertIsNotNone(reloaded)
            self.assertEqual(reloaded["status"], "approved")

    def test_retention_report_handles_all_tables(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            append_shadow_run(
                db_path,
                prompt_hash="a",
                teacher_output={"x": 1},
                candidate_outputs=[{"id": "c1"}],
                judge_scores={"c1": 0.2},
                chosen_candidate_id="c1",
            )

            report = retention_audit(db_path, days=1)

            self.assertEqual(report["retentionDays"], 1)
            self.assertIn("tableCounts", report)
            self.assertIn("compaction", report)
            self.assertIn("shadow_runs", report["tableCounts"])
            self.assertGreaterEqual(report["tableCounts"]["shadow_runs"], 1)

    def test_compaction_block_rejects_unknown_experiment(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            with self.assertRaises(sqlite3.IntegrityError):
                append_compaction_block(
                    db_path,
                    experiment_id="not-a-real-run",
                    segment_index=1,
                    curriculum_stage=1,
                    segment_text="bad block",
                    memento_text="nope",
                    source_prompt="prompt",
                    expected_answer="bad",
                    side_channel_hint=False,
                    source_event_id=None,
                    source_event_turn=None,
                    payload={"broken": True},
                )

    def test_stage3_completion_requires_leakage_gate(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            db_path = Path(tmp_dir) / "dali.sqlite3"
            bootstrap_workspace(tmp_dir, db_path)

            # Safe leakage clears the finalization gate.
            experiment = append_compaction_experiment(
                db_path,
                model_id="openai-codex/gpt-5.4",
                curriculum_stage=3,
                approach="native_block_masking",
                name="Stage-3 release check",
                segment_window=4,
                kv_reduction_ratio=2.8,
                throughput_mult=1.8,
                accuracy_delta=-0.005,
                leakage_risk_score=0.1,
                tokens_in=50000,
                tokens_out=18000,
                status="Completed",
                notes="low leakage pilot",
            )
            self.assertEqual(experiment["status"], "completed")

            with self.assertRaises(ValueError):
                append_compaction_experiment(
                    db_path,
                    model_id="openai-codex/gpt-5.4",
                    curriculum_stage=3,
                    approach="native_block_masking",
                    name="Stage-3 release check",
                    segment_window=4,
                    kv_reduction_ratio=2.8,
                    throughput_mult=1.8,
                    accuracy_delta=-0.005,
                    leakage_risk_score=0.91,
                    tokens_in=50000,
                    tokens_out=18000,
                    status="completed",
                    notes="high leakage pilot",
                )

            with self.assertRaises(ValueError):
                append_compaction_experiment(
                    db_path,
                    model_id="openai-codex/gpt-5.4",
                    curriculum_stage=3,
                    approach="native_block_masking",
                    name="Stage-3 release check",
                    segment_window=4,
                    kv_reduction_ratio=2.8,
                    throughput_mult=1.8,
                    accuracy_delta=-0.005,
                    leakage_risk_score=None,
                    tokens_in=50000,
                    tokens_out=18000,
                    status="completed",
                    notes="missing leakage score",
                    max_stage3_leakage_risk=DEFAULT_STAGE3_LEAKAGE_RISK_THRESHOLD,
                )


if __name__ == "__main__":
    unittest.main()

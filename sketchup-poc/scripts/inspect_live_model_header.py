#!/usr/bin/env python3
import argparse
import json
import sys
from pathlib import Path
from typing import Any, Optional


class ValidationError(Exception):
    pass


def _first_dict(*candidates: Any) -> Optional[dict]:
    for candidate in candidates:
        if isinstance(candidate, dict):
            return candidate
    return None


def _get_header(payload: dict) -> Optional[dict]:
    result = _first_dict(payload.get("result"))
    bootstrap_ack = _first_dict(result.get("bootstrapAck")) if result else None
    bootstrap_artifact = _first_dict(bootstrap_ack.get("artifact")) if bootstrap_ack else None
    return _first_dict(
        payload.get("liveModelHeader"),
        result.get("liveModelHeader") if result else None,
        bootstrap_artifact.get("liveModelHeader") if bootstrap_artifact else None,
    )


def _get_metadata(payload: dict) -> Optional[dict]:
    output = _first_dict(payload.get("output"))
    result = _first_dict(output.get("result")) if output else None
    return _first_dict(
        payload.get("liveMetadata"),
        output.get("liveMetadata") if output else None,
        result.get("liveMetadata") if result else None,
    )


def _get_result(payload: dict) -> Optional[dict]:
    output = _first_dict(payload.get("output"))
    return _first_dict(payload.get("result"), output.get("result") if output else None)


def _get_execution(payload: dict) -> Optional[dict]:
    output = _first_dict(payload.get("output"))
    return _first_dict(payload.get("execution"), output.get("execution") if output else None)


def _get_probe(payload: dict) -> Optional[dict]:
    output = _first_dict(payload.get("output"))
    return _first_dict(payload.get("liveProbe"), output.get("liveProbe") if output else None)


def _get_action(payload: dict) -> Optional[str]:
    output = _first_dict(payload.get("output"))
    for candidate in (payload.get("action"), output.get("action") if output else None):
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _get_warnings(payload: dict) -> list[str]:
    output = _first_dict(payload.get("output"))
    warnings = payload.get("warnings")
    if not isinstance(warnings, list) and output:
        warnings = output.get("warnings")
    return [item for item in warnings if isinstance(item, str)] if isinstance(warnings, list) else []


def _get_bootstrap_ack(payload: dict) -> Optional[dict]:
    result = _get_result(payload)
    return _first_dict(result.get("bootstrapAck")) if result else None


def _get_live_model_access(payload: dict) -> Optional[dict]:
    result = _get_result(payload)
    return _first_dict(result.get("liveModelAccess")) if result else None


def _get_safe_query_proof(payload: dict) -> Optional[dict]:
    result = _get_result(payload)
    bootstrap_ack = _get_bootstrap_ack(payload)
    bootstrap_artifact = _first_dict(bootstrap_ack.get("artifact")) if bootstrap_ack else None
    live_model_access = _get_live_model_access(payload)
    return _first_dict(
        payload.get("safeQueryProof"),
        result.get("safeQueryProof") if result else None,
        bootstrap_artifact.get("safeQueryProof") if bootstrap_artifact else None,
        live_model_access.get("safeQueryProof") if live_model_access else None,
    )


def _get_handoff_plan(payload: dict) -> Optional[dict]:
    result = _get_result(payload)
    return _first_dict(result.get("liveExtractionPlan")) if result else None


def _pick_document_path(*candidates: Any) -> Optional[str]:
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _pick_document_name(*candidates: Any) -> Optional[str]:
    for candidate in candidates:
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


def _build_diagnostic_summary(payload: dict, header: Optional[dict], metadata: Optional[dict], execution: Optional[dict]) -> dict:
    result = _get_result(payload)
    probe = _get_probe(payload)
    bootstrap_ack = _get_bootstrap_ack(payload)
    live_model_access = _get_live_model_access(payload)
    handoff_plan = _get_handoff_plan(payload)
    probe_details = _first_dict(probe.get("details")) if probe else None
    detected_document = _first_dict(probe_details.get("detectedDocument")) if probe_details else None
    metadata_document = _first_dict(metadata.get("document")) if metadata else None
    handoff_target = _first_dict(handoff_plan.get("target")) if handoff_plan else None
    handoff_request = _first_dict(handoff_plan.get("extractorRequest")) if handoff_plan else None
    handoff_options = _first_dict(handoff_request.get("options")) if handoff_request else None
    requested_document_path = _pick_document_path(
        live_model_access.get("requestedDocumentPath") if live_model_access else None,
        handoff_options.get("documentPath") if handoff_options else None,
    )
    observed_document_path = _pick_document_path(
        header.get("modelPath") if header else None,
        live_model_access.get("modelPath") if live_model_access else None,
        detected_document.get("path") if detected_document else None,
        metadata_document.get("pathHint") if metadata_document else None,
        handoff_target.get("documentPathHint") if handoff_target else None,
    )
    observed_document_name = _pick_document_name(
        header.get("modelTitle") if header else None,
        live_model_access.get("modelTitle") if live_model_access else None,
        detected_document.get("name") if detected_document else None,
        metadata_document.get("nameHint") if metadata_document else None,
        handoff_target.get("documentNameHint") if handoff_target else None,
    )
    requested_document_matched = None
    for candidate in (
        header.get("requestedDocumentMatched") if header else None,
        live_model_access.get("requestedDocumentMatched") if live_model_access else None,
    ):
        if isinstance(candidate, bool):
            requested_document_matched = candidate
            break

    snapshot_path = result.get("snapshotPath") if result else None
    snapshot_kind = result.get("snapshotKind") if result else None
    snapshot_available = isinstance(snapshot_path, str) and bool(snapshot_path)

    live_access_status = "no-live-evidence"
    if isinstance(live_model_access, dict) and live_model_access.get("activeModelAccessible") is True:
        live_access_status = "proved-active-model-access"
    elif isinstance(bootstrap_ack, dict) and bootstrap_ack.get("status") == "acknowledged":
        live_access_status = "bootstrap-ack-only"
    elif isinstance(metadata, dict):
        live_access_status = "process-metadata-only"

    has_detected_document_hint = bool(
        isinstance(detected_document, dict)
        and (
            detected_document.get("detected") is True
            or detected_document.get("path")
            or detected_document.get("name")
        )
    )
    has_metadata_document_hint = bool(
        isinstance(metadata_document, dict)
        and (
            metadata_document.get("detected") is True
            or metadata_document.get("pathHint")
            or metadata_document.get("nameHint")
        )
    )

    document_evidence = "none"
    if live_access_status == "proved-active-model-access" and isinstance(header, dict):
        document_evidence = "live-model-header"
    elif isinstance(header, dict):
        document_evidence = "header-surface"
    elif has_detected_document_hint or has_metadata_document_hint:
        document_evidence = "process-metadata-hint"
    elif handoff_target:
        document_evidence = "handoff-target-hint"

    headline_parts: list[str] = []
    if requested_document_matched is True:
        headline_parts.append("Requested document appears to match the observed model.")
    elif requested_document_matched is False:
        headline_parts.append("Requested document does not appear to match the observed model.")
    elif observed_document_path or observed_document_name:
        headline_parts.append("A candidate document was identified, but match status is not proven.")
    else:
        headline_parts.append("No document identity could be confirmed from the current surface.")

    if live_access_status == "proved-active-model-access":
        headline_parts.append("Ruby-side access to Sketchup.active_model is evidenced.")
    elif live_access_status == "bootstrap-ack-only":
        headline_parts.append("A bootstrap acknowledgment exists, but active_model proof is not surfaced here.")
    elif live_access_status == "process-metadata-only":
        headline_parts.append("Only process/install metadata is available.")
    else:
        headline_parts.append("No live SketchUp access evidence is present.")

    if snapshot_available:
        headline_parts.append("A snapshot path is present.")
    elif isinstance(handoff_plan, dict):
        headline_parts.append("A live-extractor handoff plan exists, but no snapshot was emitted.")
    elif isinstance(bootstrap_ack, dict) and bootstrap_ack.get("status") == "acknowledged":
        headline_parts.append("Bootstrap was acknowledged, but no snapshot was emitted.")
    else:
        headline_parts.append("No snapshot artifact is present.")

    diagnostic_warnings: list[str] = []
    if live_access_status == "process-metadata-only":
        diagnostic_warnings.append("Current evidence stops at process metadata; this is not live model access.")
    if isinstance(bootstrap_ack, dict) and bootstrap_ack.get("status") == "acknowledged" and not snapshot_available:
        diagnostic_warnings.append("Bootstrap acknowledgment does not imply traversal or snapshot output.")
    if isinstance(handoff_plan, dict):
        diagnostic_warnings.append("Handoff plan is preparatory only; it does not prove extractor execution.")
    diagnostic_warnings.extend(_get_warnings(payload))

    return {
        "headline": " ".join(headline_parts),
        "document": {
            "requestedPath": requested_document_path,
            "observedPath": observed_document_path,
            "observedName": observed_document_name,
            "requestedMatched": requested_document_matched,
            "evidenceKind": document_evidence,
        },
        "liveAccess": {
            "status": live_access_status,
            "proofKind": live_model_access.get("proofKind") if live_model_access else None,
            "resultKind": execution.get("resultKind") if execution else None,
        },
        "bootstrap": {
            "acknowledged": bool(isinstance(bootstrap_ack, dict) and bootstrap_ack.get("status") == "acknowledged"),
            "status": bootstrap_ack.get("status") if bootstrap_ack else None,
            "stage": bootstrap_ack.get("stage") if bootstrap_ack else None,
            "path": bootstrap_ack.get("path") if bootstrap_ack else None,
        },
        "snapshot": {
            "available": snapshot_available,
            "path": snapshot_path if snapshot_available else None,
            "kind": snapshot_kind,
        },
        "handoff": {
            "available": isinstance(handoff_plan, dict),
            "readiness": _first_dict(handoff_plan.get("readiness")).get("status") if isinstance(handoff_plan, dict) and _first_dict(handoff_plan.get("readiness")) else None,
        },
        "warnings": diagnostic_warnings,
    }


def _build_safe_query_summary(payload: dict, safe_query: Optional[dict], diagnostic: Optional[dict]) -> dict:
    query_kind = safe_query.get("queryKind") if isinstance(safe_query, dict) else None
    source_kind = safe_query.get("sourceKind") if isinstance(safe_query, dict) else None
    if not isinstance(query_kind, str) or not query_kind:
        query_kind = "model-bounds-summary"
    if not isinstance(source_kind, str) or not source_kind:
        source_kind = "bootstrap-live-safe-query"
    available = safe_query.get("available") if isinstance(safe_query, dict) else None
    value = _first_dict(safe_query.get("value")) if isinstance(safe_query, dict) else None
    unavailable_reason = safe_query.get("unavailableReason") if isinstance(safe_query, dict) else None
    live_access = _first_dict(diagnostic.get("liveAccess")) if isinstance(diagnostic, dict) else None
    bootstrap = _first_dict(diagnostic.get("bootstrap")) if isinstance(diagnostic, dict) else None

    if isinstance(available, bool):
        normalized_available = available
    else:
        normalized_available = False

    if normalized_available:
        status = "available"
    elif isinstance(unavailable_reason, str) and unavailable_reason:
        status = "unavailable"
    elif isinstance(live_access, dict) and live_access.get("status") == "proved-active-model-access":
        status = "missing-surface"
        unavailable_reason = "safe-query-surface-not-emitted"
    elif isinstance(bootstrap, dict) and bootstrap.get("acknowledged") is True:
        status = "unavailable"
        unavailable_reason = "bootstrap-ack-without-live-query-proof"
    elif isinstance(live_access, dict) and live_access.get("status") == "process-metadata-only":
        status = "unavailable"
        unavailable_reason = "process-metadata-only"
    else:
        status = "unavailable"
        unavailable_reason = "no-live-model-proof"

    return {
        "status": status,
        "queryKind": query_kind,
        "sourceKind": source_kind,
        "available": normalized_available,
        "value": value if normalized_available else None,
        "unavailableReason": None if normalized_available else unavailable_reason,
    }


def _validate_diagnostic_summary(diagnostic: Optional[dict]) -> None:
    if not isinstance(diagnostic, dict):
        raise ValidationError("diagnosticSummary must be an object")

    for key in ("document", "liveAccess", "bootstrap", "snapshot", "handoff"):
        if not isinstance(diagnostic.get(key), dict):
            raise ValidationError(f"diagnosticSummary.{key} must be an object")

    warnings = diagnostic.get("warnings")
    if not isinstance(warnings, list) or any(not isinstance(item, str) for item in warnings):
        raise ValidationError("diagnosticSummary.warnings must be an array of strings")


def _validate_safe_query_surface(safe_query: Optional[dict]) -> None:
    if not isinstance(safe_query, dict):
        raise ValidationError("safeQueryProof must be an object")

    for key in ("queryKind", "sourceKind", "status"):
        if not isinstance(safe_query.get(key), str) or not safe_query.get(key):
            raise ValidationError(f"safeQueryProof.{key} must be a non-empty string")

    available = safe_query.get("available")
    if not isinstance(available, bool):
        raise ValidationError("safeQueryProof.available must be boolean")

    status = safe_query.get("status")
    value = safe_query.get("value")
    unavailable_reason = safe_query.get("unavailableReason")

    if available:
        if status != "available":
            raise ValidationError("safeQueryProof.status must be 'available' when available=true")
        if not isinstance(value, dict):
            raise ValidationError("safeQueryProof.value must be an object when available=true")
        for key in ("width", "height", "depth", "diagonal"):
            if not isinstance(value.get(key), (int, float)):
                raise ValidationError(f"safeQueryProof.value.{key} must be numeric")
        if unavailable_reason is not None:
            raise ValidationError("safeQueryProof.unavailableReason must be null when available=true")
        return

    if status != "unavailable":
        raise ValidationError("safeQueryProof.status must be 'unavailable' when available=false")
    if value is not None:
        raise ValidationError("safeQueryProof.value must be null when available=false")
    if not isinstance(unavailable_reason, str) or not unavailable_reason:
        raise ValidationError("safeQueryProof.unavailableReason must be a non-empty string when available=false")


def build_inspect_summary(payload: dict) -> dict:
    header = _get_header(payload)
    metadata = _get_metadata(payload)
    execution = _get_execution(payload)
    stats = _first_dict(header.get("stats")) if header else None
    diagnostic = _build_diagnostic_summary(payload, header, metadata, execution)
    safe_query = _get_safe_query_proof(payload)
    return {
        "action": _get_action(payload),
        "resultKind": execution.get("resultKind") if execution else payload.get("executionState"),
        "headerAvailable": header is not None,
        "metadataAvailable": metadata is not None,
        "liveModelHeader": header,
        "liveMetadata": metadata,
        "diagnosticSummary": diagnostic,
        "safeQueryProof": _build_safe_query_summary(payload, safe_query, diagnostic),
        "notes": [
            "Bu inspect cikti yalnizca mevcut liveModelHeader/liveMetadata yuzeyini okunabilir kilar.",
            "Entity traversal veya full snapshot kaniti degildir.",
        ],
        "stats": stats,
    }


def validate_inspect_summary(summary: dict) -> None:
    _validate_diagnostic_summary(_first_dict(summary.get("diagnosticSummary")))
    _validate_safe_query_surface(_first_dict(summary.get("safeQueryProof")))


def build_bridge_consumer_summary(summary: dict) -> dict:
    validate_inspect_summary(summary)
    return {
        "action": summary.get("action"),
        "resultKind": summary.get("resultKind"),
        "contractValidated": True,
        "diagnosticSummary": _first_dict(summary.get("diagnosticSummary")),
        "safeQueryProof": _first_dict(summary.get("safeQueryProof")),
        "notes": [
            "Bu bridge consumer slice yalnizca diagnosticSummary + safeQueryProof yuzeyini tuketir.",
            "Traversal veya full snapshot kaniti uretmez.",
        ],
    }


def format_inspect_text(summary: dict) -> str:
    lines = []
    action = summary.get("action") or "unknown"
    result_kind = summary.get("resultKind") or "unknown"
    lines.append(f"header-inspect action={action} result={result_kind}")
    diagnostic = _first_dict(summary.get("diagnosticSummary"))
    if diagnostic:
        lines.append(f"diagnostic: {diagnostic.get('headline') or '-'}")
        document = _first_dict(diagnostic.get("document"))
        if document:
            lines.append(
                "document: requestedMatched={0} evidence={1} observedName={2}".format(
                    document.get("requestedMatched"),
                    document.get("evidenceKind") or "-",
                    document.get("observedName") or "-",
                )
            )
            if document.get("requestedPath") or document.get("observedPath"):
                lines.append(
                    "documentPaths: requested={0} observed={1}".format(
                        document.get("requestedPath") or "-",
                        document.get("observedPath") or "-",
                    )
                )
        live_access = _first_dict(diagnostic.get("liveAccess"))
        if live_access:
            lines.append(
                "liveAccess: status={0} proofKind={1}".format(
                    live_access.get("status") or "-",
                    live_access.get("proofKind") or "-",
                )
            )
        bootstrap = _first_dict(diagnostic.get("bootstrap"))
        if bootstrap:
            lines.append(
                "bootstrap: acknowledged={0} stage={1}".format(
                    bootstrap.get("acknowledged"),
                    bootstrap.get("stage") or "-",
                )
            )
        handoff = _first_dict(diagnostic.get("handoff"))
        if handoff and handoff.get("available") is True:
            lines.append(f"handoff: readiness={handoff.get('readiness') or '-'}")
        snapshot = _first_dict(diagnostic.get("snapshot"))
        if snapshot:
            lines.append(
                "snapshot: available={0} kind={1}".format(
                    snapshot.get("available"),
                    snapshot.get("kind") or "-",
                )
            )

    header = _first_dict(summary.get("liveModelHeader"))
    metadata = _first_dict(summary.get("liveMetadata"))
    safe_query = _first_dict(summary.get("safeQueryProof"))

    if header:
        lines.append(f"modelTitle: {header.get('modelTitle') or '-'}")
        lines.append(f"modelPath: {header.get('modelPath') or '-'}")
        lines.append(f"modelGuid: {header.get('modelGuid') or '-'}")
        lines.append(f"requestedDocumentMatched: {header.get('requestedDocumentMatched')}")
        lines.append(f"sourceKind: {header.get('sourceKind') or '-'}")
        stats = _first_dict(header.get("stats"))
        if stats:
            lines.append(
                "stats: entityCount={0} sceneCount={1} selectionCount={2}".format(
                    stats.get("entityCount"),
                    stats.get("sceneCount"),
                    stats.get("selectionCount"),
                )
            )
    else:
        lines.append("liveModelHeader: unavailable")

    if safe_query:
        if safe_query.get("available") is True:
            value = _first_dict(safe_query.get("value"))
            lines.append(
                "safeQuery: status={0} kind={1} source={2}".format(
                    safe_query.get("status") or "-",
                    safe_query.get("queryKind") or "-",
                    safe_query.get("sourceKind") or "-",
                )
            )
            if value:
                lines.append(
                    "safeQuery.value: width={0} height={1} depth={2} diagonal={3}".format(
                        value.get("width"),
                        value.get("height"),
                        value.get("depth"),
                        value.get("diagonal"),
                    )
                )
        else:
            lines.append(
                "safeQuery: status={0} kind={1} reason={2}".format(
                    safe_query.get("status") or "-",
                    safe_query.get("queryKind") or "-",
                    safe_query.get("unavailableReason") or "-",
                )
            )

    if metadata:
        lines.append(f"metadata.kind: {metadata.get('kind') or '-'}")
        lines.append(f"metadata.source: {metadata.get('source') or '-'}")
        extraction_kind = metadata.get("extractionKind")
        if extraction_kind:
            lines.append(f"metadata.extractionKind: {extraction_kind}")

    if diagnostic:
        for warning in diagnostic.get("warnings", []):
            lines.append(f"warning: {warning}")
    for note in summary.get("notes", []):
        lines.append(f"note: {note}")
    return "\n".join(lines)


def format_bridge_consumer_text(summary: dict) -> str:
    consumer = build_bridge_consumer_summary(summary)
    diagnostic = _first_dict(consumer.get("diagnosticSummary"))
    safe_query = _first_dict(consumer.get("safeQueryProof"))
    document = _first_dict(diagnostic.get("document")) if diagnostic else None
    live_access = _first_dict(diagnostic.get("liveAccess")) if diagnostic else None
    snapshot = _first_dict(diagnostic.get("snapshot")) if diagnostic else None

    lines = []
    lines.append(
        "bridge-consumer action={0} result={1} contractValidated={2}".format(
            consumer.get("action") or "unknown",
            consumer.get("resultKind") or "unknown",
            consumer.get("contractValidated"),
        )
    )
    if diagnostic:
        lines.append(f"diagnostic: {diagnostic.get('headline') or '-'}")
    if document:
        lines.append(
            "document: evidence={0} requestedMatched={1} observedName={2}".format(
                document.get("evidenceKind") or "-",
                document.get("requestedMatched"),
                document.get("observedName") or "-",
            )
        )
    if live_access:
        lines.append(
            "liveAccess: status={0} proofKind={1}".format(
                live_access.get("status") or "-",
                live_access.get("proofKind") or "-",
            )
        )
    if snapshot:
        lines.append(
            "snapshot: available={0} kind={1}".format(
                snapshot.get("available"),
                snapshot.get("kind") or "-",
            )
        )
    if safe_query:
        if safe_query.get("available") is True:
            value = _first_dict(safe_query.get("value"))
            lines.append(
                "safeQueryConsumer: available kind={0} source={1}".format(
                    safe_query.get("queryKind") or "-",
                    safe_query.get("sourceKind") or "-",
                )
            )
            if value:
                lines.append(
                    "safeQueryConsumer.value: width={0} height={1} depth={2} diagonal={3}".format(
                        value.get("width"),
                        value.get("height"),
                        value.get("depth"),
                        value.get("diagonal"),
                    )
                )
        else:
            lines.append(
                "safeQueryConsumer: unavailable reason={0} kind={1}".format(
                    safe_query.get("unavailableReason") or "-",
                    safe_query.get("queryKind") or "-",
                )
            )
    for note in consumer.get("notes", []):
        lines.append(f"note: {note}")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Inspect liveModelHeader/liveMetadata surfaces from bridge or live extractor JSON artifacts."
    )
    parser.add_argument("input", help="Path to a bridge response/output JSON or live extractor artifact.")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument(
        "--consumer-surface",
        action="store_true",
        help="Print or emit only the contract-aware bridge consumer surface derived from diagnosticSummary + safeQueryProof.",
    )
    parser.add_argument(
        "--validate",
        action="store_true",
        help="Fail if diagnosticSummary/safeQueryProof surfaces do not match the expected inspect contract.",
    )
    args = parser.parse_args()

    input_path = Path(args.input).resolve()
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    summary = build_inspect_summary(payload)
    if args.validate:
        validate_inspect_summary(summary)

    if args.consumer_surface:
        consumer = build_bridge_consumer_summary(summary)
        if args.format == "json":
            print(json.dumps(consumer, indent=2))
        else:
            print(format_bridge_consumer_text(summary))
        return 0

    if args.format == "json":
        print(json.dumps(summary, indent=2))
    else:
        print(format_inspect_text(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

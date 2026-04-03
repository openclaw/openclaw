#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys

from sense_runtime_manager_signal_classifier import classify_manager_signal


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Manager policy table for Sense runtime routing evaluation.'
    )
    parser.add_argument('--input-json')
    return parser


def load_payload(args: argparse.Namespace) -> dict:
    if args.input_json:
        return json.loads(args.input_json)
    raw = sys.stdin.read()
    if not raw.strip():
        raise SystemExit('expected routing evaluation JSON on stdin or via --input-json')
    return json.loads(raw)


def build_policy_output(
    *,
    manager_action: str,
    manager_reason: str,
    next_step: str,
    retry_decision: str | None,
    policy_input: dict,
    policy_trace: dict,
) -> dict:
    return {
        'manager_action': manager_action,
        'manager_reason': manager_reason,
        'next_step': next_step,
        'retry_decision': retry_decision,
        'policy_table_version': 'v1',
        'policy_trace': policy_trace,
        'policy_input': policy_input,
    }


def build_classifier_matched_on(classification: dict) -> dict:
    return {
        'classified_issue': classification.get('classified_issue'),
        'primary_issue': classification.get('primary_issue'),
        'secondary_issues': classification.get('secondary_issues', []),
        'classifier_reason': classification.get('classifier_reason'),
        'classifier_version': classification.get('classifier_version'),
        'priority': classification.get('priority'),
        'confidence': classification.get('confidence'),
        'fallback_action': classification.get('fallback_action'),
    }


def main() -> int:
    args = build_parser().parse_args()
    payload = load_payload(args)
    final_state = str(payload.get('final_state') or 'unknown')
    next_step = str(payload.get('next_step') or 'manual_review')
    retry = payload.get('retry') if isinstance(payload.get('retry'), dict) else {}
    retry_decision = retry.get('retry_decision')
    repeated_decision_detected = retry.get('repeated_decision_detected') is True
    policy_input = payload.get('policy_input', {})
    classification = classify_manager_signal(payload)
    classified_issue = classification.get('primary_issue') or classification.get('classified_issue')

    if classified_issue == 'provider_api_key_issue':
        output = build_policy_output(
            manager_action='configure_provider',
            manager_reason='provider-specific API key is missing and provider remediation should be run before retrying runtime work',
            next_step='check_api_key_config' if final_state == 'provider_not_ready' else 'configure_provider',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'provider_not_ready_check_api_key_config' if final_state == 'provider_not_ready' else 'provider_api_key_missing_configure_provider',
                'matched_on': build_classifier_matched_on(classification),
                'selected_action': 'configure_provider',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'provider_config_missing':
        output = build_policy_output(
            manager_action='configure_provider',
            manager_reason='provider configuration is missing and provider remediation should continue before runtime work',
            next_step='check_provider_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'provider_config_missing_configure_provider',
                'matched_on': {'final_state': final_state},
                'selected_action': 'configure_provider',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'provider_model_missing':
        output = build_policy_output(
            manager_action='configure_provider',
            manager_reason='model configuration is missing and provider/model remediation should continue before runtime work',
            next_step='check_model_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'provider_model_missing_configure_provider',
                'matched_on': {'final_state': final_state},
                'selected_action': 'configure_provider',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if classified_issue == 'provider_recognition_issue':
        output = build_policy_output(
            manager_action='configure_provider',
            manager_reason='provider is configured but runtime is not yet recognizing it, so provider recognition remediation should continue',
            next_step='check_provider_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'provider_not_ready_check_provider_config',
                'matched_on': build_classifier_matched_on(classification),
                'selected_action': 'configure_provider',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if classified_issue == 'runtime_capability_issue_nim':
        output = build_policy_output(
            manager_action='start_nim_runtime',
            manager_reason='provider readiness is blocked by NIM runtime availability, so NIM remediation should continue first',
            next_step='start_nim_runtime',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'provider_not_ready_runtime_capability_remediation',
                'matched_on': build_classifier_matched_on(classification),
                'selected_action': 'start_nim_runtime',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if classified_issue == 'runtime_capability_issue_gpu':
        output = build_policy_output(
            manager_action='configure_gpu_runtime',
            manager_reason='provider readiness is blocked by runtime capability issues, so GPU/runtime remediation should continue first',
            next_step='configure_gpu_runtime',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'provider_not_ready_runtime_capability_remediation',
                'matched_on': build_classifier_matched_on(classification),
                'selected_action': 'configure_gpu_runtime',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'provider_not_ready':
        output = build_policy_output(
            manager_action='configure_provider',
            manager_reason='provider is configured but runtime is not yet recognizing it, so provider remediation should continue',
            next_step='check_provider_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'provider_not_ready_configure_provider',
                'matched_on': build_classifier_matched_on(classification),
                'selected_action': 'configure_provider',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if classified_issue == 'selected_model_retry_issue':
        output = build_policy_output(
            manager_action='retry_once',
            manager_reason=str(classification.get('classifier_reason') or 'selected model should be confirmed once before configuration changes'),
            next_step='check_selected_model_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'selected_model_mismatch_retry_runtime_confirmation' if final_state == 'selected_model_mismatch' else 'selected_model_not_ready_retry_once',
                'matched_on': build_classifier_matched_on(classification),
                'selected_action': 'retry_once',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if (
        final_state == 'selected_model_not_ready'
        and retry.get('retry_allowed') is False
    ):
        output = build_policy_output(
            manager_action='configure_model',
            manager_reason='selected model is not ready and retry is not allowed, so model configuration should be revisited',
            next_step='check_selected_model_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'selected_model_not_ready_configure_model_no_retry',
                'matched_on': {
                    'final_state': final_state,
                    'retry_allowed': False,
                },
                'selected_action': 'configure_model',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if (
        final_state == 'selected_model_mismatch'
        and (
            retry_decision == 'skip_restart_repeated_mismatch'
            or repeated_decision_detected
        )
    ):
        output = build_policy_output(
            manager_action='stop_and_surface_diff',
            manager_reason='the same selected-model mismatch repeated, so manager should stop and surface the expected/runtime model diff instead of restarting',
            next_step='check_selected_model_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'selected_model_mismatch_stop_and_surface_diff',
                'matched_on': {
                    'final_state': final_state,
                    'retry_decision': retry_decision,
                    'repeated_decision_detected': repeated_decision_detected,
                },
                'selected_action': 'stop_and_surface_diff',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'capability_limited':
        output = build_policy_output(
            manager_action='review_runtime_capabilities',
            manager_reason='runtime capabilities are limited and capability review should be performed before runtime work',
            next_step='review_runtime_capabilities',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'capability_limited_review_runtime_capabilities',
                'matched_on': {'final_state': final_state},
                'selected_action': 'review_runtime_capabilities',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'default_model_missing':
        output = build_policy_output(
            manager_action='configure_model',
            manager_reason='default model configuration is missing and model remediation should continue',
            next_step='check_default_model_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'default_model_missing_configure_model',
                'matched_on': {'final_state': final_state},
                'selected_action': 'configure_model',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'selected_model_missing':
        output = build_policy_output(
            manager_action='configure_model',
            manager_reason='selected model configuration is missing and selected-model remediation should continue',
            next_step='check_selected_model_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'selected_model_missing_configure_model',
                'matched_on': {'final_state': final_state},
                'selected_action': 'configure_model',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'gpu_not_ready':
        output = build_policy_output(
            manager_action='configure_gpu_runtime',
            manager_reason='gpu runtime is not ready and gpu remediation should continue before runtime work',
            next_step='configure_gpu_runtime',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'gpu_not_ready_configure_gpu_runtime',
                'matched_on': {'final_state': final_state},
                'selected_action': 'configure_gpu_runtime',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'nim_not_ready':
        output = build_policy_output(
            manager_action='start_nim_runtime',
            manager_reason='nim runtime is not ready and nim remediation should continue before runtime work',
            next_step='start_nim_runtime',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'nim_not_ready_start_nim_runtime',
                'matched_on': {'final_state': final_state},
                'selected_action': 'start_nim_runtime',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if classified_issue == 'selected_model_provider_issue':
        output = build_policy_output(
            manager_action='configure_provider',
            manager_reason='selected model mismatch appears to come from provider resolution, so provider remediation should continue before runtime work',
            next_step='check_provider_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'selected_model_mismatch_configure_provider',
                'matched_on': build_classifier_matched_on(classification),
                'selected_action': 'configure_provider',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if classified_issue == 'selected_model_mismatch_issue':
        output = build_policy_output(
            manager_action='configure_model',
            manager_reason='selected model differs from configured selected model and model remediation should continue before runtime work',
            next_step='check_selected_model_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'selected_model_mismatch_configure_model',
                'matched_on': build_classifier_matched_on(classification),
                'selected_action': 'configure_model',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'model_not_ready':
        output = build_policy_output(
            manager_action='configure_model',
            manager_reason='model is not ready and model configuration should be revisited before runtime work',
            next_step='check_model_config',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'model_not_ready_configure_model',
                'matched_on': {'final_state': final_state},
                'selected_action': 'configure_model',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'ready_for_runtime_task':
        output = build_policy_output(
            manager_action='run_runtime_task',
            manager_reason='runtime evaluation indicates provider, model, and readiness checks are satisfied enough to run the requested runtime task',
            next_step='run_runtime_task',
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'ready_for_runtime_task_run_runtime_task',
                'matched_on': {'final_state': final_state},
                'selected_action': 'run_runtime_task',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if retry_decision == 'runtime_model_confirmed':
        output = build_policy_output(
            manager_action='run_next_step',
            manager_reason='runtime status confirmed the selected model, so manager can continue with the next planned runtime step',
            next_step=next_step,
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'runtime_model_confirmed_run_next_step',
                'matched_on': {'retry_decision': retry_decision},
                'selected_action': 'run_next_step',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state == 'manager_action_required':
        output = build_policy_output(
            manager_action='run_next_step',
            manager_reason='routing evaluation produced a manager-owned next step that should be executed without additional retry logic',
            next_step=next_step,
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'manager_action_required_run_next_step',
                'matched_on': {'final_state': final_state, 'next_step': next_step},
                'selected_action': 'run_next_step',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    if final_state in set():
        output = build_policy_output(
            manager_action='manual_review',
            manager_reason='routing evaluation found a concrete remediation state that should be handled explicitly by manager policy or an operator',
            next_step=next_step,
            retry_decision=retry_decision,
            policy_input=policy_input,
            policy_trace={
                'rule_id': 'explicit_runtime_state_manual_review',
                'matched_on': {'final_state': final_state, 'next_step': next_step},
                'selected_action': 'manual_review',
            },
        )
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0

    output = build_policy_output(
        manager_action=str(classification.get('fallback_action') or 'stop'),
        manager_reason='runtime evaluation requires manual review because no deterministic manager policy rule matched',
        next_step=next_step,
        retry_decision=retry_decision,
        policy_input=policy_input,
        policy_trace={
            'rule_id': 'fallback_stop',
            'matched_on': {
                'final_state': final_state,
                'next_step': next_step,
                'retry_decision': retry_decision,
                'primary_issue': classification.get('primary_issue'),
                'secondary_issues': classification.get('secondary_issues', []),
                'priority': classification.get('priority'),
                'confidence': classification.get('confidence'),
            },
            'selected_action': str(classification.get('fallback_action') or 'stop'),
        },
    )
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
from __future__ import annotations


def _as_dict(value):
    return value if isinstance(value, dict) else {}


def _as_list(value):
    return value if isinstance(value, list) else []


def _append_issue(issues: list[str], issue: str) -> None:
    if issue not in issues:
        issues.append(issue)


def classify_manager_signal(payload: dict) -> dict:
    policy_input = _as_dict(payload.get('policy_input'))
    final_state = str(payload.get('final_state') or 'unknown')
    retry = _as_dict(payload.get('retry'))
    retry_decision = retry.get('retry_decision')

    provider_status = _as_dict(policy_input.get('provider_status') or payload.get('provider_status'))
    gpu_status = _as_dict(policy_input.get('gpu_status') or payload.get('gpu_status'))
    nim_status_info = _as_dict(policy_input.get('nim_status_info') or payload.get('nim_status_info'))

    selected_model_diff_reason = str(
        policy_input.get('selected_model_diff_reason')
        or payload.get('selected_model_diff_reason')
        or ''
    )
    selected_model_runtime_recognized = (
        policy_input.get('selected_model_runtime_recognized')
        if 'selected_model_runtime_recognized' in policy_input
        else payload.get('selected_model_runtime_recognized')
    )
    provider_runtime_recognized = (
        policy_input.get('provider_runtime_recognized')
        if 'provider_runtime_recognized' in policy_input
        else payload.get('provider_runtime_recognized')
    )
    selected_model_expected = (
        policy_input.get('selected_model_expected')
        if 'selected_model_expected' in policy_input
        else payload.get('selected_model_expected')
    )
    selected_model_runtime = (
        policy_input.get('selected_model_runtime')
        if 'selected_model_runtime' in policy_input
        else payload.get('selected_model_runtime')
    )
    provider_name = (
        policy_input.get('provider')
        if 'provider' in policy_input
        else payload.get('provider')
    )

    provider_missing_requirements = _as_list(provider_status.get('missing_requirements'))
    provider_missing_api_keys = _as_list(provider_status.get('missing_api_keys'))
    provider_api_required = provider_status.get('api_key_required')
    provider_api_present = provider_status.get('api_key_present')
    provider_config_present = provider_status.get('provider_config_present')
    provider_runtime_recognized_nested = provider_status.get('provider_runtime_recognized')
    gpu_ready = gpu_status.get('gpu_ready')
    nim_ready = nim_status_info.get('nim_ready')

    has_provider_api_signal = (
        provider_api_required is True and provider_api_present is False
    ) or bool(provider_missing_api_keys) or any(
        isinstance(item, str) and (
            item.startswith('API key missing:')
            or item == 'API key missing'
            or item == 'API key may be required'
        )
        for item in provider_missing_requirements
    )
    has_provider_recognition_signal = (
        provider_config_present is True and provider_runtime_recognized_nested is False
    ) or any(
        isinstance(item, str) and item in {
            'provider runtime not recognizing configured provider',
            'provider configuration missing',
            'provider source unknown',
        }
        for item in provider_missing_requirements
    )
    has_runtime_capability_signal = (
        gpu_ready is False
        or nim_ready is False
        or any(
            isinstance(item, str) and item in {
                'nim is not running',
                'gpu runtime not enabled',
                'nvidia policy missing',
                'runtime not connected',
                'sandbox not ready',
            }
            for item in provider_missing_requirements
        )
    )

    candidate_issues: list[str] = []
    confidence = 0.25
    priority = 'low'
    classifier_reason = 'no specialized provider/model signal classification matched'

    if final_state in {'provider_api_key_missing'} or (
        final_state == 'provider_not_ready' and has_provider_api_signal
    ):
        _append_issue(candidate_issues, 'provider_api_key_issue')
    if final_state == 'provider_not_ready' and has_provider_recognition_signal:
        _append_issue(candidate_issues, 'provider_recognition_issue')
    if final_state == 'provider_not_ready' and (
        nim_ready is False
        or any(isinstance(item, str) and item == 'nim is not running' for item in provider_missing_requirements)
    ):
        _append_issue(candidate_issues, 'runtime_capability_issue_nim')
    if final_state == 'provider_not_ready' and has_runtime_capability_signal and 'runtime_capability_issue_nim' not in candidate_issues:
        _append_issue(candidate_issues, 'runtime_capability_issue_gpu')
    if (
        final_state == 'selected_model_not_ready'
        and retry_decision == 'recheck_runtime_status_once'
        and retry.get('retry_allowed') is True
    ) or (
        final_state == 'selected_model_mismatch'
        and selected_model_runtime_recognized is False
    ):
        _append_issue(candidate_issues, 'selected_model_retry_issue')
    if final_state == 'selected_model_mismatch' and (
        provider_runtime_recognized is False
        or 'provider runtime not recognizing configured provider' in selected_model_diff_reason.lower()
        or 'provider' in selected_model_diff_reason.lower()
    ):
        _append_issue(candidate_issues, 'selected_model_provider_issue')
    if final_state == 'selected_model_mismatch' and selected_model_runtime_recognized is not False:
        _append_issue(candidate_issues, 'selected_model_mismatch_issue')

    primary_issue = candidate_issues[0] if candidate_issues else 'none'
    secondary_issues = candidate_issues[1:] if len(candidate_issues) > 1 else []
    classified_issue = primary_issue

    if primary_issue == 'provider_api_key_issue':
        classifier_reason = 'provider readiness is blocked by missing API key requirements'
        priority = 'high'
        confidence = 0.92 if bool(provider_missing_api_keys) or provider_api_required is True else 0.78
    elif primary_issue == 'provider_recognition_issue':
        classifier_reason = 'provider is configured but runtime is not yet recognizing it'
        priority = 'high'
        confidence = 0.82 if provider_config_present is True and provider_runtime_recognized_nested is False else 0.68
    elif primary_issue == 'runtime_capability_issue_nim':
        classifier_reason = 'provider readiness is blocked by NIM runtime availability'
        priority = 'medium'
        confidence = 0.80 if nim_ready is False else 0.64
    elif primary_issue == 'runtime_capability_issue_gpu':
        classifier_reason = 'provider readiness is blocked by GPU/runtime capability limitations'
        priority = 'medium'
        confidence = 0.76 if gpu_ready is False else 0.60
    elif primary_issue == 'selected_model_retry_issue':
        classifier_reason = 'selected model needs one runtime confirmation retry before configuration changes'
        priority = 'low'
        confidence = 0.74 if retry_decision == 'recheck_runtime_status_once' or selected_model_runtime_recognized is False else 0.58
    elif primary_issue == 'selected_model_provider_issue':
        classifier_reason = 'selected-model mismatch appears to be caused by provider resolution'
        priority = 'high'
        confidence = 0.80 if provider_runtime_recognized is False else 0.66
    elif primary_issue == 'selected_model_mismatch_issue':
        classifier_reason = 'selected-model mismatch appears to be a direct model-name mismatch'
        priority = 'medium'
        confidence = 0.78 if selected_model_expected and selected_model_runtime else 0.61

    return {
        'classified_issue': classified_issue,
        'primary_issue': primary_issue,
        'secondary_issues': secondary_issues,
        'classifier_reason': classifier_reason,
        'classifier_version': 'v2',
        'priority': priority,
        'confidence': confidence,
        'fallback_action': 'manual_review',
        'final_state': final_state,
        'provider': provider_name,
        'provider_runtime_recognized': provider_runtime_recognized,
        'provider_status': provider_status,
        'gpu_status': gpu_status,
        'nim_status_info': nim_status_info,
        'selected_model_expected': selected_model_expected,
        'selected_model_runtime': selected_model_runtime,
        'selected_model_runtime_recognized': selected_model_runtime_recognized,
        'selected_model_diff_reason': selected_model_diff_reason,
        'retry_decision': retry_decision,
        'retry_allowed': retry.get('retry_allowed'),
    }

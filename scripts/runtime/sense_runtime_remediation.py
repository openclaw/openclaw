#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

BACKOFF_SCHEDULE = [2, 4, 8]
OPENCLAW_CONFIG_PATH = Path.home() / '.openclaw' / 'openclaw.json'
KNOWN_API_KEY_ENV_VARS = [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'NVIDIA_API_KEY',
    'OPENROUTER_API_KEY',
    'OLLAMA_API_KEY',
]
PROVIDER_ENV_VAR_MAP = {
    'openai': 'OPENAI_API_KEY',
    'anthropic': 'ANTHROPIC_API_KEY',
    'nvidia': 'NVIDIA_API_KEY',
    'nim': 'NVIDIA_API_KEY',
    'gpu-runtime': 'NVIDIA_API_KEY',
    'openrouter': 'OPENROUTER_API_KEY',
    'ollama': 'OLLAMA_API_KEY',
}
PROVIDER_REQUIRED_API_KEY_MAP = {
    'openai': 'OPENAI_API_KEY',
    'anthropic': 'ANTHROPIC_API_KEY',
    'nvidia': 'NVIDIA_API_KEY',
    'nim': 'NVIDIA_API_KEY',
    'gpu-runtime': 'NVIDIA_API_KEY',
    'openrouter': 'OPENROUTER_API_KEY',
}
KNOWN_PROVIDER_NAMES = ['openai', 'anthropic', 'ollama', 'nvidia', 'openrouter']

PRIORITIZED_REQUIREMENT_STEPS = [
    ('API key missing:', 'check_api_key_config'),
    ('API key missing', 'check_api_key_config'),
    ('API key may be required', 'check_api_key_config'),
    ('provider configuration missing', 'check_provider_config'),
    ('model configuration missing', 'check_model_config'),
    ('nim is not running', 'start_nim_runtime'),
    ('gpu runtime not enabled', 'enable_gpu_runtime'),
    ('nvidia policy missing', 'review_runtime_capabilities'),
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description='Minimal remediation helper for Sense runtime readiness decisions.'
    )
    parser.add_argument('--token', required=True)
    parser.add_argument('--sandbox-name', required=True)
    parser.add_argument('--recommended-action')
    parser.add_argument('--timeout', type=float)
    parser.add_argument('--wait-timeout', type=float)
    parser.add_argument('--poll-interval', type=float)
    parser.add_argument('--input')
    return parser


def run_cmd(cmd: list[str], stdin_text: str | None = None) -> tuple[int, str, str]:
    completed = subprocess.run(
        cmd,
        input=stdin_text,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed.returncode, completed.stdout, completed.stderr


def run_json(cmd: list[str], stdin_text: str | None = None) -> dict:
    code, stdout, stderr = run_cmd(cmd, stdin_text=stdin_text)
    if code != 0:
        if stderr:
            sys.stderr.write(stderr)
            if not stderr.endswith('\n'):
                sys.stderr.write('\n')
        raise SystemExit(code)
    return json.loads(stdout)


def tool_cmd(script_dir: Path, script_name: str, *args: str) -> list[str]:
    return [str(script_dir / script_name), *args]


def maybe_append_runtime_args(cmd: list[str], args: argparse.Namespace) -> list[str]:
    enriched = list(cmd)
    if args.timeout is not None:
        enriched.extend(['--timeout', str(args.timeout)])
    if args.wait_timeout is not None:
        enriched.extend(['--wait-timeout', str(args.wait_timeout)])
    if args.poll_interval is not None:
        enriched.extend(['--poll-interval', str(args.poll_interval)])
    if args.input:
        enriched.extend(['--input', args.input])
    return enriched


def get_decision(script_dir: Path, args: argparse.Namespace) -> dict:
    cmd = tool_cmd(
        script_dir,
        'sense-runtime-decision.sh',
        '--token', args.token,
        '--sandbox-name', args.sandbox_name,
    )
    cmd = maybe_append_runtime_args(cmd, args)
    return run_json(cmd)


def get_sandbox_status(script_dir: Path, args: argparse.Namespace) -> dict:
    cmd = tool_cmd(
        script_dir,
        'sense-runtime-manager-tool.sh',
        '--intent', 'sense sandbox status',
        '--token', args.token,
        '--sandbox-name', args.sandbox_name,
    )
    cmd = maybe_append_runtime_args(cmd, args)
    return run_json(cmd)


def get_runtime_status(script_dir: Path, args: argparse.Namespace) -> dict:
    cmd = tool_cmd(
        script_dir,
        'sense-runtime-manager-tool.sh',
        '--intent', 'sense runtime status',
        '--token', args.token,
    )
    cmd = maybe_append_runtime_args(cmd, args)
    return run_json(cmd)


def run_runtime_start(script_dir: Path, args: argparse.Namespace) -> dict:
    cmd = tool_cmd(
        script_dir,
        'sense-runtime-manager-tool.sh',
        '--intent', 'sense runtime start',
        '--token', args.token,
    )
    cmd = maybe_append_runtime_args(cmd, args)
    return run_json(cmd)


def load_openclaw_config() -> tuple[dict, list[str]]:
    checked_sources: list[str] = []
    if OPENCLAW_CONFIG_PATH.exists():
        checked_sources.append('config')
        try:
            payload = json.loads(OPENCLAW_CONFIG_PATH.read_text())
        except (OSError, json.JSONDecodeError):
            return {}, checked_sources
        if isinstance(payload, dict):
            return payload, checked_sources
    return {}, checked_sources


def infer_provider_and_model_from_config(config: dict) -> dict:
    provider = 'unknown'
    provider_source = None
    model = 'unknown'
    model_source = None

    models_cfg = config.get('models') if isinstance(config.get('models'), dict) else {}
    providers_cfg = models_cfg.get('providers') if isinstance(models_cfg.get('providers'), dict) else {}
    defaults_cfg = config.get('agents') if isinstance(config.get('agents'), dict) else {}
    defaults_cfg = defaults_cfg.get('defaults') if isinstance(defaults_cfg.get('defaults'), dict) else {}
    default_model_cfg = defaults_cfg.get('model') if isinstance(defaults_cfg.get('model'), dict) else {}
    primary_model = default_model_cfg.get('primary')

    if isinstance(primary_model, str) and primary_model:
        if '/' in primary_model:
            provider_part, model_part = primary_model.split('/', 1)
            if provider_part:
                provider = provider_part
                provider_source = 'config'
            if model_part:
                model = model_part
                model_source = 'config'
        else:
            model = primary_model
            model_source = 'config'

    if provider == 'unknown' and providers_cfg:
        provider = next(iter(providers_cfg.keys()))
        provider_source = 'config'

    provider_cfg = providers_cfg.get(provider) if isinstance(providers_cfg.get(provider), dict) else {}
    if model == 'unknown' and provider_cfg:
        models = provider_cfg.get('models') if isinstance(provider_cfg.get('models'), list) else []
        for candidate in models:
            if not isinstance(candidate, dict):
                continue
            model_id = candidate.get('id') or candidate.get('name')
            if isinstance(model_id, str) and model_id:
                model = model_id
                model_source = 'config'
                break

    return {
        'provider': provider,
        'provider_source': provider_source,
        'model': model,
        'model_source': model_source,
    }


def collect_runtime_text(payload: dict | None) -> str:
    if not isinstance(payload, dict):
        return ''
    chunks: list[str] = []
    summary = payload.get('summary')
    if isinstance(summary, str):
        chunks.append(summary)
    key_points = payload.get('key_points')
    if isinstance(key_points, list):
        for item in key_points:
            if isinstance(item, str):
                chunks.append(item)
    details = payload.get('details')
    if isinstance(details, dict):
        raw_output = details.get('raw_output')
        if isinstance(raw_output, str):
            chunks.append(raw_output)
    return '\n'.join(chunks)


def infer_provider_from_runtime_payloads(
    sandbox_signals: dict,
    start_result: dict | None,
    runtime_status: dict | None,
) -> dict:
    sandbox_provider = str(sandbox_signals.get('provider') or 'unknown')
    if sandbox_provider not in {'', 'unknown'}:
        return {
            'provider': sandbox_provider,
            'provider_runtime_recognized': True,
            'provider_runtime_source': 'sandbox-status',
        }

    for source_name, payload in [('start-result', start_result), ('runtime', runtime_status)]:
        text = collect_runtime_text(payload).lower()
        for provider_name in KNOWN_PROVIDER_NAMES:
            if provider_name in text:
                return {
                    'provider': provider_name,
                    'provider_runtime_recognized': True,
                    'provider_runtime_source': source_name,
                }

    return {
        'provider': 'unknown',
        'provider_runtime_recognized': False,
        'provider_runtime_source': None,
    }


def infer_model_from_runtime_payloads(
    sandbox_signals: dict,
    start_result: dict | None,
    runtime_status: dict | None,
) -> dict:
    sandbox_model = str(sandbox_signals.get('model') or 'unknown')
    if sandbox_model not in {'', 'unknown'}:
        return {
            'model': sandbox_model,
            'model_runtime_recognized': True,
            'model_runtime_source': 'sandbox-status',
        }

    for source_name, payload in [('start-result', start_result), ('runtime', runtime_status)]:
        text = collect_runtime_text(payload)
        lowered = text.lower()
        for marker in ['using model ', 'model=', 'model: ']:
            idx = lowered.find(marker)
            if idx >= 0:
                raw = text[idx + len(marker):].splitlines()[0].strip()
                raw = raw.strip(' ."\'')
                if raw:
                    token = raw.split()[0].strip(',"\']')
                    if token and token.lower() not in {'unknown', 'none'}:
                        return {
                            'model': token,
                            'model_runtime_recognized': True,
                            'model_runtime_source': source_name,
                        }

    return {
        'model': 'unknown',
        'model_runtime_recognized': False,
        'model_runtime_source': None,
    }


def merge_provider_model_sources(runtime_signals: dict, config: dict, start_result: dict | None = None, runtime_status: dict | None = None) -> dict:
    merged = dict(runtime_signals)
    config_signals = infer_provider_and_model_from_config(config)
    runtime_provider_signals = infer_provider_from_runtime_payloads(merged, start_result, runtime_status)
    runtime_model_signals = infer_model_from_runtime_payloads(merged, start_result, runtime_status)
    runtime_provider = str(runtime_provider_signals.get('provider') or merged.get('provider') or 'unknown')
    runtime_model = str(runtime_model_signals.get('model') or merged.get('model') or 'unknown')
    merged['provider_runtime_recognized'] = runtime_provider_signals.get('provider_runtime_recognized', False)
    merged['provider_runtime_source'] = runtime_provider_signals.get('provider_runtime_source')
    merged['model_runtime_recognized'] = runtime_model_signals.get('model_runtime_recognized', False)
    merged['model_runtime_source'] = runtime_model_signals.get('model_runtime_source')
    if runtime_provider not in {'', 'unknown'}:
        merged['provider'] = runtime_provider
        merged['provider_source'] = runtime_provider_signals.get('provider_runtime_source') or 'runtime'
    else:
        merged['provider'] = config_signals.get('provider', 'unknown')
        merged['provider_source'] = config_signals.get('provider_source')
    if runtime_model not in {'', 'unknown'}:
        merged['model'] = runtime_model
        merged['model_source'] = runtime_model_signals.get('model_runtime_source') or 'runtime'
    else:
        merged['model'] = config_signals.get('model', 'unknown')
        merged['model_source'] = config_signals.get('model_source')

    return merged


def infer_required_api_key_names(provider_status: dict, start_result: dict | None) -> list[str]:
    provider = str(provider_status.get('provider') or 'unknown').lower()
    required: list[str] = []
    provider_hints = {provider}
    runtime_name = str(provider_status.get('runtime_name') or '').lower()
    nim_status = str(provider_status.get('nim_status') or '').lower()
    policy_names = provider_status.get('policy_names') if isinstance(provider_status.get('policy_names'), list) else []
    if runtime_name:
        provider_hints.add(runtime_name)
    if nim_status in {'running', 'not running'}:
        provider_hints.add('nim')
    if 'nvidia' in [str(item).lower() for item in policy_names]:
        provider_hints.add('nvidia')

    for hint in provider_hints:
        mapped = PROVIDER_REQUIRED_API_KEY_MAP.get(hint)
        if mapped and mapped not in required:
            required.append(mapped)

    haystacks: list[str] = []
    if isinstance(start_result, dict):
        summary = start_result.get('summary')
        if isinstance(summary, str):
            haystacks.append(summary.lower())
        key_points = start_result.get('key_points')
        if isinstance(key_points, list):
            for item in key_points:
                if isinstance(item, str):
                    haystacks.append(item.lower())
    text = ' '.join(haystacks)
    if 'nvidia api key' in text and 'NVIDIA_API_KEY' not in required:
        required.insert(0, 'NVIDIA_API_KEY')
    if 'openai api key' in text and 'OPENAI_API_KEY' not in required:
        required.insert(0, 'OPENAI_API_KEY')
    if 'anthropic api key' in text and 'ANTHROPIC_API_KEY' not in required:
        required.insert(0, 'ANTHROPIC_API_KEY')
    if 'openrouter api key' in text and 'OPENROUTER_API_KEY' not in required:
        required.insert(0, 'OPENROUTER_API_KEY')

    deduped: list[str] = []
    for item in required:
        if item not in deduped:
            deduped.append(item)
    return deduped


def check_api_key_presence(config: dict, provider_status: dict, start_result: dict | None) -> dict:
    checked_sources = ['env']
    present_keys: list[str] = []
    required_key_names = infer_required_api_key_names(provider_status, start_result)
    keys_to_check = list(KNOWN_API_KEY_ENV_VARS)
    unknown_required_api_keys = len(required_key_names) == 0

    for env_name in keys_to_check:
        if bool(os.environ.get(env_name)):
            present_keys.append(env_name)

    providers_cfg = {}
    models_cfg = config.get('models') if isinstance(config.get('models'), dict) else {}
    if isinstance(models_cfg.get('providers'), dict):
        providers_cfg = models_cfg.get('providers')
    if providers_cfg:
        checked_sources.append('config')
    for provider_name, provider_cfg in providers_cfg.items():
        if not isinstance(provider_cfg, dict):
            continue
        env_name = PROVIDER_ENV_VAR_MAP.get(str(provider_name).lower())
        if env_name and env_name in keys_to_check and provider_cfg.get('apiKey'):
            present_keys.append(env_name)

    deduped_keys: list[str] = []
    for item in present_keys:
        if item not in deduped_keys:
            deduped_keys.append(item)

    missing_api_keys = [key for key in required_key_names if key not in deduped_keys]
    api_key_required = bool(required_key_names)
    api_key_present = len(missing_api_keys) == 0 if api_key_required else len(deduped_keys) > 0
    return {
        'api_key_required': api_key_required,
        'api_key_present': api_key_present,
        'api_key_check_mode': 'provider-specific',
        'required_api_keys': required_key_names,
        'present_keys': deduped_keys,
        'missing_api_keys': missing_api_keys,
        'unknown_required_api_keys': unknown_required_api_keys,
        'checked_sources': checked_sources,
        'detected_keys': deduped_keys,
    }


def summarize_capabilities(sandbox_payload: dict) -> dict:
    details = sandbox_payload.get('details') if isinstance(sandbox_payload, dict) else None
    sandbox_status = details.get('sandbox_status') if isinstance(details, dict) else {}
    if not isinstance(sandbox_status, dict):
        sandbox_status = {}
    return {
        'sandbox_name': sandbox_status.get('sandbox_name'),
        'phase': sandbox_status.get('phase'),
        'gpu_enabled': sandbox_status.get('gpu_enabled'),
        'policy_names': sandbox_status.get('policy_names') or [],
        'runtime_name': sandbox_status.get('runtime_name'),
        'openshell_status': sandbox_status.get('openshell_status'),
        'nim_status': sandbox_status.get('nim_status'),
        'provider': sandbox_status.get('provider'),
        'model': sandbox_status.get('model'),
    }


def infer_missing_requirements(provider_status: dict, start_result: dict | None) -> list[str]:
    missing: list[str] = []
    provider = str(provider_status.get('provider') or 'unknown')
    model = str(provider_status.get('model') or 'unknown')

    if provider in {'', 'unknown'}:
        missing.append('provider configuration missing')
        missing.append('provider source unknown')
    elif provider_status.get('provider_runtime_recognized') is False:
        missing.append('provider runtime not recognizing configured provider')
    if model in {'', 'unknown'}:
        missing.append('model configuration missing')
        missing.append('model source unknown')
    elif provider_status.get('model_runtime_recognized') is False:
        missing.append('runtime not recognizing configured model')

    api_key_names = provider_status.get('required_api_keys')
    if not isinstance(api_key_names, list):
        api_key_names = infer_required_api_key_names(provider_status, start_result)
    if api_key_names:
        missing.append('API key may be required')
    missing_api_keys = provider_status.get('missing_api_keys') if isinstance(provider_status.get('missing_api_keys'), list) else []
    for key_name in missing_api_keys:
        missing.append(f'API key missing: {key_name}')
    if provider_status.get('api_key_required') and provider_status.get('api_key_present') is False and not missing_api_keys:
        missing.append('API key missing')

    deduped: list[str] = []
    for item in missing:
        if item not in deduped:
            deduped.append(item)
    return deduped


def build_provider_status(provider_status: dict, start_result: dict | None, runtime_status: dict | None = None) -> dict:
    config, checked_sources = load_openclaw_config()
    status = merge_provider_model_sources(provider_status, config, start_result, runtime_status)
    api_key_status = check_api_key_presence(config, status, start_result)
    status.update(api_key_status)

    provider = str(status.get('provider') or 'unknown')
    model = str(status.get('model') or 'unknown')
    status['provider_config_present'] = provider not in {'', 'unknown'}
    status['model_config_present'] = model not in {'', 'unknown'}
    if status.get('provider_runtime_recognized') is None:
        status['provider_runtime_recognized'] = False
    if status.get('model_runtime_recognized') is None:
        status['model_runtime_recognized'] = False

    missing = infer_missing_requirements(status, start_result)
    status['checked_sources'] = checked_sources or ['env']
    status['provider_ready'] = (
        status.get('provider_config_present') is True
        and status.get('provider_runtime_recognized') is True
        and status.get('model_config_present') is True
        and (status.get('api_key_required') is False or status.get('api_key_present') is True)
    )
    status['missing_requirements'] = missing
    status['model_ready'] = (
        status.get('model_config_present') is True
        and status.get('model_runtime_recognized') is True
    )
    return status


def build_model_status(provider_status: dict) -> dict:
    model = str(provider_status.get('model') or 'unknown')
    model_status = {
        'model': model,
        'model_source': provider_status.get('model_source'),
        'model_runtime_source': provider_status.get('model_runtime_source'),
        'model_config_present': provider_status.get('model_config_present'),
        'model_runtime_recognized': provider_status.get('model_runtime_recognized'),
        'model_ready': provider_status.get('model_ready'),
        'missing_requirements': [],
    }
    missing: list[str] = []
    if model in {'', 'unknown'}:
        missing.append('model configuration missing')
        missing.append('model source unknown')
    elif provider_status.get('model_runtime_recognized') is False:
        missing.append('runtime not recognizing configured model')
    model_status['missing_requirements'] = missing
    return model_status


def run_provider_signal_check(script_dir: Path, args: argparse.Namespace, *, start_attempted: bool) -> dict:
    initial_sandbox_payload = get_sandbox_status(script_dir, args)
    initial_provider_status = build_provider_status(summarize_capabilities(initial_sandbox_payload), None, None)
    start_result = run_runtime_start(script_dir, args)
    runtime_status = get_runtime_status(script_dir, args)
    followup_sandbox_payload = get_sandbox_status(script_dir, args)
    followup_provider_status = build_provider_status(summarize_capabilities(followup_sandbox_payload), start_result, runtime_status)
    resolved_next_step = resolve_missing_requirements_next_step(followup_provider_status.get('missing_requirements'))
    return {
        'initial_provider_status': initial_provider_status,
        'provider_status': followup_provider_status,
        'resolved_next_step': resolved_next_step,
        'start_result': start_result,
        'runtime_status': runtime_status,
        'followup_status': followup_provider_status,
        'start_attempted': start_attempted,
    }


def infer_gpu_missing_requirements(gpu_status: dict) -> list[str]:
    missing: list[str] = []
    phase = str(gpu_status.get('phase') or 'unknown')
    gpu_enabled = gpu_status.get('gpu_enabled')
    nim_status = str(gpu_status.get('nim_status') or 'unknown')
    openshell_status = str(gpu_status.get('openshell_status') or 'unknown')
    policy_names = gpu_status.get('policy_names') if isinstance(gpu_status.get('policy_names'), list) else []

    if phase != 'Ready':
        missing.append('sandbox not ready')
    if gpu_enabled is False:
        missing.append('gpu runtime not enabled')
    if 'nvidia' not in policy_names:
        missing.append('nvidia policy missing')
    if nim_status.lower() != 'running':
        missing.append('nim is not running')
    if openshell_status.lower() != 'connected':
        missing.append('runtime not connected')

    deduped: list[str] = []
    for item in missing:
        if item not in deduped:
            deduped.append(item)
    return deduped


def build_gpu_status(gpu_signals: dict) -> dict:
    status = dict(gpu_signals)
    policy_names = status.get('policy_names') if isinstance(status.get('policy_names'), list) else []
    status['nvidia_policy_present'] = 'nvidia' in policy_names
    status['gpu_required_policy_present'] = 'nvidia' in policy_names
    missing = infer_gpu_missing_requirements(status)
    status['missing_requirements'] = missing
    status['gpu_ready'] = len(missing) == 0
    return status


def annotate_gpu_status_from_start(gpu_status: dict, start_result: dict | None) -> dict:
    status = dict(gpu_status)
    missing = list(status.get('missing_requirements') or [])
    if isinstance(start_result, dict):
        haystacks = []
        summary = start_result.get('summary')
        if isinstance(summary, str):
            haystacks.append(summary.lower())
        for item in start_result.get('key_points') if isinstance(start_result.get('key_points'), list) else []:
            if isinstance(item, str):
                haystacks.append(item.lower())
        text = ' '.join(haystacks)
        if 'api key required' in text or 'nvidia api key' in text:
            missing.append('API key may be required')
    deduped = []
    for item in missing:
        if item not in deduped:
            deduped.append(item)
    status['missing_requirements'] = deduped
    status['gpu_ready'] = len(deduped) == 0
    return status


def resolve_missing_requirements_next_step(missing_requirements: list[str] | None) -> str | None:
    if not isinstance(missing_requirements, list):
        return None
    for requirement, next_step in PRIORITIZED_REQUIREMENT_STEPS:
        for missing in missing_requirements:
            if requirement.endswith(':'):
                if isinstance(missing, str) and missing.startswith(requirement):
                    return next_step
            elif requirement == missing:
                return next_step
    return None


def build_nim_status(nim_signals: dict, start_result: dict | None = None, *, start_attempted: bool = False) -> dict:
    status = dict(nim_signals)
    provider_status = build_provider_status(status, start_result)
    gpu_status = build_gpu_status(status)

    missing: list[str] = []
    phase = str(status.get('phase') or 'unknown')
    openshell_status = str(status.get('openshell_status') or 'unknown')
    nim_status = str(status.get('nim_status') or 'unknown')

    if phase != 'Ready':
        missing.append('sandbox not ready')
    if openshell_status.lower() != 'connected':
        missing.append('runtime not connected')
    if nim_status.lower() != 'running':
        missing.append('nim is not running')
    for item in provider_status.get('missing_requirements') or []:
        if item not in missing:
            missing.append(item)
    for item in gpu_status.get('missing_requirements') or []:
        if item not in missing:
            missing.append(item)

    deduped: list[str] = []
    for item in missing:
        if item not in deduped:
            deduped.append(item)

    status['missing_requirements'] = deduped
    status['runtime_connected'] = openshell_status.lower() == 'connected'
    status['provider_ready'] = provider_status.get('provider_ready')
    status['gpu_ready'] = gpu_status.get('gpu_ready')
    status['start_attempted'] = start_attempted
    status['nim_ready'] = (
        phase == 'Ready'
        and openshell_status.lower() == 'connected'
        and nim_status.lower() == 'running'
    )
    return status


def main() -> int:
    args = build_parser().parse_args()
    script_dir = Path(__file__).resolve().parent

    decision = get_decision(script_dir, args)
    recommended_action = args.recommended_action or str(decision.get('recommended_action') or '')
    readiness = str(decision.get('readiness') or 'unknown')

    response: dict = {
        'readiness': readiness,
        'recommended_action': recommended_action,
        'remediation_action': recommended_action,
        'reasons': decision.get('reasons') if isinstance(decision.get('reasons'), list) else [],
        'next_step': decision.get('next_step') or 'manual_review',
    }

    if recommended_action == 'check_runtime_provider':
        sandbox_payload = get_sandbox_status(script_dir, args)
        provider_signals = summarize_capabilities(sandbox_payload)
        start_result = run_runtime_start(script_dir, args)
        followup_status = get_decision(script_dir, args)
        runtime_status = get_runtime_status(script_dir, args)
        provider_status = build_provider_status(provider_signals, start_result, runtime_status)
        resolved_next_step = resolve_missing_requirements_next_step(provider_status.get('missing_requirements'))
        response['remediation_result'] = 'checked provider readiness and triggered sense runtime start'
        response['provider_status'] = provider_status
        response['missing_requirements'] = provider_status.get('missing_requirements') or []
        response['resolved_next_step'] = resolved_next_step
        response['start_result'] = start_result
        response['runtime_status'] = runtime_status
        response['followup_status'] = followup_status
        if provider_status.get('provider_ready') is False:
            response['next_step'] = resolved_next_step or 'configure_provider'
        else:
            response['next_step'] = followup_status.get('next_step') or response['next_step']
    elif recommended_action == 'check_api_key_config':
        provider_probe = run_provider_signal_check(script_dir, args, start_attempted=True)
        provider_status = dict(provider_probe['provider_status'])
        response['remediation_result'] = 'checked api key configuration against environment and runtime signals'
        response['provider_status'] = provider_status
        response['missing_requirements'] = provider_status.get('missing_requirements') or []
        response['resolved_next_step'] = 'check_provider_config' if provider_status.get('api_key_present') else 'configure_provider'
        response['initial_provider_status'] = provider_probe['initial_provider_status']
        response['start_result'] = provider_probe['start_result']
        response['runtime_status'] = provider_probe['runtime_status']
        response['followup_status'] = provider_probe['followup_status']
        response['next_step'] = response['resolved_next_step']
    elif recommended_action == 'check_provider_config':
        provider_probe = run_provider_signal_check(script_dir, args, start_attempted=True)
        provider_status = dict(provider_probe['provider_status'])
        response['remediation_result'] = 'checked provider configuration using runtime and config signals'
        response['provider_status'] = provider_status
        response['missing_requirements'] = provider_status.get('missing_requirements') or []
        response['resolved_next_step'] = 'check_model_config' if provider_status.get('provider_config_present') else 'configure_provider'
        response['initial_provider_status'] = provider_probe['initial_provider_status']
        response['start_result'] = provider_probe['start_result']
        response['runtime_status'] = provider_probe['runtime_status']
        response['followup_status'] = provider_probe['followup_status']
        response['next_step'] = response['resolved_next_step']
    elif recommended_action == 'check_model_config':
        provider_probe = run_provider_signal_check(script_dir, args, start_attempted=True)
        provider_status = dict(provider_probe['provider_status'])
        model_status = build_model_status(provider_status)
        response['remediation_result'] = 'checked model configuration using runtime and config signals'
        response['provider_status'] = provider_status
        response['model_status'] = model_status
        response['missing_requirements'] = model_status.get('missing_requirements') or []
        if provider_status.get('model_config_present') is False:
            response['resolved_next_step'] = 'configure_provider'
        elif provider_status.get('model_runtime_recognized') is False:
            response['resolved_next_step'] = 'check_model_config'
        else:
            response['resolved_next_step'] = 'run_runtime_task'
        response['initial_provider_status'] = provider_probe['initial_provider_status']
        response['start_result'] = provider_probe['start_result']
        response['runtime_status'] = provider_probe['runtime_status']
        response['followup_status'] = model_status
        response['next_step'] = response['resolved_next_step']
    elif recommended_action == 'configure_provider':
        provider_probe = run_provider_signal_check(script_dir, args, start_attempted=True)
        followup_provider_status = provider_probe['provider_status']
        resolved_next_step = provider_probe['resolved_next_step']
        response['remediation_result'] = 'checked provider signals; triggered sense runtime start; re-checked runtime and sandbox status'
        response['provider_status'] = followup_provider_status
        response['missing_requirements'] = followup_provider_status.get('missing_requirements') or []
        response['resolved_next_step'] = resolved_next_step
        response['initial_provider_status'] = provider_probe['initial_provider_status']
        response['start_result'] = provider_probe['start_result']
        response['runtime_status'] = provider_probe['runtime_status']
        response['followup_status'] = provider_probe['followup_status']
        if followup_provider_status.get('provider_ready') is True:
            response['next_step'] = 'run_runtime_task'
        else:
            response['next_step'] = resolved_next_step or 'configure_provider'
    elif recommended_action == 'check_gpu_runtime':
        sandbox_payload = get_sandbox_status(script_dir, args)
        gpu_status = build_gpu_status(summarize_capabilities(sandbox_payload))
        resolved_next_step = resolve_missing_requirements_next_step(gpu_status.get('missing_requirements'))
        response['remediation_result'] = 'checked gpu runtime readiness'
        response['gpu_status'] = gpu_status
        response['missing_requirements'] = gpu_status.get('missing_requirements') or []
        response['resolved_next_step'] = resolved_next_step
        response['followup_status'] = gpu_status
        if gpu_status.get('gpu_ready') is False:
            response['next_step'] = resolved_next_step or 'configure_gpu_runtime'
        else:
            response['next_step'] = 'inspect_gpu_runtime'
    elif recommended_action == 'configure_gpu_runtime':
        initial_sandbox_payload = get_sandbox_status(script_dir, args)
        initial_gpu_status = build_gpu_status(summarize_capabilities(initial_sandbox_payload))
        start_result = run_runtime_start(script_dir, args)
        runtime_status = get_runtime_status(script_dir, args)
        followup_sandbox_payload = get_sandbox_status(script_dir, args)
        followup_gpu_status = build_gpu_status(summarize_capabilities(followup_sandbox_payload))
        followup_gpu_status = annotate_gpu_status_from_start(followup_gpu_status, start_result)

        remediation_steps = ['checked sandbox gpu signals', 'triggered sense runtime start', 're-checked runtime and sandbox status']
        if initial_gpu_status.get('gpu_ready') and followup_gpu_status.get('gpu_ready'):
            remediation_steps.insert(1, 'gpu runtime already appeared ready before remediation')

        resolved_next_step = resolve_missing_requirements_next_step(followup_gpu_status.get('missing_requirements'))
        response['remediation_result'] = '; '.join(remediation_steps)
        response['gpu_status'] = followup_gpu_status
        response['missing_requirements'] = followup_gpu_status.get('missing_requirements') or []
        response['resolved_next_step'] = resolved_next_step
        response['initial_gpu_status'] = initial_gpu_status
        response['start_result'] = start_result
        response['runtime_status'] = runtime_status
        response['followup_status'] = followup_gpu_status
        if followup_gpu_status.get('gpu_ready') is True:
            response['next_step'] = 'run_runtime_task'
        else:
            response['next_step'] = resolved_next_step or 'configure_gpu_runtime'
    elif recommended_action == 'start_nim_runtime':
        initial_sandbox_payload = get_sandbox_status(script_dir, args)
        initial_nim_status = build_nim_status(summarize_capabilities(initial_sandbox_payload))
        start_result = run_runtime_start(script_dir, args)
        runtime_status = get_runtime_status(script_dir, args)
        followup_sandbox_payload = get_sandbox_status(script_dir, args)
        followup_nim_status = build_nim_status(
            summarize_capabilities(followup_sandbox_payload),
            start_result,
            start_attempted=True,
        )

        resolved_next_step = resolve_missing_requirements_next_step(followup_nim_status.get('missing_requirements'))
        response['remediation_result'] = 'checked nim runtime signals; triggered sense runtime start; re-checked runtime and sandbox status'
        response['nim_status_info'] = followup_nim_status
        response['missing_requirements'] = followup_nim_status.get('missing_requirements') or []
        response['resolved_next_step'] = resolved_next_step
        response['initial_nim_status'] = initial_nim_status
        response['start_result'] = start_result
        response['runtime_status'] = runtime_status
        response['followup_status'] = followup_nim_status
        if followup_nim_status.get('nim_ready') is True:
            response['next_step'] = 'run_runtime_task'
        else:
            response['next_step'] = resolved_next_step or 'start_nim_runtime'
    elif recommended_action == 'wait_for_runtime_ready':
        attempts: list[dict] = []
        last_decision = decision
        for delay in BACKOFF_SCHEDULE:
            attempts.append({'sleep_sec': delay, 'decision': last_decision})
            if str(last_decision.get('readiness') or '') == 'ready':
                break
            time.sleep(delay)
            last_decision = get_decision(script_dir, args)
        response['remediation_result'] = 'retried runtime readiness checks'
        response['followup_status'] = {
            'attempts': attempts,
            'final_decision': last_decision,
        }
        response['next_step'] = last_decision.get('next_step') or response['next_step']
    elif recommended_action == 'review_runtime_capabilities':
        sandbox_payload = get_sandbox_status(script_dir, args)
        response['remediation_result'] = 'reviewed runtime capabilities'
        response['followup_status'] = summarize_capabilities(sandbox_payload)
        response['next_step'] = 'review_runtime_capabilities'
    else:
        response['remediation_result'] = 'no remediation mapping found'
        response['followup_status'] = decision
        response['next_step'] = decision.get('next_step') or 'manual_review'

    print(json.dumps(response, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

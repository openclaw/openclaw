# /// script
# requires-python = ">=3.10"
# dependencies = ["requests"]
# ///

"""Run multi-step Krea AI pipelines. Chain generation, enhancement, and video in one command."""

import argparse
import json
import os
import re
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from krea_helpers import (
    get_api_key, api_post, api_get, poll_job, download_file, output_path,
    get_cu_estimate, ensure_image_url, send_notification,
    get_image_models, get_video_models, get_enhancers, get_default_enhancer_model,
    resolve_model as resolve,
)


def get_result_url(job):
    urls = job.get("result", {}).get("urls", [])
    if urls:
        return urls[0]
    return job.get("result", {}).get("video_url")


# ── Manifest (for --resume) ─────────────────────────────

def manifest_path(out_dir):
    base = out_dir or "."
    return os.path.join(base, ".pipeline-state.json")


def load_manifest(out_dir):
    path = manifest_path(out_dir)
    if os.path.isfile(path):
        with open(path) as f:
            return json.load(f)
    return {"steps": {}}


def save_manifest(out_dir, manifest):
    path = manifest_path(out_dir)
    os.makedirs(os.path.dirname(path), exist_ok=True) if os.path.dirname(path) else None
    with open(path, "w") as f:
        json.dump(manifest, f, indent=2)


# ── Template variable substitution ──────────────────────

def substitute_vars(obj, variables):
    """Recursively replace {{key}} in all string values."""
    if isinstance(obj, str):
        for key, val in variables.items():
            obj = obj.replace("{{" + key + "}}", val)
        return obj
    elif isinstance(obj, dict):
        return {k: substitute_vars(v, variables) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [substitute_vars(item, variables) for item in obj]
    return obj


def find_template_vars(obj):
    """Find all {{var}} references in the pipeline."""
    found = set()
    if isinstance(obj, str):
        found.update(re.findall(r"\{\{(\w+)\}\}", obj))
    elif isinstance(obj, dict):
        for v in obj.values():
            found.update(find_template_vars(v))
    elif isinstance(obj, list):
        for item in obj:
            found.update(find_template_vars(item))
    return found


# ── Validation ───────────────────────────────────────────

VALID_ACTIONS = {"generate_image", "generate_video", "enhance", "fan_out"}

REQUIRED_FIELDS = {
    "generate_image": ["prompt"],
    "generate_video": ["prompt"],
    "enhance": [],
    "fan_out": ["step"],
}


def validate_pipeline(steps):
    """Validate pipeline JSON before executing. Exits on error."""
    errors = []
    for i, step in enumerate(steps, 1):
        action = step.get("action")
        if not action:
            errors.append(f"Step {i}: missing 'action' field")
            continue
        if action not in VALID_ACTIONS:
            errors.append(f"Step {i}: invalid action '{action}'. Must be one of: {', '.join(sorted(VALID_ACTIONS))}")
            continue

        for field in REQUIRED_FIELDS.get(action, []):
            if field not in step:
                errors.append(f"Step {i} ({action}): missing required field '{field}'")

        if action == "enhance":
            if not step.get("use_previous") and not step.get("image_url"):
                errors.append(f"Step {i} (enhance): needs 'image_url' or 'use_previous: true'")
            if not step.get("use_previous"):
                if not step.get("width") or not step.get("height"):
                    errors.append(f"Step {i} (enhance): needs 'width' and 'height'")

        if step.get("use_previous") and i == 1:
            errors.append(f"Step {i}: 'use_previous' cannot be used on the first step")

        if action == "fan_out":
            if not step.get("use_previous") and not step.get("sources"):
                errors.append(f"Step {i} (fan_out): needs 'use_previous: true' or 'sources' list")
            sub = step.get("step", {})
            sub_action = sub.get("action")
            if sub_action and sub_action not in VALID_ACTIONS:
                errors.append(f"Step {i} (fan_out): sub-step has invalid action '{sub_action}'")

    if errors:
        print("Pipeline validation failed:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        sys.exit(1)


# ── Dry-run CU estimation ───────────────────────────────

def estimate_cu(steps, fan_out_multiplier=4):
    """Estimate total CU cost. fan_out_multiplier is assumed count of sources."""
    total = 0
    unknown = []
    for i, step in enumerate(steps, 1):
        action = step.get("action", "generate_image")
        if action == "fan_out":
            sub = step.get("step", {})
            sub_action = sub.get("action", "generate_image")
            model = sub.get("model") or sub.get("enhancer", "topaz-standard-enhance")
            cu = get_cu_estimate(sub_action, model)
            if cu is not None:
                step_cu = cu * fan_out_multiplier
                total += step_cu
                print(f"  Step {i} (fan_out x ~{fan_out_multiplier}): {sub_action} [{model}] ~{cu} x {fan_out_multiplier} = ~{step_cu} CU", file=sys.stderr)
            else:
                unknown.append(f"Step {i} fan_out [{model}]")
                print(f"  Step {i} (fan_out x ~{fan_out_multiplier}): {sub_action} [{model}] = ? CU (unknown)", file=sys.stderr)
        else:
            model = step.get("model") or step.get("enhancer", "topaz-standard-enhance")
            cu = get_cu_estimate(action, model)
            if cu is not None:
                total += cu
                print(f"  Step {i}: {action} [{model}] ~{cu} CU", file=sys.stderr)
            else:
                unknown.append(f"Step {i} [{model}]")
                print(f"  Step {i}: {action} [{model}] = ? CU (unknown)", file=sys.stderr)

    print(f"\n  Estimated total: ~{total} CU", file=sys.stderr)
    if unknown:
        print(f"  (Unknown costs for: {', '.join(unknown)})", file=sys.stderr)
    return total


# ── Progress tracker ─────────────────────────────────────

class ProgressTracker:
    def __init__(self, total_steps):
        self.total_steps = total_steps
        self.cu_spent = 0
        self.files_saved = 0

    def step_start(self, step_num, action, model=None):
        model_str = f" ({model})" if model else ""
        print(f"\n[Step {step_num}/{self.total_steps}] {action}{model_str}", file=sys.stderr)

    def add_cu(self, action, model):
        cu = get_cu_estimate(action, model)
        if cu:
            self.cu_spent += cu

    def add_files(self, count):
        self.files_saved += count

    def summary_line(self, step_num, action, model=None):
        model_str = f" ({model})" if model else ""
        print(
            f"[Step {step_num}/{self.total_steps}] {action}{model_str} — "
            f"~{self.cu_spent} CU spent — {self.files_saved} files saved",
            file=sys.stderr,
        )


# ── Parallel fan_out helper ─────────────────────────────

def _run_fan_out_job(api_key, endpoint, body, interval):
    """Submit a job and poll to completion. Returns the job result dict."""
    job = api_post(api_key, endpoint, body)
    return poll_job(api_key, job["job_id"], interval=interval)


def run_fan_out_parallel(api_key, sub_jobs, max_parallel):
    """Run fan_out sub-jobs in parallel with concurrency limit.
    sub_jobs: list of (endpoint, body, interval) tuples.
    Returns list of result dicts in order."""
    results = [None] * len(sub_jobs)
    semaphore = threading.Semaphore(max_parallel)

    def worker(idx, endpoint, body, interval):
        with semaphore:
            print(f"  --- fan_out {idx + 1}/{len(sub_jobs)} (parallel) ---", file=sys.stderr)
            results[idx] = _run_fan_out_job(api_key, endpoint, body, interval)

    threads = []
    for i, (endpoint, body, interval) in enumerate(sub_jobs):
        t = threading.Thread(target=worker, args=(i, endpoint, body, interval))
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    return results


# ── Step execution ───────────────────────────────────────

def run_step(api_key, step, step_num, total, prev_urls, out_dir=None, progress=None, max_parallel=3):
    """Execute a single pipeline step. Returns list of result URLs."""
    action = step.get("action", "generate_image")
    model = step.get("model") or step.get("enhancer", "")

    if progress:
        progress.step_start(step_num, action, model or None)
    else:
        print(f"\n=== Step {step_num}/{total}: {action} ===", file=sys.stderr)

    image_models = get_image_models()
    video_models = get_video_models()
    enhancers = get_enhancers()

    result_urls = []

    if action == "generate_image":
        endpoint = resolve(step.get("model", "nano-banana-2"), image_models, "/generate/image/")
        body = {"prompt": step["prompt"]}
        for k in ("width", "height", "seed", "steps", "batchSize", "quality", "aspectRatio", "resolution"):
            if k in step:
                body[k] = step[k]
        if "guidance_scale" in step:
            body["guidance_scale_flux"] = step["guidance_scale"]
        if step.get("use_previous") and prev_urls:
            if "flux" in step.get("model", "nano-banana-2"):
                body["imageUrl"] = prev_urls[0]
            else:
                body["imageUrls"] = [prev_urls[0]]
        elif "imageUrl" in step:
            body["imageUrl"] = step["imageUrl"]
        elif "imageUrls" in step:
            body["imageUrls"] = step["imageUrls"]
        if "styles" in step:
            body["styles"] = step["styles"]

        job = api_post(api_key, endpoint, body)
        result = poll_job(api_key, job["job_id"])
        result_urls = result.get("result", {}).get("urls", [])
        if progress:
            progress.add_cu("generate_image", step.get("model", "nano-banana-2"))

    elif action == "generate_video":
        endpoint = resolve(step.get("model", "veo-3.1-fast"), video_models, "/generate/video/")
        body = {"prompt": step["prompt"]}
        for k in ("duration", "aspectRatio", "resolution", "mode", "generateAudio"):
            if k in step:
                body[k] = step[k]
        if step.get("use_previous") and prev_urls:
            body["startImage"] = prev_urls[0]
        elif "startImage" in step:
            body["startImage"] = step["startImage"]
        if "endImage" in step:
            body["endImage"] = step["endImage"]

        job = api_post(api_key, endpoint, body)
        result = poll_job(api_key, job["job_id"], interval=5)
        url = get_result_url(result)
        if url:
            result_urls = [url]
        if progress:
            progress.add_cu("generate_video", step.get("model", "veo-3.1-fast"))

    elif action == "enhance":
        enhancer_name = step.get("enhancer", "topaz-standard-enhance")
        endpoint = resolve(enhancer_name, enhancers, "/generate/enhance/")
        image_url = step.get("image_url")
        if step.get("use_previous") and prev_urls:
            image_url = prev_urls[0]
        if not image_url:
            print("Error: enhance needs image_url or use_previous", file=sys.stderr)
            sys.exit(1)
        body = {
            "image_url": image_url,
            "width": step.get("width", 4096),
            "height": step.get("height", 4096),
        }
        model_val = step.get("model") or get_default_enhancer_model(enhancer_name)
        if model_val:
            body["model"] = model_val
        for k in ("prompt", "creativity", "face_enhancement", "sharpen", "denoise", "output_format"):
            if k in step:
                body[k] = step[k]

        job = api_post(api_key, endpoint, body)
        result = poll_job(api_key, job["job_id"], interval=5)
        result_urls = result.get("result", {}).get("urls", [])
        if progress:
            progress.add_cu("enhance", enhancer_name)

    elif action == "fan_out":
        sources = prev_urls if step.get("use_previous") else step.get("sources", [])
        sub_template = step.get("step")
        if not sub_template or not sources:
            print("Error: fan_out needs 'step' template and sources", file=sys.stderr)
            sys.exit(1)

        parallel = step.get("parallel", False)
        sub_steps_info = []

        if parallel:
            sub_jobs = []
            for i, src_url in enumerate(sources):
                sub = dict(sub_template)
                sub["use_previous"] = False
                sub_action = sub.get("action", "generate_image")

                if sub_action == "generate_image":
                    endpoint = resolve(sub.get("model", "nano-banana-2"), image_models, "/generate/image/")
                    body = {"prompt": sub.get("prompt", "")}
                    for k in ("width", "height", "seed", "steps", "batchSize", "quality", "aspectRatio", "resolution"):
                        if k in sub:
                            body[k] = sub[k]
                    if "guidance_scale" in sub:
                        body["guidance_scale_flux"] = sub["guidance_scale"]
                    if "flux" in sub.get("model", "nano-banana-2"):
                        body["imageUrl"] = src_url
                    else:
                        body["imageUrls"] = [src_url]
                    if "styles" in sub:
                        body["styles"] = sub["styles"]
                    interval = 3
                elif sub_action == "generate_video":
                    endpoint = resolve(sub.get("model", "veo-3.1-fast"), video_models, "/generate/video/")
                    body = {"prompt": sub.get("prompt", "")}
                    for k in ("duration", "aspectRatio", "resolution", "mode", "generateAudio"):
                        if k in sub:
                            body[k] = sub[k]
                    body["startImage"] = src_url
                    interval = 5
                elif sub_action == "enhance":
                    enhancer_name = sub.get("enhancer", "topaz-standard-enhance")
                    endpoint = resolve(enhancer_name, enhancers, "/generate/enhance/")
                    body = {
                        "image_url": src_url,
                        "width": sub.get("width", 4096),
                        "height": sub.get("height", 4096),
                    }
                    model_val = sub.get("model") or get_default_enhancer_model(enhancer_name)
                    if model_val:
                        body["model"] = model_val
                    for k in ("prompt", "creativity", "face_enhancement", "sharpen", "denoise", "output_format"):
                        if k in sub:
                            body[k] = sub[k]
                    interval = 5
                else:
                    print(f"Error: unsupported fan_out sub-action '{sub_action}'", file=sys.stderr)
                    sys.exit(1)

                iteration = str(i + 1)
                if "prompt" in body and "{i}" in body["prompt"]:
                    body["prompt"] = body["prompt"].replace("{i}", iteration)

                resolved_sub = dict(sub)
                if "filename" in resolved_sub and "{i}" in resolved_sub["filename"]:
                    resolved_sub["filename"] = resolved_sub["filename"].replace("{i}", iteration)

                sub_jobs.append((endpoint, body, interval))
                sub_steps_info.append(resolved_sub)

            results = run_fan_out_parallel(api_key, sub_jobs, max_parallel)

            for i, (result, sub) in enumerate(zip(results, sub_steps_info)):
                sub_action = sub.get("action", "generate_image")
                if sub_action == "generate_video":
                    url = get_result_url(result)
                    if url:
                        result_urls.append(url)
                else:
                    urls = result.get("result", {}).get("urls", [])
                    result_urls.extend(urls)
                if progress:
                    model = sub.get("model") or sub.get("enhancer", "topaz-standard-enhance")
                    progress.add_cu(sub_action, model)
        else:
            for i, src_url in enumerate(sources):
                print(f"\n  --- fan_out {i + 1}/{len(sources)} ---", file=sys.stderr)
                sub = dict(sub_template)
                sub["use_previous"] = False
                if sub.get("action") == "generate_image":
                    if "flux" in sub.get("model", "nano-banana-2"):
                        sub["imageUrl"] = src_url
                    else:
                        sub["imageUrls"] = [src_url]
                elif sub.get("action") == "generate_video":
                    sub["startImage"] = src_url
                elif sub.get("action") == "enhance":
                    sub["image_url"] = src_url
                if "prompt" in sub and "{i}" in sub["prompt"]:
                    sub["prompt"] = sub["prompt"].replace("{i}", str(i + 1))
                if "filename" in sub and "{i}" in sub["filename"]:
                    sub["filename"] = sub["filename"].replace("{i}", str(i + 1))
                urls = run_step(api_key, sub, f"{step_num}.{i + 1}", total, [src_url], out_dir, progress, max_parallel)
                result_urls.extend(urls)

    # Download results
    if action == "fan_out" and step.get("parallel", False) and sub_steps_info:
        ext = ".mp4" if step.get("step", {}).get("action") == "generate_video" else ".png"
        url_idx = 0
        for sub_info in sub_steps_info:
            sub_base = sub_info.get("filename", f"step-{step_num}-fan")
            if url_idx < len(result_urls):
                fname = f"{sub_base}{ext}" if not sub_base.endswith(ext) else sub_base
                path = download_file(result_urls[url_idx], output_path(fname, out_dir))
                print(f"  Saved: {path}", file=sys.stderr)
                if progress:
                    progress.add_files(1)
                url_idx += 1
    else:
        base_name = step.get("filename", f"step-{step_num}")
        for i, url in enumerate(result_urls):
            ext = ".mp4" if action == "generate_video" or (action == "fan_out" and step.get("step", {}).get("action") == "generate_video") else ".png"
            if len(result_urls) == 1:
                fname = f"{base_name}{ext}" if not base_name.endswith(ext) else base_name
            else:
                fname = f"{base_name}-{i + 1}{ext}"
            path = download_file(url, output_path(fname, out_dir))
            print(f"  Saved: {path}", file=sys.stderr)
            if progress:
                progress.add_files(1)

    if progress:
        progress.summary_line(step_num, action, model or None)

    print(f"  URLs: {result_urls}", file=sys.stderr)
    return result_urls


def main():
    parser = argparse.ArgumentParser(
        description="Run multi-step Krea AI pipelines",
        epilog='Example: pipeline.py --pipeline \'{"steps":[{"action":"generate_image","prompt":"a cat","filename":"cat"}]}\'',
    )
    parser.add_argument("--pipeline", required=True, help="Path to pipeline JSON file, or inline JSON string")
    parser.add_argument("--api-key", help="Krea API token")
    parser.add_argument("--dry-run", action="store_true", help="Estimate CU cost without executing")
    parser.add_argument("--resume", action="store_true", help="Skip completed steps (uses .pipeline-state.json manifest)")
    parser.add_argument("--output-dir", help="Output directory for all generated files")
    parser.add_argument("--max-parallel", type=int, default=3, help="Max concurrent jobs for parallel fan_out (default: 3)")
    parser.add_argument("--var", action="append", metavar="key=value", help="Template variable (repeatable). Replaces {{key}} in pipeline JSON")
    parser.add_argument("--notify", action="store_true", help="Send desktop notification when pipeline finishes")
    args = parser.parse_args()

    # Load pipeline
    if os.path.isfile(args.pipeline):
        with open(args.pipeline) as f:
            raw = f.read()
    else:
        raw = args.pipeline

    # Parse template variables
    variables = {}
    if args.var:
        for v in args.var:
            if "=" not in v:
                print(f"Error: --var must be key=value, got: {v}", file=sys.stderr)
                sys.exit(1)
            key, val = v.split("=", 1)
            variables[key] = val

    # Substitute variables before parsing JSON
    if variables:
        for key, val in variables.items():
            raw = raw.replace("{{" + key + "}}", val)

    pipeline = json.loads(raw)

    # Check for unresolved template variables
    unresolved = find_template_vars(pipeline)
    if unresolved:
        print(f"Error: Unresolved template variables: {', '.join('{{' + v + '}}' for v in sorted(unresolved))}", file=sys.stderr)
        print(f"  Provide them with --var, e.g.: --var {list(unresolved)[0]}=value", file=sys.stderr)
        sys.exit(1)

    steps = pipeline.get("steps", [])
    if not steps:
        print("Error: Pipeline has no steps", file=sys.stderr)
        sys.exit(1)

    # Validate
    validate_pipeline(steps)

    # Dry-run mode
    if args.dry_run:
        print("\n=== Dry Run: CU Cost Estimate ===\n", file=sys.stderr)
        estimate_cu(steps)
        return

    api_key = get_api_key(args.api_key)

    # Load manifest for --resume
    manifest = load_manifest(args.output_dir) if args.resume else {"steps": {}}

    prev_urls = []
    all_results = []
    progress = ProgressTracker(len(steps))

    for i, step in enumerate(steps, 1):
        step_key = str(i)

        if args.resume and step_key in manifest["steps"]:
            saved = manifest["steps"][step_key]
            saved_urls = saved.get("urls", [])
            print(f"\n[Step {i}/{len(steps)}] Skipping (completed) — {len(saved_urls)} URLs restored from manifest", file=sys.stderr)
            prev_urls = saved_urls
            all_results.append({"step": i, "action": step.get("action"), "skipped": True, "urls": saved_urls})
            continue

        urls = run_step(api_key, step, i, len(steps), prev_urls, args.output_dir, progress, args.max_parallel)
        prev_urls = urls
        all_results.append({"step": i, "action": step.get("action"), "urls": urls})

        manifest["steps"][step_key] = {"urls": urls, "action": step.get("action")}
        save_manifest(args.output_dir, manifest)

    print("\n=== Pipeline Complete ===", file=sys.stderr)
    print(f"  Total: ~{progress.cu_spent} CU spent, {progress.files_saved} files saved", file=sys.stderr)
    print(json.dumps(all_results, indent=2))

    if args.notify:
        send_notification(
            "Krea Pipeline Complete",
            f"~{progress.cu_spent} CU spent, {progress.files_saved} files generated",
        )


if __name__ == "__main__":
    main()

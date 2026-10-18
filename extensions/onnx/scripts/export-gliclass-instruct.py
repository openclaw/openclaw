#!/usr/bin/env python3
"""Export a pinned local GLiClass Instruct checkpoint for the ONNX plugin.

Requires Python 3.11+ and the package versions shown by --help. This script
does not install packages, download checkpoints, or load remote model code.
The export supports 2–64 labels and task instructions, without few-shot examples.
"""

import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile


PACKAGES = {
    "gliclass": "0.1.20",
    "torch": "2.9.1",
    "transformers": "5.3.0",
    "tokenizers": "0.22.2",
    "onnx": "1.19.1",
}

SOURCES = {
    "edge": {
        "revision": "727be8a417f6a7718e591b025e07054c146d8139",
        "sha256": {
            "model.safetensors": "3ea2c091f32877c9db46d2defe4ef23148d3ad21350bfd765a443e026588eeae",
            "config.json": "8c901824b9352754c9722f50830049b4fbb169f62823b6cdc9a4ce51918179f9",
            "tokenizer.json": "879c2bc610c79b03a3fb72e1e80b6d966615b957bdaedf137f1e87270c90935b",
            "tokenizer_config.json": "7dbbb2fc8cfb050a652bffe28db6251439d9b966d8655b7d79ba3d5c17c39b77",
            "special_tokens_map.json": "ea97ecdbcc73713039d8d64dbb05e3689495c96657fbd9a18f5bed381be81049",
        },
    },
    "base": {
        "revision": "4f6a108b08a5537f395521d19b5073e197923dd3",
        "sha256": {
            "model.safetensors": "ab6ce13c9ca472a72bded2f0333534d5631aa52b6eb5b38d5df32b080501e4b6",
            "config.json": "fe28f5df83b9bc62cb975073c0bdcebc8117362eb25664a5618be5fd9f2376f7",
            "tokenizer.json": "d05acaafc9edfc327f2b7c03576100925d7f69c3085b27a62288958246510677",
            "tokenizer_config.json": "32154241472870be1e317105ce4765903515b4291b4add85a8d4322fda53ffe2",
            "special_tokens_map.json": "b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21",
        },
    },
}


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def parse_args():
    packages = " ".join(f"{name}=={version}" for name, version in PACKAGES.items())
    revisions = "\n".join(
        f"  {kind}: knowledgator/gliclass-instruct-{kind}-v1.0@{source['revision']}"
        for kind, source in SOURCES.items()
    )
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            f"Required installed packages:\n  {packages}\n\n"
            f"Required official checkpoint revisions:\n{revisions}\n\n"
            "Prepare those checkpoint files separately. The source hashes are verified "
            "before export.\nThe output contains model.onnx, tokenizer/config files, "
            "and model.json with artifact hashes."
        ),
    )
    parser.add_argument("--model", required=True, choices=SOURCES)
    parser.add_argument("--source", required=True, type=Path, help="Local official checkpoint directory")
    parser.add_argument("--output", required=True, type=Path, help="New output directory; must not exist")
    return parser.parse_args()


def publish(staged, output):
    # POSIX directory rename can replace another writer's empty directory.
    output.mkdir(exist_ok=False)
    reservation = output.lstat()
    linked = []
    try:
        files = sorted(path for path in staged.iterdir() if path.name != "model.json")
        # Readers require the manifest, so it is the publication boundary.
        for source in [*files, staged / "model.json"]:
            target = output / source.name
            identity = source.lstat()
            os.link(source, target)
            linked.append((target, identity))
    except BaseException:
        try:
            for target, identity in linked:
                if not os.path.samestat(output.lstat(), reservation):
                    break
                if target.exists() and os.path.samestat(target.lstat(), identity):
                    target.unlink()
            # A concurrent rename can replace the reservation during cleanup.
            if os.path.samestat(output.lstat(), reservation):
                # Unexpected files keep the reservation in place rather than being removed.
                output.rmdir()
        except OSError as error:
            print(f"Incomplete output cleanup: {error}", file=sys.stderr)
        raise


def export(args):
    source = SOURCES[args.model]
    if args.output.exists():
        raise ValueError("Output already exists; choose a new directory.")
    for name, expected in source["sha256"].items():
        path = args.source / name
        if not path.is_file() or sha256(path) != expected:
            raise ValueError(
                f"Source {name} does not match the official {args.model} checkpoint "
                f"at revision {source['revision']}."
            )
    for name, expected in PACKAGES.items():
        installed = importlib.metadata.version(name)
        if installed.split("+", 1)[0] != expected:
            raise ValueError(f"Install {name}=={expected}; found {installed}.")

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    import onnx
    import torch
    from gliclass import GLiClassModel
    from transformers import AutoTokenizer

    torch.set_num_threads(2)
    model = GLiClassModel.from_pretrained(
        str(args.source), local_files_only=True, attn_implementation="eager"
    ).eval()
    tokenizer = AutoTokenizer.from_pretrained(
        str(args.source), local_files_only=True, trust_remote_code=False
    )

    class ClassifierExport(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.core = model.model

        def forward(self, input_ids, attention_mask):
            positions = torch.arange(input_ids.shape[1], device=input_ids.device).unsqueeze(0)
            separator = (input_ids == self.core.config.text_token_index).long().argmax(
                dim=-1, keepdim=True
            )
            # Upstream .item() indexing freezes the separator during tracing.
            # Without example sections, segment 1 begins at the first separator.
            segments = (positions >= separator).long()
            embedded = self.core.encoder_model.get_input_embeddings()(input_ids)
            embedded = embedded + self.core.segment_embeddings(segments)
            output = self.core.encoder_model(
                inputs_embeds=embedded, attention_mask=attention_mask, return_dict=True
            )
            logits = self.core.process_encoder_output(
                input_ids, attention_mask, output.last_hidden_state, max_num_classes=64
            )[0]
            count = (input_ids == self.core.config.class_token_index).long().sum(dim=-1).max()
            return logits[:, :count]

    wrapper = ClassifierExport().eval()

    def encode(labels, text):
        packed = "".join(f"<<LABEL>>{label}" for label in labels)
        packed += "<<SEP>>Classify the text.\n" + text
        return tokenizer(packed, return_tensors="pt", truncation=False, padding=False)

    with torch.inference_mode():
        for count in (2, 5, 64):
            inputs = encode([f"category{i}" for i in range(count)], "An example document.")
            expected = model(**inputs, max_num_classes=count).logits
            actual = wrapper(inputs["input_ids"], inputs["attention_mask"])
            torch.testing.assert_close(actual, expected, rtol=1e-4, atol=1e-4)
    inputs = encode(["travel", "science", "finance"], "A pleasant trip.")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f".{args.output.name}-", dir=args.output.parent) as directory:
        staged = Path(directory)
        with torch.inference_mode():
            torch.onnx.export(
                wrapper,
                (inputs["input_ids"], inputs["attention_mask"]),
                str(staged / "model.onnx"),
                input_names=["input_ids", "attention_mask"],
                output_names=["logits"],
                dynamic_axes={
                    "input_ids": {0: "batch_size", 1: "seq_len"},
                    "attention_mask": {0: "batch_size", 1: "seq_len"},
                    "logits": {0: "batch_size", 1: "num_labels"},
                },
                opset_version=17,
                dynamo=False,
            )
        onnx.checker.check_model(str(staged / "model.onnx"))
        for name in source["sha256"]:
            if name != "model.safetensors":
                shutil.copyfile(args.source / name, staged / name)
        manifest = {
            "modelId": f"gliclass-instruct-{args.model}-v1.0",
            "sourceRevision": source["revision"],
            "files": [
                {"name": path.name, "sha256": sha256(path), "size": path.stat().st_size}
                for path in sorted(staged.iterdir())
            ],
        }
        (staged / "model.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        publish(staged, args.output)
    print(f"Exported {manifest['modelId']} to {args.output}")


def main():
    args = parse_args()
    try:
        export(args)
    except (OSError, ValueError, importlib.metadata.PackageNotFoundError) as error:
        print(f"Export failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

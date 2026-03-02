#!/usr/bin/env python3
"""
DeBERTa-v3-large NER Training Pipeline for Pre-Redact
=====================================================
Step 2: Train on adversarial augmented data from Step 1.
Step 3: Evaluate generalization on held-out contracts.

Trains with ORG as a first-class entity type.
Runs on Apple Silicon MPS (48GB unified memory).
"""

import json
import logging
import os
import random
import time
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import torch
from torch.optim import AdamW
from torch.utils.data import DataLoader, Dataset
from transformers import (
    AutoModelForTokenClassification,
    AutoTokenizer,
    get_linear_schedule_with_warmup,
)
from seqeval.metrics import (
    classification_report,
    f1_score as seqeval_f1,
    precision_score as seqeval_precision,
    recall_score as seqeval_recall,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("deberta-train")

# ============================================================
# CONFIG
# ============================================================
@dataclass
class Config:
    model_name: str = "microsoft/deberta-v3-large"
    data_path: str = "/Users/donniedarko/Desktop/SEC_Training_Dataset/augmented_training.jsonl"
    output_dir: str = "/Users/donniedarko/Desktop/SEC_Training_Dataset/deberta_v3_large_model"
    max_length: int = 512
    batch_size: int = 4
    lr: float = 2e-5  # lower LR for large model
    epochs: int = 5
    warmup_ratio: float = 0.1
    seed: int = 42

    # TIERED GENERALIZATION TEST
    # Train on: apa, crd, con, emp, lic, mer, op, sub (8 contract types)
    # Tier 1 (very similar): different ORG swaps from SAME docs in training set
    #   -> automatically created by holding back 10% of training-type samples
    # Tier 2 (less similar): hold out specific docs from types IN training
    #   -> same contract type, but different specific contract (unseen context)
    tier2_holdout: tuple = ("apa_03", "emp_01", "crd_02", "mer_03", "sub_03")
    # Tier 3 (much less similar): hold out ENTIRE contract types never seen
    #   -> completely different document structure and legal context
    tier3_types: tuple = ("sec", "spa", "svc", "lea")  # 4 types, 7 docs total


# ============================================================
# LABEL DEFINITIONS — ORG is now first-class
# ============================================================
ENTITY_TYPES = [
    "ORG",          # <-- THE KEY ADDITION
    "PERSON",
    "GIVENNAME",
    "SURNAME",
    "LOCATION",
    "CITY",
    "STREET",
    "ADDRESS",
    "BUILDINGNUM",
    "ZIPCODE",
    "EMAIL",
    "PHONE",
    "SSN",
    "DATE",
    "MONEY",
    "CREDIT_CARD",
    "TAX_ID",
    "ACCOUNT",
    "REGISTRATION",
    "PASSWORD",
    "USERNAME",
]

def build_labels():
    labels = ["O"]
    for etype in ENTITY_TYPES:
        labels.append(f"B-{etype}")
        labels.append(f"I-{etype}")
    return labels

LABEL_LIST = build_labels()
LABEL2ID = {l: i for i, l in enumerate(LABEL_LIST)}
ID2LABEL = {i: l for i, l in enumerate(LABEL_LIST)}


# ============================================================
# DEVICE
# ============================================================
def get_device():
    if torch.cuda.is_available():
        return torch.device("cuda")
    elif torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


# ============================================================
# DATA CONVERSION: JSONL -> IOB token sequences
# ============================================================
def jsonl_to_iob(data_path, tokenizer, max_length=512):
    """Convert augmented_training.jsonl to tokenized IOB sequences."""
    samples = []
    for line in Path(data_path).read_text().strip().split("\n"):
        if line.strip():
            samples.append(json.loads(line))

    logger.info(f"Loaded {len(samples)} raw samples")

    token_seqs = []
    doc_ids = []

    for sample in samples:
        text = sample["text"]
        entities = sample.get("entities", [])
        doc_id = sample.get("original_doc", "unknown")

        # Tokenize with offset mapping
        encoding = tokenizer(
            text,
            return_offsets_mapping=True,
            truncation=True,
            max_length=max_length,
            padding="max_length",
            return_tensors="pt",
        )

        offset_mapping = encoding["offset_mapping"][0].tolist()
        input_ids = encoding["input_ids"].squeeze(0)
        attention_mask = encoding["attention_mask"].squeeze(0)

        # Build character-level label array
        char_labels = ["O"] * len(text)
        for ent in sorted(entities, key=lambda e: e["start"]):
            start, end = ent["start"], ent["end"]
            label = ent["label"]
            if label not in ENTITY_TYPES:
                continue
            for i in range(start, min(end, len(text))):
                if i == start:
                    char_labels[i] = f"B-{label}"
                else:
                    char_labels[i] = f"I-{label}"

        # Map character labels to token labels
        # NOTE: DeBERTa's SentencePiece tokenizer includes leading whitespace
        # in token offsets (e.g., "▁Carlyle" starts at the SPACE before "Carlyle").
        # Using char_labels[tok_start] would hit the space → "O" instead of "B-ORG".
        # Fix: check the full span of characters covered by the token.
        token_labels = []
        for tok_start, tok_end in offset_mapping:
            if tok_start == 0 and tok_end == 0:
                # Special token (CLS, SEP, PAD)
                token_labels.append(-100)
            elif tok_start >= len(char_labels):
                token_labels.append(LABEL2ID["O"])
            else:
                span = set(char_labels[tok_start:tok_end])
                if any(l.startswith("B-") for l in span):
                    # Find the B- label in this span
                    b_label = next(l for l in span if l.startswith("B-"))
                    token_labels.append(LABEL2ID.get(b_label, 0))
                elif any(l.startswith("I-") for l in span):
                    i_label = next(l for l in span if l.startswith("I-"))
                    token_labels.append(LABEL2ID.get(i_label, 0))
                else:
                    token_labels.append(LABEL2ID["O"])

        token_seqs.append({
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "labels": torch.tensor(token_labels, dtype=torch.long),
        })
        doc_ids.append(doc_id)

    return token_seqs, doc_ids


# ============================================================
# DATASET
# ============================================================
class NERDataset(Dataset):
    def __init__(self, samples):
        self.samples = samples
    def __len__(self):
        return len(self.samples)
    def __getitem__(self, idx):
        return self.samples[idx]


# ============================================================
# METRICS
# ============================================================
def compute_metrics(preds, labels):
    true_seqs = []
    pred_seqs = []
    for pred_row, label_row in zip(preds, labels):
        t_seq = []
        p_seq = []
        for p, l in zip(pred_row, label_row):
            if l == -100:
                continue
            t_seq.append(ID2LABEL.get(int(l), "O"))
            p_seq.append(ID2LABEL.get(int(p), "O"))
        true_seqs.append(t_seq)
        pred_seqs.append(p_seq)

    return {
        "f1": seqeval_f1(true_seqs, pred_seqs, zero_division=0),
        "precision": seqeval_precision(true_seqs, pred_seqs, zero_division=0),
        "recall": seqeval_recall(true_seqs, pred_seqs, zero_division=0),
        "report": classification_report(true_seqs, pred_seqs, zero_division=0),
    }


def run_evaluation(model, loader, device):
    model.eval()
    all_preds = []
    all_labels = []
    with torch.no_grad():
        for batch in loader:
            batch = {k: v.to(device) for k, v in batch.items()}
            outputs = model(**batch)
            preds = outputs.logits.argmax(dim=-1).cpu().numpy()
            labs = batch["labels"].cpu().numpy()
            all_preds.append(preds)
            all_labels.append(labs)
    return compute_metrics(np.concatenate(all_preds), np.concatenate(all_labels))


# ============================================================
# MAIN PIPELINE
# ============================================================
def main():
    cfg = Config()
    random.seed(cfg.seed)
    np.random.seed(cfg.seed)
    torch.manual_seed(cfg.seed)

    device = get_device()
    logger.info(f"Device: {device}")
    logger.info(f"Model: {cfg.model_name}")
    logger.info(f"Labels: {len(LABEL_LIST)} ({len(ENTITY_TYPES)} entity types + O)")
    logger.info(f"Tier 2 holdout docs: {cfg.tier2_holdout}")
    logger.info(f"Tier 3 unseen types: {cfg.tier3_types}")

    # ---- Load tokenizer ----
    logger.info("Loading tokenizer...")
    tokenizer = AutoTokenizer.from_pretrained(cfg.model_name)

    # ---- Convert data ----
    logger.info("Converting JSONL to IOB tokens...")
    all_samples, doc_ids = jsonl_to_iob(cfg.data_path, tokenizer, cfg.max_length)
    logger.info(f"Total tokenized samples: {len(all_samples)}")

    # ---- TIERED SPLIT ----
    tier2_set = set(cfg.tier2_holdout)
    tier3_prefixes = set(cfg.tier3_types)

    train_pool = []       # training-eligible samples
    tier2_samples = []    # Tier 2: same type, different doc
    tier3_samples = []    # Tier 3: completely unseen contract types
    train_docs = Counter()
    tier2_docs = Counter()
    tier3_docs = Counter()

    for sample, doc_id in zip(all_samples, doc_ids):
        # Extract type prefix (e.g., "sec" from "sec_01")
        doc_prefix = doc_id.rsplit("_", 1)[0] if "_" in doc_id else doc_id

        if doc_prefix in tier3_prefixes:
            tier3_samples.append(sample)
            tier3_docs[doc_id] += 1
        elif doc_id in tier2_set:
            tier2_samples.append(sample)
            tier2_docs[doc_id] += 1
        else:
            train_pool.append(sample)
            train_docs[doc_id] += 1

    # From train_pool: 80% train, 10% val, 10% tier1 (very similar)
    random.shuffle(train_pool)
    n = len(train_pool)
    t1_split = int(n * 0.10)
    val_split = int(n * 0.10)
    tier1_samples = train_pool[:t1_split]
    val_samples = train_pool[t1_split:t1_split + val_split]
    train_samples = train_pool[t1_split + val_split:]

    logger.info(f"\n--- DATA SPLIT ---")
    logger.info(f"Train:        {len(train_samples)} samples from {len(train_docs)} docs")
    logger.info(f"Val:          {len(val_samples)} samples (random from training docs)")
    logger.info(f"Tier 1 test:  {len(tier1_samples)} samples (very similar - same docs, diff ORG swaps)")
    logger.info(f"Tier 2 test:  {len(tier2_samples)} samples from {len(tier2_docs)} docs (less similar - same types, diff docs)")
    logger.info(f"  Tier 2 docs: {dict(tier2_docs)}")
    logger.info(f"Tier 3 test:  {len(tier3_samples)} samples from {len(tier3_docs)} docs (much less similar - unseen types)")
    logger.info(f"  Tier 3 docs: {dict(tier3_docs)}")

    # ---- Dataloaders ----
    train_loader = DataLoader(NERDataset(train_samples), batch_size=cfg.batch_size, shuffle=True)
    val_loader = DataLoader(NERDataset(val_samples), batch_size=cfg.batch_size)
    tier1_loader = DataLoader(NERDataset(tier1_samples), batch_size=cfg.batch_size)
    tier2_loader = DataLoader(NERDataset(tier2_samples), batch_size=cfg.batch_size)
    tier3_loader = DataLoader(NERDataset(tier3_samples), batch_size=cfg.batch_size)

    # ---- Load model ----
    logger.info(f"Loading {cfg.model_name}...")
    model = AutoModelForTokenClassification.from_pretrained(
        cfg.model_name,
        num_labels=len(LABEL_LIST),
        id2label=ID2LABEL,
        label2id=LABEL2ID,
    ).to(device)

    param_count = sum(p.numel() for p in model.parameters())
    logger.info(f"Model params: {param_count:,} ({param_count/1e6:.0f}M)")

    # ---- Optimizer and scheduler ----
    optimizer = AdamW(model.parameters(), lr=cfg.lr, weight_decay=0.01)
    total_steps = len(train_loader) * cfg.epochs
    warmup_steps = int(total_steps * cfg.warmup_ratio)
    scheduler = get_linear_schedule_with_warmup(optimizer, warmup_steps, total_steps)

    # ---- Training loop ----
    output_path = Path(cfg.output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    best_val_f1 = 0.0
    history = []

    logger.info(f"\n{'='*60}")
    logger.info(f"TRAINING START: {cfg.epochs} epochs, {len(train_loader)} steps/epoch")
    logger.info(f"{'='*60}\n")

    t_start = time.time()

    for epoch in range(cfg.epochs):
        model.train()
        total_loss = 0.0
        step_count = 0

        for batch_idx, batch in enumerate(train_loader):
            batch = {k: v.to(device) for k, v in batch.items()}
            optimizer.zero_grad()

            outputs = model(**batch)
            loss = outputs.loss
            loss.backward()

            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            scheduler.step()

            total_loss += loss.item()
            step_count += 1

            if (batch_idx + 1) % 50 == 0:
                avg = total_loss / step_count
                logger.info(f"  Epoch {epoch+1} step {batch_idx+1}/{len(train_loader)} loss: {avg:.4f}")

        avg_loss = total_loss / max(step_count, 1)

        # Validation
        val_metrics = run_evaluation(model, val_loader, device)
        logger.info(
            f"\nEpoch {epoch+1}/{cfg.epochs}: "
            f"train_loss={avg_loss:.4f} | "
            f"val_f1={val_metrics['f1']:.4f} "
            f"val_prec={val_metrics['precision']:.4f} "
            f"val_rec={val_metrics['recall']:.4f}"
        )

        history.append({
            "epoch": epoch + 1,
            "train_loss": avg_loss,
            "val_f1": val_metrics["f1"],
            "val_precision": val_metrics["precision"],
            "val_recall": val_metrics["recall"],
        })

        # Save best
        if val_metrics["f1"] > best_val_f1:
            best_val_f1 = val_metrics["f1"]
            best_path = output_path / "best_model"
            best_path.mkdir(parents=True, exist_ok=True)
            model.save_pretrained(best_path)
            tokenizer.save_pretrained(best_path)
            # Save label mapping
            (best_path / "label_config.json").write_text(json.dumps({
                "id2label": ID2LABEL,
                "label2id": LABEL2ID,
                "entity_types": ENTITY_TYPES,
            }, indent=2))
            logger.info(f"  New best model (val_f1={best_val_f1:.4f}) saved to {best_path}")

    train_time = time.time() - t_start
    logger.info(f"\nTraining completed in {train_time/60:.1f} minutes")

    # ============================================================
    # STEP 3: TIERED GENERALIZATION TEST
    # ============================================================
    logger.info(f"\n{'='*60}")
    logger.info(f"STEP 3: TIERED GENERALIZATION TEST")
    logger.info(f"{'='*60}\n")

    # Load best model for testing
    best_model = AutoModelForTokenClassification.from_pretrained(
        output_path / "best_model",
        num_labels=len(LABEL_LIST),
        id2label=ID2LABEL,
        label2id=LABEL2ID,
    ).to(device)

    # --- Tier 1: Very similar (same docs, different ORG swaps) ---
    logger.info(f"--- TIER 1: Very Similar ({len(tier1_samples)} samples) ---")
    logger.info(f"    Same contract contexts, just different ORG name swaps")
    t1_metrics = run_evaluation(best_model, tier1_loader, device)
    logger.info(f"    F1={t1_metrics['f1']:.4f}  Prec={t1_metrics['precision']:.4f}  Rec={t1_metrics['recall']:.4f}")
    logger.info(f"\n{t1_metrics['report']}")

    # --- Tier 2: Less similar (same type, different specific contract) ---
    logger.info(f"\n--- TIER 2: Less Similar ({len(tier2_samples)} samples) ---")
    logger.info(f"    Same contract types, but docs never seen: {list(tier2_docs.keys())}")
    t2_metrics = run_evaluation(best_model, tier2_loader, device)
    logger.info(f"    F1={t2_metrics['f1']:.4f}  Prec={t2_metrics['precision']:.4f}  Rec={t2_metrics['recall']:.4f}")
    logger.info(f"\n{t2_metrics['report']}")

    # --- Tier 3: Much less similar (completely unseen contract types) ---
    logger.info(f"\n--- TIER 3: Much Less Similar ({len(tier3_samples)} samples) ---")
    logger.info(f"    Completely unseen contract types: {list(cfg.tier3_types)}")
    logger.info(f"    Docs: {list(tier3_docs.keys())}")
    t3_metrics = run_evaluation(best_model, tier3_loader, device)
    logger.info(f"    F1={t3_metrics['f1']:.4f}  Prec={t3_metrics['precision']:.4f}  Rec={t3_metrics['recall']:.4f}")
    logger.info(f"\n{t3_metrics['report']}")

    # ============================================================
    # SAVE FINAL RESULTS
    # ============================================================
    results = {
        "model": cfg.model_name,
        "timestamp": datetime.now().isoformat(),
        "training": {
            "samples": len(train_samples),
            "val_samples": len(val_samples),
            "epochs": cfg.epochs,
            "best_val_f1": best_val_f1,
            "train_time_minutes": round(train_time / 60, 1),
            "train_docs": dict(train_docs),
        },
        "generalization": {
            "tier1_very_similar": {
                "description": "Same docs as training, different ORG swaps",
                "samples": len(tier1_samples),
                "f1": t1_metrics["f1"],
                "precision": t1_metrics["precision"],
                "recall": t1_metrics["recall"],
                "report": t1_metrics["report"],
            },
            "tier2_less_similar": {
                "description": "Same contract types, different specific docs",
                "holdout_docs": list(cfg.tier2_holdout),
                "samples": len(tier2_samples),
                "f1": t2_metrics["f1"],
                "precision": t2_metrics["precision"],
                "recall": t2_metrics["recall"],
                "report": t2_metrics["report"],
            },
            "tier3_much_less_similar": {
                "description": "Completely unseen contract types",
                "holdout_types": list(cfg.tier3_types),
                "docs": list(tier3_docs.keys()),
                "samples": len(tier3_samples),
                "f1": t3_metrics["f1"],
                "precision": t3_metrics["precision"],
                "recall": t3_metrics["recall"],
                "report": t3_metrics["report"],
            },
        },
        "history": history,
        "label_config": {
            "num_labels": len(LABEL_LIST),
            "entity_types": ENTITY_TYPES,
        },
    }

    results_path = output_path / "training_results.json"
    results_path.write_text(json.dumps(results, indent=2))
    logger.info(f"\nResults saved to {results_path}")

    # ============================================================
    # SUMMARY
    # ============================================================
    print(f"\n{'='*60}")
    print(f"  TRAINING + GENERALIZATION COMPLETE")
    print(f"{'='*60}")
    print(f"  Model:           {cfg.model_name}")
    print(f"  Params:          {param_count:,}")
    print(f"  Train samples:   {len(train_samples)}")
    print(f"  Val F1 (best):   {best_val_f1:.4f}")
    print(f"  Train time:      {train_time/60:.1f} min")
    print(f"")
    print(f"  GENERALIZATION RESULTS:")
    print(f"  {'Tier':6s} {'Difficulty':20s} {'Samples':>8s} {'F1':>8s} {'Prec':>8s} {'Rec':>8s}")
    print(f"  {'-'*58}")
    print(f"  {'T1':6s} {'Very similar':20s} {len(tier1_samples):>8d} {t1_metrics['f1']:>8.4f} {t1_metrics['precision']:>8.4f} {t1_metrics['recall']:>8.4f}")
    print(f"  {'T2':6s} {'Less similar':20s} {len(tier2_samples):>8d} {t2_metrics['f1']:>8.4f} {t2_metrics['precision']:>8.4f} {t2_metrics['recall']:>8.4f}")
    print(f"  {'T3':6s} {'Much less similar':20s} {len(tier3_samples):>8d} {t3_metrics['f1']:>8.4f} {t3_metrics['precision']:>8.4f} {t3_metrics['recall']:>8.4f}")
    print(f"  {'-'*58}")
    print(f"")
    print(f"  T1 = same context, diff ORG names (should be highest)")
    print(f"  T2 = same contract type, diff doc (tests cross-doc transfer)")
    print(f"  T3 = unseen contract types: {', '.join(cfg.tier3_types)} (hardest)")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()

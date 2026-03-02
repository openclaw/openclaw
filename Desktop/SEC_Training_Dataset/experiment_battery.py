"""
3-experiment battery to answer: does ORG detection need VOLUME or DIVERSITY?

Experiment A: 100 samples from 5 different types (20 each) — diversity, low volume
Experiment B: 400 samples from mer_01 only — volume, no diversity
Experiment C: 500 samples from 5 different types (100 each) — volume + diversity

All tested against the same 7-level generalization ladder.
"""

import json
import logging
import random
import time
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForTokenClassification, AutoTokenizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

LABELS = ["O", "B-ORG", "I-ORG"]
LABEL2ID = {l: i for i, l in enumerate(LABELS)}
ID2LABEL = {i: l for l, i in LABEL2ID.items()}

DATA_PATH = "augmented_training.jsonl"
MODEL_NAME = "microsoft/deberta-v3-large"
MAX_LENGTH = 512
TEST_PER_LEVEL = 30

SYNTHETIC_BUSINESS = [
    ("NovaTech Industries announced third-quarter earnings of $2.3 billion.", [{"start": 0, "end": 20, "label": "ORG"}]),
    ("GlobalSync Solutions completed its acquisition of DataPrime Corp.", [{"start": 0, "end": 20, "label": "ORG"}, {"start": 49, "end": 63, "label": "ORG"}]),
    ("The board at Apex Dynamics approved the restructuring plan.", [{"start": 13, "end": 26, "label": "ORG"}]),
    ("Meridian Capital Partners led the Series B round for CloudBridge Technologies.", [{"start": 0, "end": 27, "label": "ORG"}, {"start": 52, "end": 76, "label": "ORG"}]),
    ("Pinnacle Systems reported a 15% decline in revenue.", [{"start": 0, "end": 16, "label": "ORG"}]),
    ("Sterling Manufacturing will close two factories.", [{"start": 0, "end": 22, "label": "ORG"}]),
    ("Quantum Ventures and Blue Horizon Capital jointly invested $200 million.", [{"start": 0, "end": 16, "label": "ORG"}, {"start": 21, "end": 41, "label": "ORG"}]),
    ("The merger between Ironclad Security and SafeNet Global was approved.", [{"start": 19, "end": 37, "label": "ORG"}, {"start": 42, "end": 55, "label": "ORG"}]),
    ("Vertex Biomedical received FDA approval for its cardiac device.", [{"start": 0, "end": 17, "label": "ORG"}]),
    ("Orion Logistics expanded its fleet to 5,000 vehicles.", [{"start": 0, "end": 15, "label": "ORG"}]),
    ("TechForward Inc. hired 2,000 engineers in Q1.", [{"start": 0, "end": 16, "label": "ORG"}]),
    ("Cascade Health and Provenance Labs aim to revolutionize telehealth.", [{"start": 0, "end": 14, "label": "ORG"}, {"start": 19, "end": 34, "label": "ORG"}]),
    ("Silverline Aerospace won a $3.4 billion defense contract.", [{"start": 0, "end": 21, "label": "ORG"}]),
    ("Atlas Financial Group downgraded its outlook for commercial real estate.", [{"start": 0, "end": 21, "label": "ORG"}]),
    ("Summit Energy Corp filed for Chapter 11 bankruptcy in Delaware.", [{"start": 0, "end": 17, "label": "ORG"}]),
    ("Pacific Rim Trading announced layoffs affecting 12% of its workforce.", [{"start": 0, "end": 19, "label": "ORG"}]),
    ("Helios Semiconductor is building a chip fabrication plant in Arizona.", [{"start": 0, "end": 20, "label": "ORG"}]),
    ("Zenith Labs partnered with BrightPath Analytics for predictive healthcare.", [{"start": 0, "end": 10, "label": "ORG"}, {"start": 27, "end": 48, "label": "ORG"}]),
    ("Shareholders of Redwood Capital Management voted to approve the dividend.", [{"start": 17, "end": 44, "label": "ORG"}]),
    ("CrestView Holdings acquired a 40% stake in Northern Star Minerals.", [{"start": 0, "end": 18, "label": "ORG"}, {"start": 43, "end": 63, "label": "ORG"}]),
    ("FusionWorks International reported record revenue of $5.8 billion.", [{"start": 0, "end": 25, "label": "ORG"}]),
    ("Blackstone Ridge Industries laid off 3,000 workers.", [{"start": 0, "end": 26, "label": "ORG"}]),
    ("Titan Aerospace completed low-orbit satellite communication testing.", [{"start": 0, "end": 15, "label": "ORG"}]),
    ("Emerald Bay Consulting advised on the restructuring of Cobalt Mining International.", [{"start": 0, "end": 22, "label": "ORG"}, {"start": 55, "end": 83, "label": "ORG"}]),
    ("Nexus Pharmaceuticals recalled 50,000 units of blood pressure medication.", [{"start": 0, "end": 21, "label": "ORG"}]),
    ("Vanguard Logistics Solutions signed a 10-year contract with OmniRetail Group.", [{"start": 0, "end": 27, "label": "ORG"}, {"start": 60, "end": 76, "label": "ORG"}]),
    ("Crimson Peak Energy is investing $800 million in offshore wind.", [{"start": 0, "end": 19, "label": "ORG"}]),
    ("Aurora Data Systems launched its enterprise cloud platform.", [{"start": 0, "end": 19, "label": "ORG"}]),
    ("Pacific Gateway Corp and Eastern Seaboard Industries focus on port modernization.", [{"start": 0, "end": 20, "label": "ORG"}, {"start": 25, "end": 52, "label": "ORG"}]),
    ("StratosTech Defense won a $2.1 billion cybersecurity contract.", [{"start": 0, "end": 17, "label": "ORG"}]),
]

SYNTHETIC_GENERAL = [
    ("Workers at Foxconn went on strike Monday over working conditions.", [{"start": 11, "end": 18, "label": "ORG"}]),
    ("I just got an offer from Zenith Labs and I'm excited.", [{"start": 25, "end": 35, "label": "ORG"}]),
    ("Does anyone else use CloudBridge for hosting?", [{"start": 19, "end": 30, "label": "ORG"}]),
    ("My friend works at Palantir and says the culture is intense.", [{"start": 19, "end": 27, "label": "ORG"}]),
    ("The CEO of Rivian says they will be profitable by 2026.", [{"start": 11, "end": 17, "label": "ORG"}]),
    ("Just read that SpaceX launched another 60 Starlink satellites.", [{"start": 15, "end": 21, "label": "ORG"}]),
    ("Went to the new Tesla showroom downtown.", [{"start": 16, "end": 21, "label": "ORG"}]),
    ("OpenAI released a new model today that everyone is talking about.", [{"start": 0, "end": 6, "label": "ORG"}]),
    ("Apparently Boeing is recalling some 737 MAX planes again.", [{"start": 11, "end": 17, "label": "ORG"}]),
    ("The Nvidia stock price jumped 12% after the earnings call.", [{"start": 4, "end": 10, "label": "ORG"}]),
    ("IKEA is opening three new stores in the Southwest.", [{"start": 0, "end": 4, "label": "ORG"}]),
    ("Google DeepMind published a paper on protein folding.", [{"start": 0, "end": 15, "label": "ORG"}]),
    ("My cousin left Goldman Sachs to join Stripe.", [{"start": 15, "end": 28, "label": "ORG"}, {"start": 37, "end": 43, "label": "ORG"}]),
    ("Samsung just announced a new foldable phone.", [{"start": 0, "end": 7, "label": "ORG"}]),
    ("The FDA approved Moderna's updated vaccine.", [{"start": 17, "end": 24, "label": "ORG"}]),
    ("Costco raised its membership fees for the first time in seven years.", [{"start": 0, "end": 6, "label": "ORG"}]),
    ("Amazon Web Services had a major outage.", [{"start": 0, "end": 21, "label": "ORG"}]),
    ("Saw that Anthropic raised another huge round.", [{"start": 9, "end": 18, "label": "ORG"}]),
    ("Toyota recalled 500,000 vehicles due to an airbag defect.", [{"start": 0, "end": 6, "label": "ORG"}]),
    ("The European Commission fined Meta $1.3 billion.", [{"start": 4, "end": 23, "label": "ORG"}, {"start": 30, "end": 34, "label": "ORG"}]),
    ("Lockheed Martin delivered the first batch of F-35s.", [{"start": 0, "end": 15, "label": "ORG"}]),
    ("I interviewed at Databricks last week.", [{"start": 17, "end": 27, "label": "ORG"}]),
    ("Walmart is testing drone delivery in rural areas.", [{"start": 0, "end": 7, "label": "ORG"}]),
    ("The World Health Organization warned about a new virus variant.", [{"start": 4, "end": 29, "label": "ORG"}]),
    ("Netflix lost two million subscribers in Q3.", [{"start": 0, "end": 7, "label": "ORG"}]),
    ("Uber is partnering with Waymo for autonomous rides.", [{"start": 0, "end": 4, "label": "ORG"}, {"start": 24, "end": 29, "label": "ORG"}]),
    ("BYD overtook Tesla as the world's largest EV maker.", [{"start": 0, "end": 3, "label": "ORG"}, {"start": 13, "end": 18, "label": "ORG"}]),
    ("Johnson & Johnson split into two companies last year.", [{"start": 0, "end": 19, "label": "ORG"}]),
    ("Heard that Coinbase might get delisted.", [{"start": 11, "end": 19, "label": "ORG"}]),
    ("Pfizer's new weight loss drug is entering Phase 3 trials.", [{"start": 0, "end": 6, "label": "ORG"}]),
]


class NERDataset(Dataset):
    def __init__(self, samples):
        self.samples = samples
    def __len__(self):
        return len(self.samples)
    def __getitem__(self, idx):
        return self.samples[idx]


def tokenize_and_align(text, entities, tokenizer, max_length):
    encoding = tokenizer(text, max_length=max_length, truncation=True,
                          padding="max_length", return_offsets_mapping=True, return_tensors="pt")
    offsets = encoding["offset_mapping"][0].tolist()

    char_labels = ["O"] * len(text)
    for ent in sorted(entities, key=lambda e: e["start"]):
        s, e, lbl = ent["start"], ent["end"], ent["label"]
        if lbl != "ORG":
            continue
        for i in range(s, min(e, len(text))):
            char_labels[i] = "B-ORG" if i == s else "I-ORG"

    label_ids = []
    for start, end in offsets:
        if start == 0 and end == 0:
            label_ids.append(-100)
        else:
            span = set(char_labels[start:end])
            if "B-ORG" in span:
                label_ids.append(LABEL2ID["B-ORG"])
            elif "I-ORG" in span:
                label_ids.append(LABEL2ID["I-ORG"])
            else:
                label_ids.append(LABEL2ID["O"])

    return {
        "input_ids": encoding["input_ids"].squeeze(0),
        "attention_mask": encoding["attention_mask"].squeeze(0),
        "labels": torch.tensor(label_ids, dtype=torch.long),
    }


def load_jsonl_by_doc(path, doc_prefixes, max_per_prefix=None, shuffle_seed=42):
    by_prefix = {}
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            doc_id = rec.get("original_doc", "")
            for p in doc_prefixes:
                if doc_id.startswith(p):
                    by_prefix.setdefault(p, []).append(rec)
                    break
    result = []
    random.seed(shuffle_seed)
    for p in doc_prefixes:
        samples = by_prefix.get(p, [])
        random.shuffle(samples)
        if max_per_prefix:
            samples = samples[:max_per_prefix]
        result.extend(samples)
    return result


def extract_entities(tag_seq):
    entities = set()
    start = None
    for i, tag in enumerate(tag_seq):
        if tag.startswith("B-"):
            if start is not None:
                entities.add((start, i, "ORG"))
            start = i
        elif tag.startswith("I-") and start is not None:
            continue
        else:
            if start is not None:
                entities.add((start, i, "ORG"))
                start = None
    if start is not None:
        entities.add((start, len(tag_seq), "ORG"))
    return entities


def do_evaluate(model, dataloader, device):
    model.eval()
    all_preds, all_labels = [], []
    with torch.no_grad():
        for batch in dataloader:
            ids = batch["input_ids"].to(device)
            mask = batch["attention_mask"].to(device)
            out = model(input_ids=ids, attention_mask=mask)
            preds = out.logits.argmax(dim=-1).cpu()
            for ps, ls in zip(preds, batch["labels"]):
                pt, tt = [], []
                for p, l in zip(ps, ls):
                    if l.item() == -100:
                        continue
                    pt.append(ID2LABEL[p.item()])
                    tt.append(ID2LABEL[l.item()])
                all_preds.append(pt)
                all_labels.append(tt)
    tp = fp = fn = 0
    for ps, ts in zip(all_preds, all_labels):
        pe, te = extract_entities(ps), extract_entities(ts)
        tp += len(pe & te)
        fp += len(pe - te)
        fn += len(te - pe)
    p = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    r = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0.0
    return {"f1": f1, "precision": p, "recall": r, "tp": tp, "fp": fp, "fn": fn}


def build_test_sets(tokenizer):
    configs = [
        ("L1: Same doc, diff swaps", ["mer_01"], True),
        ("L2: Same type, diff doc", ["mer_02", "mer_03"], False),
        ("L3: Related financial", ["crd_03", "apa_02"], False),
        ("L4: Different legal", ["emp_03", "lic_03"], False),
        ("L5: Very different type", ["lea_02", "svc_02"], False),
        ("L6: Synthetic business", None, False),
        ("L7: Synthetic general", None, False),
    ]
    test_sets = {}
    for name, doc_filter, is_same_doc in configs:
        if "Synthetic business" in name:
            data = [tokenize_and_align(t, e, tokenizer, MAX_LENGTH) for t, e in SYNTHETIC_BUSINESS[:TEST_PER_LEVEL]]
        elif "Synthetic general" in name:
            data = [tokenize_and_align(t, e, tokenizer, MAX_LENGTH) for t, e in SYNTHETIC_GENERAL[:TEST_PER_LEVEL]]
        else:
            raw = load_jsonl_by_doc(DATA_PATH, doc_filter)
            if is_same_doc:
                raw = raw[100:100 + TEST_PER_LEVEL]
            else:
                raw = raw[:TEST_PER_LEVEL]
            data = [tokenize_and_align(r["text"], r.get("entities", []), tokenizer, MAX_LENGTH) for r in raw]
        test_sets[name] = DataLoader(NERDataset(data), batch_size=4)
    return test_sets


def run_experiment(name, train_raw, tokenizer, test_sets, device, epochs=3):
    logger.info(f"\n{'#'*60}")
    logger.info(f"EXPERIMENT: {name}")
    logger.info(f"Training: {len(train_raw)} samples, {epochs} epochs")
    logger.info(f"{'#'*60}")

    train_data = [tokenize_and_align(r["text"], r.get("entities", []), tokenizer, MAX_LENGTH) for r in train_raw]
    train_loader = DataLoader(NERDataset(train_data), batch_size=4, shuffle=True)

    model = AutoModelForTokenClassification.from_pretrained(
        MODEL_NAME, num_labels=len(LABELS), id2label=ID2LABEL, label2id=LABEL2ID,
    ).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=2e-5)

    t0 = time.time()
    for epoch in range(epochs):
        model.train()
        total_loss = 0
        for batch in train_loader:
            ids = batch["input_ids"].to(device)
            mask = batch["attention_mask"].to(device)
            labs = batch["labels"].to(device)
            out = model(input_ids=ids, attention_mask=mask, labels=labs)
            out.loss.backward()
            optimizer.step()
            optimizer.zero_grad()
            total_loss += out.loss.item()
        avg = total_loss / len(train_loader)
        logger.info(f"  Epoch {epoch+1}/{epochs} loss: {avg:.4f}")
    train_time = time.time() - t0
    logger.info(f"  Training time: {train_time:.0f}s")

    results = []
    for level_name, loader in test_sets.items():
        m = do_evaluate(model, loader, device)
        s = "PASS" if m["f1"] >= 0.8 else "DEGRADED" if m["f1"] >= 0.5 else "FAIL"
        results.append((level_name, m, s))
        logger.info(f"  {level_name:35s} F1={m['f1']:.1%} P={m['precision']:.1%} R={m['recall']:.1%} TP={m['tp']} FP={m['fp']} FN={m['fn']} [{s}]")

    del model, optimizer
    if hasattr(torch.mps, "empty_cache"):
        torch.mps.empty_cache()

    return {"name": name, "samples": len(train_raw), "epochs": epochs,
            "train_time_s": round(train_time, 1),
            "levels": [{"level": n, "status": s, **m} for n, m, s in results]}


def main():
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    logger.info(f"Device: {device}")
    logger.info(f"Model: {MODEL_NAME}")

    tokenizer = AutoTokenizer.from_pretrained(MODEL_NAME)
    logger.info("Building shared test sets...")
    test_sets = build_test_sets(tokenizer)
    for name, loader in test_sets.items():
        logger.info(f"  {name}: {len(loader.dataset)} samples")

    # Experiment A: 100 samples from 5 types (20 each) — DIVERSITY
    train_a = load_jsonl_by_doc(DATA_PATH, ["mer_01", "crd_01", "emp_01", "lic_01", "svc_01"], max_per_prefix=20)
    result_a = run_experiment("A: 100 samples, 5 types (DIVERSITY)", train_a, tokenizer, test_sets, device)

    # Experiment B: 400 samples from mer_01 only — VOLUME
    with open(DATA_PATH) as f:
        all_recs = [json.loads(l) for l in f if l.strip()]
    train_b = [r for r in all_recs if r.get("original_doc") == "mer_01"]
    random.seed(42)
    random.shuffle(train_b)
    train_b = train_b[:400]
    result_b = run_experiment("B: 400 samples, mer_01 (VOLUME)", train_b, tokenizer, test_sets, device)

    # Experiment C: 500 samples from 5 types (100 each) — BOTH
    train_c = load_jsonl_by_doc(DATA_PATH, ["mer_01", "crd_01", "emp_01", "lic_01", "svc_01"], max_per_prefix=100)
    result_c = run_experiment("C: 500 samples, 5 types (VOLUME+DIVERSITY)", train_c, tokenizer, test_sets, device)

    # Comparison
    logger.info(f"\n{'='*70}")
    logger.info("COMPARISON MATRIX — F1 scores per level")
    logger.info(f"{'='*70}")
    logger.info(f"{'Level':<36} {'A:div':<10} {'B:vol':<10} {'C:both':<10}")
    logger.info(f"{'-'*70}")
    for i, (level_name, _) in enumerate(test_sets.items()):
        fa = result_a["levels"][i]["f1"]
        fb = result_b["levels"][i]["f1"]
        fc = result_c["levels"][i]["f1"]
        logger.info(f"{level_name:<36} {fa:>6.1%}     {fb:>6.1%}     {fc:>6.1%}")

    with open("experiment_battery_results.json", "w") as f:
        json.dump({"experiments": [result_a, result_b, result_c]}, f, indent=2)
    logger.info("\nResults saved to experiment_battery_results.json")


if __name__ == "__main__":
    main()

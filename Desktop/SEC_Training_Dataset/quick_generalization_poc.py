"""
Quick Generalization POC — Train on 100 merger samples, test across 7 levels.
Find the breaking point: how far can the model generalize ORG detection?

Levels (progressively more different from training data):
  1. Same doc, different ORG swaps (trivial)
  2. Same contract type, different doc (low)
  3. Related financial type: credit/asset purchase (medium)
  4. Different legal type: employment/license (medium-high)
  5. Very different type: lease/service (high)
  6. Synthetic business text: press releases (very high)
  7. Synthetic general text: news/informal (extreme)
"""

import json
import logging
import random
import time
from dataclasses import dataclass
from pathlib import Path

import torch
from torch.utils.data import DataLoader, Dataset
from transformers import AutoModelForTokenClassification, AutoTokenizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


@dataclass
class Config:
    model_name: str = "microsoft/deberta-v3-large"
    data_path: str = "augmented_training.jsonl"
    max_length: int = 512
    batch_size: int = 4  # smaller for large model on MPS
    lr: float = 2e-5
    epochs: int = 2
    train_doc: str = "mer_01"
    train_samples: int = 100
    test_per_level: int = 30


LABELS = ["O", "B-ORG", "I-ORG"]
LABEL2ID = {l: i for i, l in enumerate(LABELS)}
ID2LABEL = {i: l for l, i in LABEL2ID.items()}


# ---- Synthetic test data for levels 6-7 ----
SYNTHETIC_BUSINESS = [
    ("NovaTech Industries announced third-quarter earnings of $2.3 billion, exceeding analyst expectations.", [{"start": 0, "end": 20, "label": "ORG"}]),
    ("GlobalSync Solutions has completed its acquisition of DataPrime Corp for $890 million in cash.", [{"start": 0, "end": 20, "label": "ORG"}, {"start": 50, "end": 64, "label": "ORG"}]),
    ("The board of directors at Apex Dynamics approved the restructuring plan unanimously.", [{"start": 26, "end": 39, "label": "ORG"}]),
    ("Meridian Capital Partners led the Series B funding round for CloudBridge Technologies.", [{"start": 0, "end": 27, "label": "ORG"}, {"start": 62, "end": 85, "label": "ORG"}]),
    ("Pinnacle Systems reported a 15% decline in revenue due to supply chain disruptions.", [{"start": 0, "end": 16, "label": "ORG"}]),
    ("Sterling Manufacturing will close two factories as part of cost-reduction measures announced by the CEO.", [{"start": 0, "end": 22, "label": "ORG"}]),
    ("Quantum Ventures and Blue Horizon Capital jointly invested $200 million in renewable energy.", [{"start": 0, "end": 16, "label": "ORG"}, {"start": 21, "end": 41, "label": "ORG"}]),
    ("The merger between Ironclad Security and SafeNet Global was approved by regulators on Tuesday.", [{"start": 19, "end": 37, "label": "ORG"}, {"start": 42, "end": 55, "label": "ORG"}]),
    ("Vertex Biomedical received FDA approval for its new cardiac monitoring device.", [{"start": 0, "end": 17, "label": "ORG"}]),
    ("Orion Logistics expanded its fleet to 5,000 vehicles across North America.", [{"start": 0, "end": 15, "label": "ORG"}]),
    ("TechForward Inc. hired 2,000 engineers in Q1 to staff its new AI research division.", [{"start": 0, "end": 16, "label": "ORG"}]),
    ("The partnership between Cascade Health and Provenance Labs aims to revolutionize telehealth.", [{"start": 23, "end": 37, "label": "ORG"}, {"start": 42, "end": 57, "label": "ORG"}]),
    ("Silverline Aerospace won a $3.4 billion defense contract from the Department of Defense.", [{"start": 0, "end": 21, "label": "ORG"}]),
    ("Atlas Financial Group downgraded its outlook for the commercial real estate sector.", [{"start": 0, "end": 21, "label": "ORG"}]),
    ("Summit Energy Corp filed for Chapter 11 bankruptcy protection in Delaware.", [{"start": 0, "end": 17, "label": "ORG"}]),
    ("Pacific Rim Trading announced layoffs affecting 12% of its global workforce.", [{"start": 0, "end": 19, "label": "ORG"}]),
    ("Helios Semiconductor is building a new chip fabrication plant in Arizona.", [{"start": 0, "end": 20, "label": "ORG"}]),
    ("Zenith Labs partnered with BrightPath Analytics to develop predictive healthcare models.", [{"start": 0, "end": 10, "label": "ORG"}, {"start": 27, "end": 48, "label": "ORG"}]),
    ("The shareholders of Redwood Capital Management voted to approve the proposed dividend.", [{"start": 20, "end": 47, "label": "ORG"}]),
    ("CrestView Holdings acquired a 40% stake in Northern Star Minerals for $1.2 billion.", [{"start": 0, "end": 18, "label": "ORG"}, {"start": 43, "end": 63, "label": "ORG"}]),
    ("FusionWorks International reported record revenue of $5.8 billion for fiscal year 2025.", [{"start": 0, "end": 25, "label": "ORG"}]),
    ("Blackstone Ridge Industries laid off 3,000 workers citing automation improvements.", [{"start": 0, "end": 26, "label": "ORG"}]),
    ("Titan Aerospace completed testing of its low-orbit satellite communication array.", [{"start": 0, "end": 15, "label": "ORG"}]),
    ("Emerald Bay Consulting advised on the restructuring of Cobalt Mining International.", [{"start": 0, "end": 22, "label": "ORG"}, {"start": 55, "end": 83, "label": "ORG"}]),
    ("Nexus Pharmaceuticals recalled 50,000 units of its blood pressure medication.", [{"start": 0, "end": 21, "label": "ORG"}]),
    ("Vanguard Logistics Solutions signed a 10-year supply chain contract with OmniRetail Group.", [{"start": 0, "end": 27, "label": "ORG"}, {"start": 73, "end": 89, "label": "ORG"}]),
    ("Crimson Peak Energy is investing $800 million in offshore wind farm development.", [{"start": 0, "end": 19, "label": "ORG"}]),
    ("Aurora Data Systems launched its enterprise cloud platform at the annual tech summit.", [{"start": 0, "end": 19, "label": "ORG"}]),
    ("The joint venture between Pacific Gateway Corp and Eastern Seaboard Industries will focus on port modernization.", [{"start": 27, "end": 47, "label": "ORG"}, {"start": 52, "end": 79, "label": "ORG"}]),
    ("StratosTech Defense won a $2.1 billion cybersecurity contract from a NATO member state.", [{"start": 0, "end": 17, "label": "ORG"}]),
]

SYNTHETIC_GENERAL = [
    ("Workers at Foxconn went on strike Monday over working conditions at the Zhengzhou plant.", [{"start": 11, "end": 18, "label": "ORG"}]),
    ("I just got an offer from Zenith Labs and I'm pretty excited about the role.", [{"start": 25, "end": 35, "label": "ORG"}]),
    ("Does anyone else use CloudBridge for hosting? Their support is terrible.", [{"start": 19, "end": 30, "label": "ORG"}]),
    ("My friend works at Palantir and says the culture is intense but rewarding.", [{"start": 19, "end": 27, "label": "ORG"}]),
    ("The CEO of Rivian says they will be profitable by 2026.", [{"start": 11, "end": 17, "label": "ORG"}]),
    ("Just read that SpaceX launched another 60 Starlink satellites overnight.", [{"start": 15, "end": 21, "label": "ORG"}]),
    ("Went to the new Tesla showroom downtown and the Model Y looks great.", [{"start": 16, "end": 21, "label": "ORG"}]),
    ("OpenAI released a new model today that everyone is talking about on Twitter.", [{"start": 0, "end": 6, "label": "ORG"}]),
    ("Apparently Boeing is recalling some 737 MAX planes again for inspections.", [{"start": 11, "end": 17, "label": "ORG"}]),
    ("The Nvidia stock price jumped 12% after the earnings call yesterday.", [{"start": 4, "end": 10, "label": "ORG"}]),
    ("IKEA is opening three new stores in the Southwest this quarter.", [{"start": 0, "end": 4, "label": "ORG"}]),
    ("Google DeepMind published a paper on protein folding that looks promising.", [{"start": 0, "end": 15, "label": "ORG"}]),
    ("My cousin left Goldman Sachs to join a fintech startup called Stripe.", [{"start": 15, "end": 28, "label": "ORG"}, {"start": 62, "end": 68, "label": "ORG"}]),
    ("Samsung just announced a new foldable phone that actually looks durable.", [{"start": 0, "end": 7, "label": "ORG"}]),
    ("The FDA approved Moderna's updated vaccine for the fall season.", [{"start": 17, "end": 24, "label": "ORG"}]),
    ("Costco raised its membership fees for the first time in seven years.", [{"start": 0, "end": 6, "label": "ORG"}]),
    ("Amazon Web Services had a major outage that took down half the internet.", [{"start": 0, "end": 21, "label": "ORG"}]),
    ("Saw that Anthropic raised another huge round, like $7 billion or something.", [{"start": 9, "end": 18, "label": "ORG"}]),
    ("Toyota recalled 500,000 vehicles due to an airbag sensor defect.", [{"start": 0, "end": 6, "label": "ORG"}]),
    ("The European Commission fined Meta $1.3 billion for data privacy violations.", [{"start": 4, "end": 23, "label": "ORG"}, {"start": 30, "end": 34, "label": "ORG"}]),
    ("Lockheed Martin delivered the first batch of F-35s to the allied nations.", [{"start": 0, "end": 15, "label": "ORG"}]),
    ("I interviewed at Databricks last week and the technical round was brutal.", [{"start": 17, "end": 27, "label": "ORG"}]),
    ("Walmart is testing drone delivery in rural areas starting next month.", [{"start": 0, "end": 7, "label": "ORG"}]),
    ("The World Health Organization warned about a new respiratory virus variant.", [{"start": 4, "end": 29, "label": "ORG"}]),
    ("Netflix lost two million subscribers in Q3 after the price hike.", [{"start": 0, "end": 7, "label": "ORG"}]),
    ("Did you see that Uber is partnering with Waymo for autonomous rides in LA?", [{"start": 16, "end": 20, "label": "ORG"}, {"start": 41, "end": 46, "label": "ORG"}]),
    ("BYD overtook Tesla as the world's largest EV maker by volume.", [{"start": 0, "end": 3, "label": "ORG"}, {"start": 13, "end": 18, "label": "ORG"}]),
    ("Johnson & Johnson split into two companies last year and the stock went up.", [{"start": 0, "end": 19, "label": "ORG"}]),
    ("Heard that Coinbase might get delisted if the SEC lawsuit goes badly.", [{"start": 11, "end": 19, "label": "ORG"}]),
    ("Pfizer's new weight loss drug is entering Phase 3 trials next quarter.", [{"start": 0, "end": 6, "label": "ORG"}]),
]


class NERDataset(Dataset):
    def __init__(self, samples):
        self.samples = samples

    def __len__(self):
        return len(self.samples)

    def __getitem__(self, idx):
        return self.samples[idx]


def tokenize_and_align(text, entities, tokenizer, max_length):
    encoding = tokenizer(
        text,
        max_length=max_length,
        truncation=True,
        padding="max_length",
        return_offsets_mapping=True,
        return_tensors="pt",
    )
    offsets = encoding["offset_mapping"][0].tolist()

    char_labels = ["O"] * len(text)
    for ent in sorted(entities, key=lambda e: e["start"]):
        s, e, lbl = ent["start"], ent["end"], ent["label"]
        if lbl != "ORG":
            continue
        for i in range(s, min(e, len(text))):
            char_labels[i] = "B-ORG" if i == s else "I-ORG"

    # Align token offsets to char labels — check full span, not just start
    # (SentencePiece includes leading space in token, so start may point to whitespace)
    label_ids = []
    for start, end in offsets:
        if start == 0 and end == 0:
            label_ids.append(-100)  # special token
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


def load_jsonl_samples(path, doc_filter=None, max_samples=None):
    samples = []
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            rec = json.loads(line)
            doc_id = rec.get("original_doc", "")
            if doc_filter and not any(doc_id.startswith(p) for p in doc_filter):
                continue
            samples.append(rec)
            if max_samples and len(samples) >= max_samples:
                break
    return samples


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


def evaluate_level(model, dataloader, device):
    model.eval()
    all_preds, all_labels = [], []

    with torch.no_grad():
        for batch in dataloader:
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"]

            outputs = model(input_ids=input_ids, attention_mask=attention_mask)
            preds = outputs.logits.argmax(dim=-1).cpu()

            for pred_seq, label_seq in zip(preds, labels):
                pred_tags, true_tags = [], []
                for p, l in zip(pred_seq, label_seq):
                    if l.item() == -100:
                        continue
                    pred_tags.append(ID2LABEL[p.item()])
                    true_tags.append(ID2LABEL[l.item()])
                all_preds.append(pred_tags)
                all_labels.append(true_tags)

    tp = fp = fn = 0
    for pred_seq, true_seq in zip(all_preds, all_labels):
        pred_ents = extract_entities(pred_seq)
        true_ents = extract_entities(true_seq)
        matched = pred_ents & true_ents
        tp += len(matched)
        fp += len(pred_ents - true_ents)
        fn += len(true_ents - pred_ents)

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    return {"precision": precision, "recall": recall, "f1": f1, "tp": tp, "fp": fp, "fn": fn}


def main():
    cfg = Config()
    device = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
    logger.info(f"Device: {device}")
    logger.info(f"Model: {cfg.model_name} (434M params)")
    logger.info(f"Training: {cfg.train_samples} samples from {cfg.train_doc}, {cfg.epochs} epochs")

    tokenizer = AutoTokenizer.from_pretrained(cfg.model_name)

    # ---- Training set ----
    train_raw = load_jsonl_samples(cfg.data_path, doc_filter=[cfg.train_doc], max_samples=cfg.train_samples)
    logger.info(f"Training samples: {len(train_raw)}")
    train_data = [tokenize_and_align(r["text"], r.get("entities", []), tokenizer, cfg.max_length) for r in train_raw]
    train_loader = DataLoader(NERDataset(train_data), batch_size=cfg.batch_size, shuffle=True)

    # ---- 7-level test sets ----
    logger.info("Building 7-level test sets...")
    level_configs = [
        ("L1: Same doc, diff swaps", [cfg.train_doc], True),
        ("L2: Same type, diff doc", ["mer_02", "mer_03"], False),
        ("L3: Related financial", ["crd_01", "apa_01"], False),
        ("L4: Different legal", ["emp_01", "lic_01"], False),
        ("L5: Very different type", ["lea_01", "svc_01"], False),
        ("L6: Synthetic business", None, False),
        ("L7: Synthetic general", None, False),
    ]

    test_sets = {}
    for name, doc_filter, is_same_doc in level_configs:
        if "Synthetic business" in name:
            raw = SYNTHETIC_BUSINESS[:cfg.test_per_level]
            data = [tokenize_and_align(t, e, tokenizer, cfg.max_length) for t, e in raw]
        elif "Synthetic general" in name:
            raw = SYNTHETIC_GENERAL[:cfg.test_per_level]
            data = [tokenize_and_align(t, e, tokenizer, cfg.max_length) for t, e in raw]
        else:
            raw = load_jsonl_samples(cfg.data_path, doc_filter=doc_filter)
            if is_same_doc:
                raw = raw[cfg.train_samples : cfg.train_samples + cfg.test_per_level]
            else:
                random.seed(42)
                random.shuffle(raw)
                raw = raw[:cfg.test_per_level]
            data = [tokenize_and_align(r["text"], r.get("entities", []), tokenizer, cfg.max_length) for r in raw]
        test_sets[name] = DataLoader(NERDataset(data), batch_size=cfg.batch_size)
        logger.info(f"  {name}: {len(data)} samples")

    # ---- Load model ----
    logger.info(f"Loading {cfg.model_name}...")
    model = AutoModelForTokenClassification.from_pretrained(
        cfg.model_name, num_labels=len(LABELS), id2label=ID2LABEL, label2id=LABEL2ID,
    ).to(device)
    params = sum(p.numel() for p in model.parameters())
    logger.info(f"Params: {params:,} ({params // 1_000_000}M)")

    # ---- Train ----
    optimizer = torch.optim.AdamW(model.parameters(), lr=cfg.lr)
    logger.info(f"\n{'='*60}")
    logger.info(f"TRAINING: {cfg.epochs} epochs, {len(train_loader)} steps/epoch")
    logger.info(f"{'='*60}")

    t0 = time.time()
    for epoch in range(cfg.epochs):
        model.train()
        total_loss = 0
        for step, batch in enumerate(train_loader):
            input_ids = batch["input_ids"].to(device)
            attention_mask = batch["attention_mask"].to(device)
            labels = batch["labels"].to(device)
            outputs = model(input_ids=input_ids, attention_mask=attention_mask, labels=labels)
            loss = outputs.loss
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += loss.item()

            if (step + 1) % 5 == 0:
                logger.info(f"  Epoch {epoch+1} step {step+1}/{len(train_loader)} loss: {loss.item():.4f}")

        avg_loss = total_loss / len(train_loader)
        logger.info(f"  Epoch {epoch+1}/{cfg.epochs} avg_loss: {avg_loss:.4f} ({time.time()-t0:.0f}s)")

    train_time = time.time() - t0
    logger.info(f"Training done in {train_time:.0f}s\n")

    # ---- Evaluate all 7 levels ----
    logger.info(f"{'='*60}")
    logger.info("GENERALIZATION RESULTS — 7 LEVELS")
    logger.info(f"{'='*60}")

    results = []
    breaking_point = None

    for name, loader in test_sets.items():
        metrics = evaluate_level(model, loader, device)
        results.append((name, metrics))

        if metrics["f1"] >= 0.8:
            status = "PASS"
        elif metrics["f1"] >= 0.5:
            status = "DEGRADED"
        else:
            status = "FAIL"
            if not breaking_point:
                breaking_point = name

        logger.info(
            f"  {name:35s}  F1={metrics['f1']:.1%}  P={metrics['precision']:.1%}  "
            f"R={metrics['recall']:.1%}  TP={metrics['tp']} FP={metrics['fp']} FN={metrics['fn']}  [{status}]"
        )

    logger.info(f"\n{'='*60}")
    logger.info("SUMMARY")
    logger.info(f"{'='*60}")
    logger.info(f"Model: {cfg.model_name} ({params // 1_000_000}M params)")
    logger.info(f"Trained on: {len(train_raw)} samples from {cfg.train_doc} only")
    logger.info(f"Training time: {train_time:.0f}s")

    if breaking_point:
        logger.info(f"BREAKING POINT: {breaking_point}")
    else:
        logger.info("NO BREAKING POINT — model generalizes across ALL 7 levels!")

    out = {
        "config": {"model": cfg.model_name, "train_doc": cfg.train_doc,
                    "train_samples": len(train_raw), "epochs": cfg.epochs,
                    "training_time_s": round(train_time, 1)},
        "levels": [{"level": n, "f1": round(m["f1"], 4), "precision": round(m["precision"], 4),
                     "recall": round(m["recall"], 4), "tp": m["tp"], "fp": m["fp"], "fn": m["fn"]}
                    for n, m in results],
        "breaking_point": breaking_point,
    }
    with open("poc_generalization_results.json", "w") as f:
        json.dump(out, f, indent=2)
    logger.info("Results saved to poc_generalization_results.json")


if __name__ == "__main__":
    main()

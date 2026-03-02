#!/usr/bin/env python3
"""
Heuristic entity candidate extractor for SEC contracts.
Finds likely ORGs and PERSONs using legal document patterns.
Output: opus_annotations.jsonl for review/correction.
"""

import json
import re
from pathlib import Path

TXT_DIR = Path("/Users/donniedarko/Desktop/SEC_Training_Dataset/TXT")
OUTPUT = Path("/Users/donniedarko/Desktop/SEC_Training_Dataset/opus_annotations.jsonl")

# ORG patterns: "X LLC", "X Inc.", "X Corp.", "X LP", "X LLP", "X Co."
ORG_SUFFIX = re.compile(
    r'((?:[A-Z][A-Za-z&\',.\-\s]+?)\s*'
    r'(?:LLC|L\.L\.C\.|Inc\.|INC\.|Corp\.|CORP\.|Corporation|'
    r'LP|L\.P\.|LLP|L\.L\.P\.|Ltd\.|LIMITED|Co\.|Company|'
    r'N\.A\.|Trust|Fund|Partners|Holdings|Enterprises|Group))'
    r'(?:\s*,\s*(?:a\s+)?(?:Delaware|New York|California|Texas|Nevada|'
    r'New Jersey|Arizona|Florida|Maryland|Virginia|Georgia|'
    r'[A-Z][a-z]+)\s+(?:limited liability company|corporation|'
    r'general partnership|limited partnership|company))?',
    re.MULTILINE
)

# ALL-CAPS ORG names (like "AVENTIS INC." in headers)
ALL_CAPS_ORG = re.compile(
    r'\b([A-Z][A-Z\s&\',.\-]{3,}?'
    r'(?:LLC|INC\.?|CORP\.?|CORPORATION|LP|LLP|LTD\.?|LIMITED|'
    r'CO\.?|COMPANY|N\.A\.?|TRUST|FUND|PARTNERS|HOLDINGS|'
    r'ENTERPRISES|GROUP))\b'
)

# Defined term pattern: "XYZ" (the "Role")
DEFINED_TERM = re.compile(
    r'([A-Z][A-Za-z&\',.\-\s]+?(?:LLC|Inc\.|Corp\.|LP|Ltd\.|LIMITED|Company|Trust))'
    r'[,\s]*(?:\((?:the\s+)?"[A-Za-z\s]+"(?:\s+and[^)]+)?\))',
    re.MULTILINE
)

# PERSON patterns: /s/ Name or Name: after signature blocks
SIGNATURE = re.compile(r'/s/\s*([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)')
NAME_FIELD = re.compile(r'(?:Name|Print):\s*(?:/s/)?\s*([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)')

# ADDRESS patterns
ADDRESS = re.compile(
    r'(\d+\s+[A-Z][A-Za-z\s]+(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|'
    r'Drive|Dr\.|Lane|Ln\.|Way|Place|Pl\.|Court|Ct\.|Circle|Highway|Hwy\.)'
    r'(?:[,\s]+(?:Suite|Ste\.|Floor|Fl\.)\s*\d+)?'
    r'[,\s]+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?'
    r'[,\s]+[A-Z]{2}\s+\d{5}(?:-\d{4})?)',
    re.MULTILINE
)

# Simpler address: street + city + state
ADDRESS_SIMPLE = re.compile(
    r'(\d+\s+[A-Z][A-Za-z\s]+(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Boulevard|Blvd\.|'
    r'Drive|Dr\.|Lane|Ln\.|Way|Place|Court|Highway)'
    r'[,\s]+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?'
    r'[,\s]+(?:California|Florida|New York|Texas|Delaware|'
    r'Arizona|Nevada|New Jersey|Maryland|Virginia|Georgia|'
    r'[A-Z][a-z]+))',
    re.MULTILINE
)


def clean_org(name: str) -> str:
    """Clean up extracted ORG name."""
    name = name.strip().strip(',').strip()
    # Remove leading articles
    name = re.sub(r'^(?:the|The|THE)\s+', '', name)
    # Remove trailing whitespace and commas
    name = name.rstrip(',').strip()
    # Collapse multiple spaces
    name = re.sub(r'\s+', ' ', name)
    return name


def extract_entities(text: str) -> dict:
    """Extract entity candidates from contract text."""
    orgs = set()
    persons = set()
    addresses = set()

    # ORGs from suffixes
    for m in ORG_SUFFIX.finditer(text):
        org = clean_org(m.group(1))
        if len(org) > 3 and org not in ('The Company', 'The Borrower', 'The Lender'):
            orgs.add(org)

    # ALL-CAPS ORGs
    for m in ALL_CAPS_ORG.finditer(text):
        org = clean_org(m.group(1))
        if len(org) > 5:
            orgs.add(org)

    # Defined terms
    for m in DEFINED_TERM.finditer(text):
        org = clean_org(m.group(1))
        if len(org) > 3:
            orgs.add(org)

    # PERSONs from signatures
    for m in SIGNATURE.finditer(text):
        person = m.group(1).strip()
        if len(person) > 3 and not any(w in person.upper() for w in ['LLC', 'INC', 'CORP', 'THE']):
            persons.add(person)

    for m in NAME_FIELD.finditer(text):
        person = m.group(1).strip()
        if len(person) > 3 and not any(w in person.upper() for w in ['LLC', 'INC', 'CORP', 'THE']):
            persons.add(person)

    # ADDRESSes
    for m in ADDRESS.finditer(text):
        addresses.add(m.group(1).strip())
    for m in ADDRESS_SIMPLE.finditer(text):
        addr = m.group(1).strip()
        if addr not in addresses:
            addresses.add(addr)

    return {
        "orgs": sorted(orgs),
        "persons": sorted(persons),
        "addresses": sorted(addresses),
    }


def main():
    results = []

    for txt_file in sorted(TXT_DIR.glob("*.txt")):
        doc_id = txt_file.stem
        text = txt_file.read_text()

        entities = extract_entities(text)

        # Count occurrences
        org_counts = {o: text.count(o) for o in entities["orgs"]}
        person_counts = {p: text.count(p) for p in entities["persons"]}

        result = {
            "doc": doc_id,
            "orgs": entities["orgs"],
            "persons": entities["persons"],
            "addresses": entities["addresses"],
            "locations": [],  # to be filled manually
            "_org_counts": org_counts,
            "_person_counts": person_counts,
            "_text_length": len(text),
        }
        results.append(result)

        print(f"\n{doc_id} ({len(text):,} chars):")
        print(f"  ORGs ({len(entities['orgs'])}): {entities['orgs'][:8]}{'...' if len(entities['orgs']) > 8 else ''}")
        print(f"  PERSONs ({len(entities['persons'])}): {entities['persons']}")
        print(f"  ADDRESSes ({len(entities['addresses'])}): {entities['addresses'][:3]}")

    # Write annotations
    with open(OUTPUT, "w") as f:
        for r in results:
            f.write(json.dumps(r) + "\n")

    print(f"\n{'='*60}")
    print(f"Wrote {len(results)} document annotations to {OUTPUT}")
    total_orgs = sum(len(r["orgs"]) for r in results)
    total_persons = sum(len(r["persons"]) for r in results)
    total_addrs = sum(len(r["addresses"]) for r in results)
    print(f"Total: {total_orgs} unique ORGs, {total_persons} unique PERSONs, {total_addrs} ADDRESSes")
    print(f"\nReview and correct {OUTPUT} before running opus_label_pipeline.py")


if __name__ == "__main__":
    main()

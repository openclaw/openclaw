#!/usr/bin/env python3
"""
SEC EDGAR Real Contract Downloader & Training Dataset Builder
Downloads 31 real, non-synthetic financial agreements from SEC EDGAR
and builds a structured training dataset organized by agreement type.
"""

import json
import os
import re
import time
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

OUTPUT_DIR = Path(os.path.expanduser("~/Documents/SEC_Contracts_Dataset"))
RAW_DIR = OUTPUT_DIR / "raw_html"
TEXT_DIR = OUTPUT_DIR / "extracted_text"
DATASET_FILE = OUTPUT_DIR / "training_dataset.jsonl"
CATALOG_FILE = OUTPUT_DIR / "contract_catalog.json"

# 31 real SEC EDGAR contracts across 12 agreement types
CONTRACTS = [
    # OPERATING AGREEMENTS
    {"id": "op_01", "type": "Operating Agreement", "url": "https://www.sec.gov/Archives/edgar/data/2000597/000119312524135401/d812027dex101.htm", "desc": "Apollo Asset Backed Credit Company LLC Operating Agreement (2024)"},
    {"id": "op_02", "type": "Operating Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1893768/000121465924004276/ex1_1.htm", "desc": "First Amended and Restated Operating Agreement (2024)"},
    {"id": "op_03", "type": "Operating Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1079786/000092242307000542/kl04075_ex10-1.htm", "desc": "LLC Operating Agreement Exhibit 10.1"},

    # SUBSCRIPTION AGREEMENTS
    {"id": "sub_01", "type": "Subscription Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1811210/000110465924038177/tm249613d1_ex10-1.htm", "desc": "Lucid Group Subscription Agreement (2024)"},
    {"id": "sub_02", "type": "Subscription Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1830210/000183021022000072/exhibit101formofsubscripti.htm", "desc": "Form of Subscription Agreement"},
    {"id": "sub_03", "type": "Subscription Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1700844/000149315222016029/ex10-1.htm", "desc": "Form of Subscription Agreement Between Parties"},

    # ASSET PURCHASE AGREEMENTS
    {"id": "apa_01", "type": "Asset Purchase Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1838987/000121390024065369/ea0210606ex10-1_complete.htm", "desc": "Complete Solaria Asset Purchase Agreement (Aug 2024)"},
    {"id": "apa_02", "type": "Asset Purchase Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1690080/000121390024084859/ea021640301ex2-1_180life.htm", "desc": "180 Life Sciences Asset Purchase Agreement (Sep 2024)"},
    {"id": "apa_03", "type": "Asset Purchase Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1100397/000149315224005035/ex2-1.htm", "desc": "Ayala/Immunome Asset Purchase Agreement (Feb 2024)"},

    # SECURITIES PURCHASE AGREEMENT
    {"id": "spa_01", "type": "Securities Purchase Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1677077/000121465924001777/ex10_1.htm", "desc": "Securities Purchase Agreement (Jan 2024)"},

    # CREDIT AGREEMENTS
    {"id": "crd_01", "type": "Credit Agreement", "url": "https://www.sec.gov/Archives/edgar/data/764764/000110465924096578/tm2423021d1_ex10-1.htm", "desc": "Caterpillar Credit Agreement 364-Day Facility (2024)"},
    {"id": "crd_02", "type": "Credit Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1818643/000119312524286101/d835594dex1019.htm", "desc": "Credit Agreement EX-10.19 (2024)"},
    {"id": "crd_03", "type": "Credit Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1789940/000178994024000003/exhibit101amendmentno2tocr.htm", "desc": "Amendment No. 2 to Credit Agreement (2024)"},

    # LICENSE AGREEMENTS
    {"id": "lic_01", "type": "License Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1821175/000149315224015125/ex10-1.htm", "desc": "Motorsport Games Settlement/License Agreement (2024)"},
    {"id": "lic_02", "type": "License Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1411579/000110465924081453/tm2419663d1_ex10-3.htm", "desc": "Intercompany License Agreement (Jul 2024)"},
    {"id": "lic_03", "type": "License Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1697532/000104746919002204/a2238428zex-10_11.htm", "desc": "Exclusive License Agreement"},

    # EMPLOYMENT AGREEMENTS
    {"id": "emp_01", "type": "Employment Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1144879/000149315224041176/ex10-3.htm", "desc": "Applied Digital Executive Employment Agreement (Oct 2024)"},
    {"id": "emp_02", "type": "Employment Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1392380/000110465924090361/tm2421638d1_ex10-1.htm", "desc": "Amended and Restated Employment Agreement (Aug 2024)"},
    {"id": "emp_03", "type": "Employment Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1936224/000095017024062450/srfm-ex10_1.htm", "desc": "Employment Agreement EX-10.1 (2024)"},

    # CONSULTING AGREEMENTS
    {"id": "con_01", "type": "Consulting Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1615219/000161521924000017/exhibit1022.htm", "desc": "Salarius Pharmaceuticals Consulting Agreement (Feb 2024)"},
    {"id": "con_02", "type": "Consulting Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1812727/000149315224004415/ex10-1.htm", "desc": "Consulting Agreement EX-10.1 (2024)"},

    # MERGER AGREEMENTS
    {"id": "mer_01", "type": "Merger Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1739614/000110465924005727/tm243849d1_ex2-1.htm", "desc": "Aventis/Inhibrx Agreement and Plan of Merger (Jan 2024)"},
    {"id": "mer_02", "type": "Merger Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1591698/000159169824000222/pcty-202408298xkxexhibit21.htm", "desc": "Paylocity/AirBase Merger Agreement (Aug 2024)"},
    {"id": "mer_03", "type": "Merger Agreement", "url": "https://www.sec.gov/Archives/edgar/data/936468/000093646824000099/exhibit998-agreementandpla.htm", "desc": "Lockheed Martin/Terran Orbital Merger Agreement (Aug 2024)"},

    # LEASE AGREEMENTS
    {"id": "lea_01", "type": "Lease Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1907982/000190798224000049/exhibit1067-thirdamendment.htm", "desc": "D-Wave Third Amendment to Lease (2024)"},
    {"id": "lea_02", "type": "Lease Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1708176/000121390024018617/ea0200951ex10-4_halloffame.htm", "desc": "Hall of Fame Second Amendment to Lease Agreement (Feb 2024)"},
    {"id": "lea_03", "type": "Lease Agreement", "url": "https://www.sec.gov/Archives/edgar/data/2019410/000110465925052381/tm2415719d15_ex10-3a.htm", "desc": "Lease Agreement dated March 1"},

    # SECURITY / GUARANTY / PLEDGE AGREEMENTS
    {"id": "sec_01", "type": "Security Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1674227/000121390024061487/ea020945901ex10-4_scworx.htm", "desc": "SCWORX Guaranty and Security Agreement (Jul 2024)"},
    {"id": "sec_02", "type": "Security Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1014111/000149315224022741/ex10-3.htm", "desc": "Limited Guaranty Pledge and Security Agreement (May 2024)"},

    # SERVICES AGREEMENTS
    {"id": "svc_01", "type": "Services Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1812360/000121390024004834/ea191887ex99-1_foxotech.htm", "desc": "FOXO Tech/KR8 AI Master Software and Services Agreement (Jan 2024)"},
    {"id": "svc_02", "type": "Services Agreement", "url": "https://www.sec.gov/Archives/edgar/data/1823878/000182387824000028/myps-20240708xexhibit102.htm", "desc": "PLAYSTUDIOS Services/Asset Agreement (Jul 2024)"},
]


class HTMLTextExtractor(HTMLParser):
    """Extract clean text from SEC EDGAR HTML filings."""
    def __init__(self):
        super().__init__()
        self.result = []
        self.skip = False
        self.skip_tags = {'script', 'style', 'head', 'meta', 'link'}

    def handle_starttag(self, tag, attrs):
        if tag.lower() in self.skip_tags:
            self.skip = True
        if tag.lower() in ('br', 'p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4'):
            self.result.append('\n')

    def handle_endtag(self, tag):
        if tag.lower() in self.skip_tags:
            self.skip = False
        if tag.lower() in ('p', 'div', 'tr', 'td', 'th', 'li', 'h1', 'h2', 'h3', 'h4'):
            self.result.append('\n')

    def handle_data(self, data):
        if not self.skip:
            self.result.append(data)

    def get_text(self):
        text = ''.join(self.result)
        # Clean up excessive whitespace
        text = re.sub(r'[ \t]+', ' ', text)
        text = re.sub(r'\n\s*\n', '\n\n', text)
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text.strip()


def download_contract(contract, raw_dir):
    """Download a single contract from SEC EDGAR."""
    filepath = raw_dir / f"{contract['id']}.htm"
    if filepath.exists():
        print(f"  [CACHED] {contract['id']}")
        return filepath

    headers = {
        'User-Agent': 'DonnyDarko/ResearchBot donny@example.com',
        'Accept': 'text/html,application/xhtml+xml',
    }
    req = urllib.request.Request(contract['url'], headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            html = resp.read().decode('utf-8', errors='replace')
        filepath.write_text(html, encoding='utf-8')
        print(f"  [OK] {contract['id']} - {len(html):,} bytes")
        return filepath
    except Exception as e:
        print(f"  [FAIL] {contract['id']} - {e}")
        return None


def extract_text(html_path, text_dir, contract_id):
    """Extract clean text from downloaded HTML."""
    text_path = text_dir / f"{contract_id}.txt"
    if text_path.exists():
        return text_path

    html = html_path.read_text(encoding='utf-8', errors='replace')
    extractor = HTMLTextExtractor()
    extractor.feed(html)
    text = extractor.get_text()
    text_path.write_text(text, encoding='utf-8')
    return text_path


def build_training_record(contract, text_path):
    """Build a JSONL training record for a single contract."""
    text = text_path.read_text(encoding='utf-8')
    word_count = len(text.split())

    # Extract sections (common legal contract headings)
    sections = re.findall(
        r'(?:ARTICLE|SECTION|Article|Section)\s+[\dIVXivx]+[.\s]+[A-Z][^\n]{5,80}',
        text
    )

    return {
        "id": contract["id"],
        "agreement_type": contract["type"],
        "description": contract["desc"],
        "source_url": contract["url"],
        "source": "SEC EDGAR",
        "synthetic": False,
        "word_count": word_count,
        "sections_found": sections[:20],
        "full_text": text,
    }


def main():
    # Create directories
    for d in [OUTPUT_DIR, RAW_DIR, TEXT_DIR]:
        d.mkdir(parents=True, exist_ok=True)

    print(f"=" * 70)
    print(f"SEC EDGAR Real Contract Downloader")
    print(f"Target: {len(CONTRACTS)} contracts across 12 agreement types")
    print(f"Output: {OUTPUT_DIR}")
    print(f"=" * 70)

    # Phase 1: Download
    print(f"\n--- PHASE 1: Downloading from SEC EDGAR ---")
    downloaded = {}
    for i, c in enumerate(CONTRACTS):
        print(f"[{i+1}/{len(CONTRACTS)}] {c['type']}: {c['desc'][:60]}...")
        path = download_contract(c, RAW_DIR)
        if path:
            downloaded[c['id']] = path
        time.sleep(0.2)  # Be respectful to SEC servers

    print(f"\nDownloaded: {len(downloaded)}/{len(CONTRACTS)}")

    # Phase 2: Extract text
    print(f"\n--- PHASE 2: Extracting text ---")
    extracted = {}
    for c in CONTRACTS:
        if c['id'] in downloaded:
            text_path = extract_text(downloaded[c['id']], TEXT_DIR, c['id'])
            extracted[c['id']] = text_path
            text = text_path.read_text()
            print(f"  {c['id']}: {len(text.split()):,} words")

    # Phase 3: Build training dataset
    print(f"\n--- PHASE 3: Building training dataset ---")
    records = []
    with open(DATASET_FILE, 'w', encoding='utf-8') as f:
        for c in CONTRACTS:
            if c['id'] in extracted:
                record = build_training_record(c, extracted[c['id']])
                f.write(json.dumps(record, ensure_ascii=False) + '\n')
                records.append({k: v for k, v in record.items() if k != 'full_text'})

    # Phase 4: Save catalog
    catalog = {
        "total_contracts": len(records),
        "agreement_types": {},
        "contracts": records,
    }
    for r in records:
        t = r['agreement_type']
        if t not in catalog['agreement_types']:
            catalog['agreement_types'][t] = 0
        catalog['agreement_types'][t] += 1

    with open(CATALOG_FILE, 'w', encoding='utf-8') as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)

    # Summary
    print(f"\n{'=' * 70}")
    print(f"DONE!")
    print(f"{'=' * 70}")
    print(f"Total contracts downloaded: {len(downloaded)}")
    print(f"Total text extracted:       {len(extracted)}")
    print(f"Training dataset:           {DATASET_FILE}")
    print(f"Contract catalog:           {CATALOG_FILE}")
    print(f"\nAgreement type breakdown:")
    for t, count in sorted(catalog['agreement_types'].items()):
        print(f"  {t}: {count}")
    print(f"\nAll files in: {OUTPUT_DIR}")


if __name__ == '__main__':
    main()

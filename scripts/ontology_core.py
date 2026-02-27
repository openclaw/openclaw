#!/usr/bin/env python3
"""
ontology_core.py — OpenClaw 온톨로지 기반 지식 그래프 코어 모듈
rdflib 기반, BusinessSegment CRUD, SPARQL 엔진, 자연어→SPARQL, CLI
"""

import argparse
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path

from rdflib import Graph, Namespace, Literal, URIRef, RDF, RDFS, XSD
from rdflib.namespace import FOAF, DCTERMS, SKOS

# ─── Namespace ────────────────────────────────────────────
RON = Namespace("http://ron.openclaw.local/ontology#")

# ─── Paths ────────────────────────────────────────────────
BASE_DIR = Path("/Users/ron/.openclaw/workspace")
KNOWLEDGE_TTL = BASE_DIR / "knowledge" / "ontology" / "knowledge.ttl"

# ─── Segment keyword mapping ─────────────────────────────
SEGMENT_MAP = {
    "samsung_electronics": [
        {"id": "samsung_memory", "name": "Memory", "name_ko": "메모리",
         "sectors": ["ai_semiconductor"], "keywords": ["메모리", "DRAM", "NAND", "HBM", "memory"]},
        {"id": "samsung_foundry", "name": "Foundry", "name_ko": "파운드리",
         "sectors": ["ai_semiconductor"], "keywords": ["파운드리", "foundry", "GAA", "2nm", "3nm"]},
        {"id": "samsung_handset", "name": "MX (Mobile eXperience)", "name_ko": "핸드셋(MX)",
         "sectors": ["consumer_electronics"], "keywords": ["MX", "갤럭시", "Galaxy", "핸드셋", "handset"]},
        {"id": "samsung_display", "name": "Display", "name_ko": "디스플레이",
         "sectors": ["display"], "keywords": ["디스플레이", "OLED", "QD-OLED", "패널", "display"]},
        {"id": "samsung_harman", "name": "Harman (Automotive)", "name_ko": "하만(전장)",
         "sectors": ["automotive", "iot"], "keywords": ["하만", "Harman", "전장", "automotive"]},
    ]
}


class OntologyCore:
    """RDF 그래프 기반 지식 관리 코어"""

    def __init__(self, ttl_path=None):
        self.ttl_path = Path(ttl_path) if ttl_path else KNOWLEDGE_TTL
        self.g = Graph()
        self.g.bind("ron", RON)
        self.g.bind("foaf", FOAF)
        self.g.bind("dcterms", DCTERMS)
        self.g.bind("skos", SKOS)
        self._load()

    def _load(self):
        if self.ttl_path.exists():
            self.g.parse(str(self.ttl_path), format="turtle")

    def save(self):
        self.ttl_path.parent.mkdir(parents=True, exist_ok=True)
        self.g.serialize(str(self.ttl_path), format="turtle")

    # ─── URI helpers ──────────────────────────────────────
    @staticmethod
    def uri(path):
        return RON[path]

    @staticmethod
    def stock_uri(slug):
        return RON[f"stock/{slug}"]

    @staticmethod
    def segment_uri(slug):
        return RON[f"segment/{slug}"]

    @staticmethod
    def etf_uri(slug):
        return RON[f"etf/{slug}"]

    @staticmethod
    def sector_uri(slug):
        return RON[f"sector/{slug}"]

    @staticmethod
    def indicator_uri(slug):
        return RON[f"indicator/{slug}"]

    @staticmethod
    def segobs_uri(slug):
        return RON[f"segobs/{slug}"]

    @staticmethod
    def person_uri(slug):
        return RON[f"person/{slug}"]

    @staticmethod
    def conv_uri(slug):
        return RON[f"conv/{slug}"]

    # ─── Basic CRUD ───────────────────────────────────────
    def add_entity(self, rdf_type, entity_id, properties=None):
        type_map = {
            "Person": RON.Person, "ETF": RON.ETF, "Stock": RON.Stock,
            "BusinessSegment": RON.BusinessSegment, "Sector": RON.Sector,
            "EconomicIndicator": RON.EconomicIndicator,
            "Observation": RON.Observation,
            "SegmentObservation": RON.SegmentObservation,
            "SegmentRiskEvent": RON.SegmentRiskEvent,
            "Conversation": RON.Conversation, "Document": RON.Document,
            "Event": RON.Event, "Device": RON.Device,
            "DataSource": RON.DataSource, "Skill": RON.Skill,
        }
        uri_map = {
            "Person": self.person_uri, "ETF": self.etf_uri,
            "Stock": self.stock_uri, "Sector": self.sector_uri,
            "EconomicIndicator": self.indicator_uri,
            "Conversation": self.conv_uri,
        }

        cls = type_map.get(rdf_type)
        if not cls:
            return {"error": f"Unknown type: {rdf_type}"}

        uri_fn = uri_map.get(rdf_type, lambda x: RON[entity_id])
        uri = uri_fn(entity_id)

        self.g.add((uri, RDF.type, cls))
        if properties:
            self._set_properties(uri, properties)
        self.save()
        return {"uri": str(uri), "type": rdf_type}

    def add_relation(self, subject_uri, predicate, object_uri):
        s = URIRef(subject_uri) if isinstance(subject_uri, str) else subject_uri
        p = RON[predicate] if not isinstance(predicate, URIRef) else predicate
        o = URIRef(object_uri) if isinstance(object_uri, str) else object_uri
        self.g.add((s, p, o))
        self.save()
        return {"subject": str(s), "predicate": str(p), "object": str(o)}

    def remove_entity(self, uri_str):
        uri = URIRef(uri_str)
        removed = 0
        for s, p, o in list(self.g.triples((uri, None, None))):
            self.g.remove((s, p, o))
            removed += 1
        for s, p, o in list(self.g.triples((None, None, uri))):
            self.g.remove((s, p, o))
            removed += 1
        self.save()
        return {"removed_triples": removed}

    def update_entity(self, uri_str, properties):
        uri = URIRef(uri_str)
        self._set_properties(uri, properties)
        self.save()
        return {"uri": uri_str, "updated": list(properties.keys())}

    def _set_properties(self, uri, props):
        for key, val in props.items():
            pred = self._resolve_predicate(key)
            # Remove old value for this property
            for _, _, old_o in list(self.g.triples((uri, pred, None))):
                self.g.remove((uri, pred, old_o))
            if isinstance(val, (int, float)):
                self.g.add((uri, pred, Literal(val, datatype=XSD.decimal)))
            elif isinstance(val, bool):
                self.g.add((uri, pred, Literal(val, datatype=XSD.boolean)))
            else:
                self.g.add((uri, pred, Literal(str(val))))

    def _resolve_predicate(self, key):
        mapping = {
            "name": RDFS.label, "label": RDFS.label,
            "name_ko": RON.nameKo, "description": DCTERMS.description,
            "ticker": RON.ticker, "exchange": RON.exchange,
            "weight": RON.weight, "shares": RON.shares,
            "value": RON.holdingValue, "code": RON.code,
        }
        return mapping.get(key, RON[key])

    # ─── Segment CRUD ─────────────────────────────────────
    def add_segment(self, stock_id, segment_id, props=None):
        stock_uri = self.stock_uri(stock_id)
        seg_uri = self.segment_uri(segment_id)

        self.g.add((seg_uri, RDF.type, RON.BusinessSegment))
        self.g.add((stock_uri, RON.hasBusinessSegment, seg_uri))
        self.g.add((seg_uri, RON.segmentOf, stock_uri))

        if props:
            if "name" in props:
                self.g.add((seg_uri, RDFS.label, Literal(props["name"])))
            if "name_ko" in props:
                self.g.add((seg_uri, RON.nameKo, Literal(props["name_ko"])))
            if "description" in props:
                self.g.add((seg_uri, DCTERMS.description, Literal(props["description"])))
            for sector_slug in props.get("related_sectors", []):
                sector_uri = self.sector_uri(sector_slug)
                self.g.add((seg_uri, RON.segmentRelatedToSector, sector_uri))

        self.save()
        return {"stock": str(stock_uri), "segment": str(seg_uri)}

    def add_segment_observation(self, segment_id, date, revenue=None,
                                operating_profit=None, margin=None, source=None):
        seg_uri = self.segment_uri(segment_id)
        obs_id = f"{segment_id}_{date}"
        obs_uri = self.segobs_uri(obs_id)

        self.g.add((obs_uri, RDF.type, RON.SegmentObservation))
        self.g.add((seg_uri, RON.segmentObservation, obs_uri))
        self.g.add((obs_uri, RON.observationDate, Literal(date)))

        if revenue is not None:
            self.g.add((obs_uri, RON.revenue, Literal(revenue, datatype=XSD.decimal)))
        if operating_profit is not None:
            self.g.add((obs_uri, RON.operatingProfit, Literal(operating_profit, datatype=XSD.decimal)))
        if margin is not None:
            self.g.add((obs_uri, RON.margin, Literal(margin, datatype=XSD.decimal)))
        if source:
            self.g.add((obs_uri, RON.source, Literal(source)))

        self.save()
        return {"observation": str(obs_uri)}

    def get_company_segments(self, stock_id):
        stock_uri = self.stock_uri(stock_id)
        q = """
        SELECT ?seg ?name ?nameKo WHERE {
            ?stock ron:hasBusinessSegment ?seg .
            OPTIONAL { ?seg rdfs:label ?name }
            OPTIONAL { ?seg ron:nameKo ?nameKo }
        }
        ORDER BY ?name
        """
        results = self.g.query(q, initNs={"ron": RON, "rdfs": RDFS},
                               initBindings={"stock": stock_uri})
        segments = []
        for row in results:
            segments.append({
                "uri": str(row.seg),
                "name": str(row.name) if row.name else None,
                "name_ko": str(row.nameKo) if row.nameKo else None,
            })
        return segments

    def get_segment_snapshot(self, segment_id, latest_n=4):
        seg_uri = self.segment_uri(segment_id)
        q = """
        SELECT ?date ?rev ?op ?margin ?source WHERE {
            ?seg ron:segmentObservation ?obs .
            ?obs ron:observationDate ?date .
            OPTIONAL { ?obs ron:revenue ?rev }
            OPTIONAL { ?obs ron:operatingProfit ?op }
            OPTIONAL { ?obs ron:margin ?margin }
            OPTIONAL { ?obs ron:source ?source }
        }
        ORDER BY DESC(?date)
        """
        results = self.g.query(q, initNs={"ron": RON},
                               initBindings={"seg": seg_uri})
        observations = []
        for i, row in enumerate(results):
            if i >= latest_n:
                break
            observations.append({
                "date": str(row.date) if row.date else None,
                "revenue": str(row.rev) if row.rev else None,
                "operating_profit": str(row.op) if row.op else None,
                "margin": str(row.margin) if row.margin else None,
                "source": str(row.source) if row.source else None,
            })
        return observations

    # ─── Query ────────────────────────────────────────────
    def query_sparql(self, sparql_string):
        results = self.g.query(sparql_string, initNs={
            "ron": RON, "rdfs": RDFS, "foaf": FOAF,
            "dcterms": DCTERMS, "skos": SKOS, "xsd": XSD,
        })
        rows = []
        for row in results:
            rows.append({str(k): str(v) for k, v in zip(results.vars, row)})
        return rows

    def query_natural(self, question):
        """자연어 → SPARQL 변환 (Ollama kimi-k2.5 경유)"""
        schema_summary = self._get_schema_summary()
        prompt = f"""You are a SPARQL query generator for an RDF knowledge graph.

Schema:
{schema_summary}

Prefix: ron: <http://ron.openclaw.local/ontology#>
Also available: rdfs:, foaf:, dcterms:, skos:, xsd:

User question: {question}

Return ONLY the SPARQL SELECT query, no explanation. Use the prefixes above."""

        try:
            sparql = self._call_ollama(prompt)
            # Extract SPARQL from response
            sparql = sparql.strip()
            if "```" in sparql:
                sparql = re.search(r"```(?:sparql)?\s*(.*?)```", sparql, re.DOTALL)
                sparql = sparql.group(1).strip() if sparql else ""
            if not sparql.upper().startswith("SELECT") and not sparql.upper().startswith("PREFIX"):
                return {"error": "Model did not return valid SPARQL", "raw": sparql}
            results = self.query_sparql(sparql)
            return {"sparql": sparql, "results": results}
        except Exception as e:
            return {"error": str(e)}

    def _call_ollama(self, prompt):
        url = "http://127.0.0.1:11434/api/generate"
        payload = json.dumps({
            "model": "kimi-k2.5:cloud",
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.1, "num_predict": 512}
        }).encode("utf-8")
        req = urllib.request.Request(url, data=payload,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("response", "")
        except urllib.error.URLError:
            # Fallback: try qwen3:14b
            payload2 = json.dumps({
                "model": "qwen3:14b",
                "prompt": prompt,
                "stream": False,
                "options": {"temperature": 0.1, "num_predict": 512}
            }).encode("utf-8")
            req2 = urllib.request.Request(url, data=payload2,
                                          headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req2, timeout=60) as resp2:
                data2 = json.loads(resp2.read().decode("utf-8"))
                return data2.get("response", "")

    def _get_schema_summary(self):
        return """Classes: ron:Stock, ron:ETF, ron:BusinessSegment, ron:Sector,
ron:EconomicIndicator, ron:Observation, ron:SegmentObservation, ron:Person,
ron:Conversation, ron:Document, ron:Device, ron:DataSource, ron:Skill

Key Properties:
- ron:hasBusinessSegment (Stock → BusinessSegment)
- ron:segmentOf (BusinessSegment → Stock)
- ron:segmentObservation (BusinessSegment → SegmentObservation)
- ron:segmentRelatedToSector (BusinessSegment → Sector)
- ron:holds (ETF → Stock, with ron:weight)
- ron:belongsTo (Stock → Sector)
- ron:tracks (ETF → Sector)
- ron:correlatesWith (EconomicIndicator → Sector)
- ron:affectedByIndicator (BusinessSegment → EconomicIndicator)
- ron:mentionedIn (any → Conversation)
- skos:broader, skos:narrower, skos:related (Sector hierarchy)
- rdfs:label (name), ron:nameKo (Korean name)
- ron:ticker, ron:exchange (Stock attributes)
- ron:observationDate, ron:revenue, ron:operatingProfit, ron:margin (SegmentObservation)
- ron:recordedOn, ron:hasValue (Observation)"""

    def get_related(self, entity_uri_str, depth=2):
        uri = URIRef(entity_uri_str)
        visited = set()
        result = []
        self._traverse(uri, depth, visited, result)
        return result

    def _traverse(self, uri, depth, visited, result):
        if depth <= 0 or str(uri) in visited:
            return
        visited.add(str(uri))
        for s, p, o in self.g.triples((uri, None, None)):
            if isinstance(o, URIRef):
                result.append({"from": str(s), "rel": str(p), "to": str(o)})
                self._traverse(o, depth - 1, visited, result)
        for s, p, o in self.g.triples((None, None, uri)):
            if isinstance(s, URIRef):
                result.append({"from": str(s), "rel": str(p), "to": str(o)})
                self._traverse(s, depth - 1, visited, result)

    # ─── Data Import ──────────────────────────────────────
    def import_etf_data(self, json_path):
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)

        etf_name = data.get("etf", "unknown")
        etf_slug = etf_name.lower().replace(" ", "_").replace("-", "_")
        etf_uri = self.etf_uri(etf_slug)

        self.g.add((etf_uri, RDF.type, RON.ETF))
        self.g.add((etf_uri, RDFS.label, Literal(etf_name)))
        if data.get("date"):
            self.g.add((etf_uri, DCTERMS.modified, Literal(data["date"])))

        added_stocks = 0
        for h in data.get("holdings", []):
            name = h.get("name", "")
            ticker = h.get("ticker", "")
            if not name or name == "현금":
                continue

            stock_slug = self._slugify(name)
            stock_uri = self.stock_uri(stock_slug)

            # Add stock if not exists
            if (stock_uri, RDF.type, RON.Stock) not in self.g:
                self.g.add((stock_uri, RDF.type, RON.Stock))
                self.g.add((stock_uri, RDFS.label, Literal(name)))
                if ticker:
                    self.g.add((stock_uri, RON.ticker, Literal(ticker)))
                if h.get("code"):
                    self.g.add((stock_uri, RON.code, Literal(h["code"])))
                added_stocks += 1

            # holds relation with weight
            holding_uri = RON[f"holding/{etf_slug}_{stock_slug}"]
            # Remove old holding data
            for _, _, old in list(self.g.triples((holding_uri, None, None))):
                self.g.remove((holding_uri, _, old))
            self.g.add((holding_uri, RDF.type, RON.Holding))
            self.g.add((holding_uri, RON.holdingETF, etf_uri))
            self.g.add((holding_uri, RON.holdingStock, stock_uri))
            self.g.add((etf_uri, RON.holds, stock_uri))
            if h.get("weight") is not None:
                self.g.add((holding_uri, RON.weight,
                            Literal(h["weight"], datatype=XSD.decimal)))
            if h.get("shares") is not None:
                self.g.add((holding_uri, RON.shares,
                            Literal(h["shares"], datatype=XSD.decimal)))
            if h.get("value") is not None:
                self.g.add((holding_uri, RON.holdingValue,
                            Literal(h["value"], datatype=XSD.decimal)))

        self.save()
        return {"etf": etf_slug, "new_stocks": added_stocks,
                "holdings": len(data.get("holdings", []))}

    def import_credit_data(self, csv_path):
        """Import credit/deposit CSV data as Observations"""
        import csv
        credit_uri = self.indicator_uri("credit_balance")
        deposit_uri = self.indicator_uri("deposit")

        if (credit_uri, RDF.type, RON.EconomicIndicator) not in self.g:
            self.g.add((credit_uri, RDF.type, RON.EconomicIndicator))
            self.g.add((credit_uri, RDFS.label, Literal("신용공여잔고")))
            self.g.add((credit_uri, RON.nameKo, Literal("신용공여잔고")))

        if (deposit_uri, RDF.type, RON.EconomicIndicator) not in self.g:
            self.g.add((deposit_uri, RDF.type, RON.EconomicIndicator))
            self.g.add((deposit_uri, RDFS.label, Literal("투자자예탁금")))
            self.g.add((deposit_uri, RON.nameKo, Literal("투자자예탁금")))

        count = 0
        with open(csv_path, "r", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            for row in reader:
                date = row.get("date", row.get("날짜", ""))
                credit = row.get("credit", row.get("신용공여잔고", ""))
                deposit = row.get("deposit", row.get("투자자예탁금", ""))

                if date and credit:
                    obs_uri = RON[f"obs/credit_{date}"]
                    self.g.add((obs_uri, RDF.type, RON.Observation))
                    self.g.add((obs_uri, RON.observedIndicator, credit_uri))
                    self.g.add((obs_uri, RON.recordedOn, Literal(date, datatype=XSD.date)))
                    try:
                        self.g.add((obs_uri, RON.hasValue,
                                    Literal(float(credit.replace(",", "")), datatype=XSD.decimal)))
                    except (ValueError, AttributeError):
                        pass

                if date and deposit:
                    obs_uri = RON[f"obs/deposit_{date}"]
                    self.g.add((obs_uri, RDF.type, RON.Observation))
                    self.g.add((obs_uri, RON.observedIndicator, deposit_uri))
                    self.g.add((obs_uri, RON.recordedOn, Literal(date, datatype=XSD.date)))
                    try:
                        self.g.add((obs_uri, RON.hasValue,
                                    Literal(float(deposit.replace(",", "")), datatype=XSD.decimal)))
                    except (ValueError, AttributeError):
                        pass
                count += 1

        self.save()
        return {"imported_rows": count}

    def extract_entities_from_text(self, text):
        """텍스트에서 엔티티 + 세그먼트 키워드 추출"""
        found = {"stocks": [], "segments": [], "sectors": [], "indicators": []}

        # Check all known entities
        for s, _, name in self.g.triples((None, RDFS.label, None)):
            if str(name) in text:
                entity_type = None
                for _, _, t in self.g.triples((s, RDF.type, None)):
                    entity_type = str(t).split("#")[-1]
                    break
                if entity_type == "Stock":
                    found["stocks"].append({"uri": str(s), "name": str(name)})
                elif entity_type == "Sector":
                    found["sectors"].append({"uri": str(s), "name": str(name)})
                elif entity_type == "EconomicIndicator":
                    found["indicators"].append({"uri": str(s), "name": str(name)})

        # Check Korean names
        for s, _, name in self.g.triples((None, RON.nameKo, None)):
            if str(name) in text:
                entity_type = None
                for _, _, t in self.g.triples((s, RDF.type, None)):
                    entity_type = str(t).split("#")[-1]
                    break
                if entity_type == "BusinessSegment":
                    found["segments"].append({"uri": str(s), "name_ko": str(name)})

        # Check segment keywords from SEGMENT_MAP
        for company, segments in SEGMENT_MAP.items():
            for seg in segments:
                for kw in seg["keywords"]:
                    if kw.lower() in text.lower():
                        seg_uri = str(self.segment_uri(seg["id"]))
                        entry = {"uri": seg_uri, "keyword": kw,
                                 "segment": seg["id"], "name": seg["name"]}
                        if entry not in found["segments"]:
                            found["segments"].append(entry)

        return found

    # ─── Utilities ────────────────────────────────────────
    def export_graph(self, fmt="turtle"):
        return self.g.serialize(format=fmt)

    def stats(self):
        total = len(self.g)
        class_counts = {}
        for cls_name in ["Stock", "ETF", "BusinessSegment", "Sector",
                         "EconomicIndicator", "Observation", "SegmentObservation",
                         "Person", "Conversation", "Document", "Device",
                         "DataSource", "Skill", "Holding"]:
            cls_uri = RON[cls_name]
            count = len(list(self.g.triples((None, RDF.type, cls_uri))))
            if count > 0:
                class_counts[cls_name] = count

        # Count segments per company
        segment_details = {}
        for s, _, _ in self.g.triples((None, RDF.type, RON.BusinessSegment)):
            for _, _, stock in self.g.triples((s, RON.segmentOf, None)):
                stock_name = str(stock).split("/")[-1]
                segment_details.setdefault(stock_name, [])
                for _, _, label in self.g.triples((s, RDFS.label, None)):
                    segment_details[stock_name].append(str(label))

        return {
            "total_triples": total,
            "class_counts": class_counts,
            "segment_details": segment_details,
        }

    @staticmethod
    def _slugify(text):
        slug = text.strip().lower()
        slug = re.sub(r"[^\w가-힣]+", "_", slug)
        slug = re.sub(r"_+", "_", slug).strip("_")
        return slug

    def sector_insights(self, insight_text, insight_tags=None, top_n=5):
        """Analyze insight and find related sectors/companies/technologies.
        
        Args:
            insight_text: The insight text to analyze
            insight_tags: Optional list of tags (e.g., ['AI', 'knowledge'])
            top_n: Number of top matches to return
            
        Returns:
            dict with correlated sectors, companies, and cross-sector bridges
        """
        import re
        from collections import Counter
        
        # 1. Extract keywords from insight
        text_lower = insight_text.lower()
        keywords = set()
        
        # Known sector/tech keywords in ontology
        keyword_map = {
            "ai": ["ai", "인공지능", "machine learning", "llm", "gpt"],
            "knowledge": ["knowledge", "지식", "ontology", "온톨로지"],
            "agent": ["agent", "에이전트", "orchestration", "오케스트레이션"],
            "semiconductor": ["반도체", "semiconductor", "chip", "dram", "hbm", "memory"],
            "display": ["디스플레이", "display", "oled", "panel", "패널"],
            "automotive": ["자동차", "automotive", "ev", "전기차", "전장"],
            "biotech": ["바이오", "biotech", "bio", "제약"],
            "finance": ["금융", "finance", "증권", "은행", "fintech"],
        }
        
        matched_sectors = []
        for sector, sector_keywords in keyword_map.items():
            for kw in sector_keywords:
                if kw in text_lower:
                    matched_sectors.append(sector)
                    keywords.add(kw)
                    break
        
        # 2. Query graph for related entities
        # Find stocks in matched sectors
        sector_stocks = {}
        stock_scores = Counter()
        
        for sector in set(matched_sectors):
            sector_stocks[sector] = []
            sector_uri = self.sector_uri(sector)
            
            # Query stocks belonging to this sector
            query = f"""
            PREFIX ron: <http://ron.openclaw.local/ontology#>
            SELECT ?stock ?name ?ticker WHERE {{
                ?stock ron:belongsTo <{sector_uri}> ;
                       ron:name ?name .
                OPTIONAL {{ ?stock ron:ticker ?ticker }}
            }}
            LIMIT 20
            """
            try:
                results = self.query_sparql(query)
                for row in results.get("results", {}).get("bindings", []):
                    stock_name = row.get("name", {}).get("value", "")
                    ticker = row.get("ticker", {}).get("value", "")
                    score = len([k for k in sector_keywords if k in text_lower])
                    stock_scores[ticker or stock_name] = score
                    sector_stocks[sector].append({
                        "name": stock_name,
                        "ticker": ticker,
                        "score": score
                    })
            except Exception as e:
                pass  # Silent fail for missing sector data
        
        # 3. Find cross-sector bridges (if multiple sectors matched)
        bridges = []
        if len(set(matched_sectors)) >= 2:
            pairs = [(a, b) for i, a in enumerate(set(matched_sectors)) 
                     for b in list(set(matched_sectors))[i+1:]]
            for s1, s2 in pairs:
                bridges.append({
                    "sectors": [s1, s2],
                    "type": "cross_sector_bridge",
                    "description": f"{s1} + {s2} 간 연관성"
                })
        
        # 4. Build result
        top_stocks = [
            {"name": name, "score": score}
            for name, score in stock_scores.most_common(top_n)
        ]
        
        return {
            "insight_summary": insight_text[:200] + "..." if len(insight_text) > 200 else insight_text,
            "matched_sectors": list(set(matched_sectors)),
            "keywords": list(keywords),
            "top_correlated_stocks": top_stocks,
            "sector_stocks_map": sector_stocks,
            "cross_sector_bridges": bridges,
            "correlation_score": len(matched_sectors) * 2 + len(keywords),
            "actionable": len(matched_sectors) > 0
        }

    # ─── Dry Run ──────────────────────────────────────────
    def dry_run(self, import_etf=None, import_memory=None):
        """Report what would change without writing"""
        report = {"would_add": [], "current_stats": self.stats()}

        if import_etf:
            for path in import_etf:
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    etf_name = data.get("etf", "unknown")
                    holdings_count = len([h for h in data.get("holdings", [])
                                          if h.get("name") != "현금"])
                    report["would_add"].append({
                        "type": "ETF import",
                        "source": path,
                        "etf": etf_name,
                        "holdings": holdings_count,
                    })
                except Exception as e:
                    report["would_add"].append({"type": "ETF import", "error": str(e)})

        if import_memory:
            for path in import_memory:
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        text = f.read()
                    entities = self.extract_entities_from_text(text)
                    report["would_add"].append({
                        "type": "Memory import",
                        "source": path,
                        "entities_found": {k: len(v) for k, v in entities.items()},
                    })
                except Exception as e:
                    report["would_add"].append({"type": "Memory import", "error": str(e)})

        return report


# ─── CLI ──────────────────────────────────────────────────
def main():
    # Ensure running under Python 3.9+ to avoid accidental python2/older-3 invocations
    if sys.version_info < (3, 9):
        print(f"ERROR: ontology_core.py requires Python 3.9+, found {sys.version}", file=sys.stderr)
        return

    parser = argparse.ArgumentParser(description="OpenClaw Ontology Core")
    # Make --action optional with default 'stats' to avoid usage errors when called
    # by cron or supervisors without arguments. This is a safe, non-invasive change.
    parser.add_argument("--action", required=False, default="stats",
                        choices=["stats", "add_entity", "add_segment",
                                 "add_segment_observation", "get_company_segments",
                                 "get_segment_snapshot", "query", "natural_query",
                                 "import_etf", "import_credit", "add_relation",
                                 "remove_entity", "get_related", "extract_entities",
                                 "dry_run", "check_integrity", "export",
                                 "sector_insights"])
    parser.add_argument("--type", help="Entity type (for add_entity)")
    parser.add_argument("--id", help="Entity ID")
    parser.add_argument("--props", help="JSON properties string")
    parser.add_argument("--stock", help="Stock ID (for segments)")
    parser.add_argument("--segment", help="Segment ID")
    parser.add_argument("--date", help="Date (for observations)")
    parser.add_argument("--revenue", type=float, help="Revenue")
    parser.add_argument("--op", type=float, help="Operating profit")
    parser.add_argument("--margin", type=float, help="Margin %%")
    parser.add_argument("--source", help="Data source")
    parser.add_argument("--sparql", help="SPARQL query string")
    parser.add_argument("--question", help="Natural language question")
    parser.add_argument("--path", help="File path for imports")
    parser.add_argument("--n", type=int, default=4, help="Number of results")
    parser.add_argument("--uri", help="Entity URI")
    parser.add_argument("--subject", help="Subject URI (for relations)")
    parser.add_argument("--predicate", help="Predicate (for relations)")
    parser.add_argument("--object", help="Object URI (for relations)")
    parser.add_argument("--text", help="Text for entity extraction or sector_insights")
    parser.add_argument("--tags", help="Tags for sector_insights (comma-separated)")
    parser.add_argument("--depth", type=int, default=2, help="Traversal depth")
    parser.add_argument("--format", default="turtle", help="Export format")
    parser.add_argument("--ttl", help="Custom TTL path")
    parser.add_argument("--import-etf", nargs="*", dest="import_etf_paths",
                        help="ETF JSON paths for dry-run")
    parser.add_argument("--import-memory", nargs="*", dest="import_memory_paths",
                        help="Memory file paths for dry-run")

    args = parser.parse_args()
    core = OntologyCore(ttl_path=args.ttl)
    result = None

    if args.action == "stats":
        result = core.stats()

    elif args.action == "add_entity":
        props = json.loads(args.props) if args.props else {}
        result = core.add_entity(args.type, args.id, props)

    elif args.action == "add_segment":
        props = json.loads(args.props) if args.props else {}
        result = core.add_segment(args.stock, args.segment, props)

    elif args.action == "add_segment_observation":
        result = core.add_segment_observation(
            args.segment, args.date,
            revenue=args.revenue, operating_profit=args.op,
            margin=args.margin, source=args.source)

    elif args.action == "get_company_segments":
        result = core.get_company_segments(args.stock)

    elif args.action == "get_segment_snapshot":
        result = core.get_segment_snapshot(args.segment, latest_n=args.n)

    elif args.action == "query":
        result = core.query_sparql(args.sparql)

    elif args.action == "natural_query":
        result = core.query_natural(args.question)

    elif args.action == "import_etf":
        result = {"imported": [], "errors": []}
        if args.import_etf_paths:
            for path in args.import_etf_paths:
                try:
                    r = core.import_etf_data(path)
                    result["imported"].append({"path": path, "result": r})
                except Exception as e:
                    result["errors"].append({"path": path, "error": str(e)})
        else:
            result["errors"].append({"error": "No --import-etf paths provided"})

    elif args.action == "import_credit":
        result = core.import_credit_data(args.path)

    elif args.action == "add_relation":
        result = core.add_relation(args.subject, args.predicate, args.object)

    elif args.action == "remove_entity":
        result = core.remove_entity(args.uri)

    elif args.action == "get_related":
        result = core.get_related(args.uri, depth=args.depth)

    elif args.action == "extract_entities":
        result = core.extract_entities_from_text(args.text)

    elif args.action == "dry_run":
        result = core.dry_run(
            import_etf=args.import_etf_paths,
            import_memory=args.import_memory_paths)

    elif args.action == "check_integrity":
        # Basic integrity checks: stats + stocks missing ron:belongsTo (sector)
        stats = core.stats()
        missing_sector = []
        for s, _, _ in core.g.triples((None, RDF.type, RON.Stock)):
            has_sector = False
            for _, p, o in core.g.triples((s, None, None)):
                if str(p).endswith("belongsTo"):
                    has_sector = True
                    break
            if not has_sector:
                missing_sector.append(str(s))
        result = {
            "stats": stats,
            "missing_sector_count": len(missing_sector),
            "missing_sector_samples": missing_sector[:20]
        }

    elif args.action == "export":
        print(core.export_graph(fmt=args.format))
        return

    elif args.action == "sector_insights":
        if not args.text:
            result = {"error": "--text required for sector_insights"}
        else:
            tags = args.tags.split(",") if args.tags else None
            result = core.sector_insights(args.text, insight_tags=tags, top_n=args.n)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        # Preserve argparse exits
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"FATAL: ontology_core.py failed: {e}", file=sys.stderr)
        sys.exit(1)

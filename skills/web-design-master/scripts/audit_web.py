#!/usr/bin/env python3
"""Lightweight static audit for HTML/CSS web-design quality gates."""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable


@dataclass
class Finding:
    level: str
    path: Path
    message: str


class PageParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.html_lang = ""
        self.has_viewport = False
        self.title_text = ""
        self._in_title = False
        self.main_count = 0
        self.h1_count = 0
        self.images = 0
        self.images_missing_alt = 0
        self.inputs_without_name = 0
        self.buttons_without_name = 0
        self._button_depth = 0
        self._button_has_text = False
        self._button_has_label = False

    def handle_starttag(self, tag: str, attrs_list: list[tuple[str, str | None]]) -> None:
        attrs = {key.lower(): (value or "") for key, value in attrs_list}
        tag = tag.lower()

        if tag == "html":
            self.html_lang = attrs.get("lang", "").strip()
        elif tag == "meta" and attrs.get("name", "").lower() == "viewport":
            self.has_viewport = bool(attrs.get("content", "").strip())
        elif tag == "title":
            self._in_title = True
        elif tag == "main":
            self.main_count += 1
        elif tag == "h1":
            self.h1_count += 1
        elif tag == "img":
            self.images += 1
            if "alt" not in attrs:
                self.images_missing_alt += 1
        elif tag in {"input", "select", "textarea"}:
            input_type = attrs.get("type", "").lower()
            if input_type != "hidden":
                has_name = any(
                    attrs.get(key, "").strip()
                    for key in ("aria-label", "aria-labelledby", "title", "id", "name")
                )
                if not has_name:
                    self.inputs_without_name += 1
        elif tag == "button":
            self._button_depth += 1
            if self._button_depth == 1:
                self._button_has_text = False
                self._button_has_label = any(
                    attrs.get(key, "").strip()
                    for key in ("aria-label", "aria-labelledby", "title")
                )

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "title":
            self._in_title = False
        elif tag == "button" and self._button_depth:
            if self._button_depth == 1 and not (self._button_has_text or self._button_has_label):
                self.buttons_without_name += 1
            self._button_depth -= 1

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title_text += data
        if self._button_depth and data.strip():
            self._button_has_text = True


def iter_files(paths: Iterable[Path], suffixes: set[str]) -> Iterable[Path]:
    seen: set[Path] = set()
    for path in paths:
        if path.is_file() and path.suffix.lower() in suffixes:
            resolved = path.resolve()
            if resolved not in seen:
                seen.add(resolved)
                yield path
        elif path.is_dir():
            for child in sorted(path.rglob("*")):
                if child.is_file() and child.suffix.lower() in suffixes:
                    resolved = child.resolve()
                    if resolved not in seen:
                        seen.add(resolved)
                        yield child


def audit_html(path: Path) -> list[Finding]:
    findings: list[Finding] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return [Finding("FAIL", path, f"cannot read file: {exc}")]

    parser = PageParser()
    try:
        parser.feed(text)
    except Exception as exc:
        findings.append(Finding("FAIL", path, f"HTML parsing failed: {exc}"))
        return findings

    if not parser.html_lang:
        findings.append(Finding("FAIL", path, "missing <html lang=...>"))
    if not parser.has_viewport:
        findings.append(Finding("FAIL", path, "missing viewport meta tag"))
    if not parser.title_text.strip():
        findings.append(Finding("FAIL", path, "missing non-empty <title>"))
    if parser.main_count != 1:
        findings.append(Finding("WARN", path, f"expected exactly one <main>; found {parser.main_count}"))
    if parser.h1_count != 1:
        findings.append(Finding("WARN", path, f"expected exactly one <h1>; found {parser.h1_count}"))
    if parser.images_missing_alt:
        findings.append(
            Finding("FAIL", path, f"{parser.images_missing_alt}/{parser.images} image(s) missing alt attribute")
        )
    if parser.inputs_without_name:
        findings.append(Finding("WARN", path, f"{parser.inputs_without_name} form control(s) lack an accessible identifier"))
    if parser.buttons_without_name:
        findings.append(Finding("FAIL", path, f"{parser.buttons_without_name} button(s) have no accessible name"))
    if re.search(r'<div[^>]+onclick\s*=', text, re.IGNORECASE):
        findings.append(Finding("WARN", path, "clickable <div> detected; prefer semantic button/link"))
    if re.search(r'<a(?:\s[^>]*)?>\s*</a>', text, re.IGNORECASE):
        findings.append(Finding("WARN", path, "empty link detected"))
    return findings


def audit_css(path: Path) -> list[Finding]:
    findings: list[Finding] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return [Finding("FAIL", path, f"cannot read file: {exc}")]

    compact = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    if ":focus-visible" not in compact:
        findings.append(Finding("WARN", path, "no :focus-visible style detected"))
    if "prefers-reduced-motion" not in compact and re.search(r"\b(animation|transition)\s*:", compact):
        findings.append(Finding("WARN", path, "motion used without prefers-reduced-motion fallback"))
    if "@media" not in compact and len(compact) > 500:
        findings.append(Finding("WARN", path, "no responsive media/container query detected"))
    if re.search(r"outline\s*:\s*(?:none|0)\b", compact, re.IGNORECASE) and ":focus-visible" not in compact:
        findings.append(Finding("FAIL", path, "focus outline removed without visible replacement"))
    if re.search(r"font-size\s*:\s*(?:[0-9]|1[01])px", compact, re.IGNORECASE):
        findings.append(Finding("WARN", path, "very small fixed font size detected"))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path, help="HTML/CSS file or directory")
    parser.add_argument("--strict", action="store_true", help="treat warnings as failures")
    args = parser.parse_args()

    files = list(iter_files(args.paths, {".html", ".htm", ".css"}))
    if not files:
        print("No HTML/CSS files found.", file=sys.stderr)
        return 2

    findings: list[Finding] = []
    for path in files:
        findings.extend(audit_html(path) if path.suffix.lower() in {".html", ".htm"} else audit_css(path))

    if not findings:
        print(f"PASS: audited {len(files)} file(s); no issues found")
        return 0

    order = {"FAIL": 0, "WARN": 1}
    for finding in sorted(findings, key=lambda item: (order[item.level], str(item.path), item.message)):
        print(f"{finding.level}: {finding.path}: {finding.message}")

    failures = sum(item.level == "FAIL" for item in findings)
    warnings = sum(item.level == "WARN" for item in findings)
    print(f"Summary: {failures} failure(s), {warnings} warning(s), {len(files)} file(s)")
    return 1 if failures or (args.strict and warnings) else 0


if __name__ == "__main__":
    raise SystemExit(main())

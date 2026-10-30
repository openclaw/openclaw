#!/usr/bin/env python3
"""Instrument a disposable benchmark source tree before compiling either variant."""
import argparse
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--check", action="store_true", help="Validate anchors without changing source")
args = parser.parse_args()
changes = {}

def edit(path, transform):
    p=Path(path); s=p.read_text(); changes[p] = transform(s)
def replace(s,a,b,count=1):
    assert s.count(a)==count,(a[:100],s.count(a),count)
    return s.replace(a,b)

def task(s):
    s='import { r2Task } from "../../scripts/perf/session-row-churn-probe.js";\n'+s
    return replace(s,'  return observer ? observer.run(name, run, phase) : run();','  return r2Task(name, () => observer ? observer.run(name, run, phase) : run(), phase);')
edit('src/infra/main-thread-stall.ts',task)

def filters(s):
    s='import { r2SearchStart, r2SearchMatch, r2SearchBuild, r2SearchEnd } from "../../scripts/perf/session-row-churn-probe.js";\n'+s
    s=replace(s,'  const { cfg, opts, now, configuredAgentIds } = params;','  const { cfg, opts, now, configuredAgentIds } = params;\n  const r2Search = r2SearchStart(opts.search);')
    s=replace(s,'    ? (key: string, entry: SessionEntry): boolean => {','    ? (key: string, entry: SessionEntry): boolean => {\n        r2SearchMatch();')
    s=replace(s,'        if (!fields) {','        if (!fields) {\n          r2SearchBuild(storeKey, entry);')
    s=replace(s,'  const { people: visiblePeople, overflow } = projectSessionPeopleFacet(people, selectedProfileId);','  r2SearchEnd(r2Search);\n  const { people: visiblePeople, overflow } = projectSessionPeopleFacet(people, selectedProfileId);')
    return s
edit('src/gateway/session-list-filters.ts',filters)

def present(s):
    s='import { r2PresentCalled, r2PresentMiss, r2Presentation } from "../../scripts/perf/session-row-churn-probe.js";\n'+s
    s=replace(s,'  ): GatewaySessionRow | null => {\n    const run = active(record);','  ): GatewaySessionRow | null => {\n    r2PresentCalled();\n    const run = active(record);')
    s=replace(s,'    const row = projection.present(record, {','    r2PresentMiss();\n    const row = projection.present(record, {')
    for value in ['cached.row, cached','snapshot, view','row']:
        s=replace(s,'return projectModels('+value+');','return r2Presentation(projectModels('+value+'));')
    return s
edit('src/gateway/session-row-presentation.ts',present)

def consume(s):
    s='import { r2Consume } from "../../scripts/perf/session-row-churn-probe.js";\n'+s
    return replace(s,'    return consume(read);','    return r2Consume(() => consume(read));')
edit('src/gateway/session-row-prepared-read.ts',consume)

def materialize(s):
    s='import { r2Materialized } from "../../scripts/perf/session-row-churn-probe.js";\n'+s
    anchors = ['    const previousBoard = row.hasBoard;', '    revisions.materialized(row, {']
    assert sum(s.count(anchor) for anchor in anchors) == 1, "expected one materialization installation"
    anchor = next(anchor for anchor in anchors if anchor in s)
    return replace(s, anchor, '    r2Materialized(row, prepared);\n' + anchor)
edit('src/gateway/session-row-projection.ts',materialize)

for path, source in changes.items():
    if not args.check:
        path.write_text(source)
    print(f"{'checked' if args.check else 'instrumented'} {path}")

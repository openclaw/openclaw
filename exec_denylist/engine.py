from future import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

import yaml

SEVERITIES = ("critical", "high", "medium")


@dataclass(frozen=True)
class Rule:
   id: str
   pattern: str
   severity: str
   description: str
 compiled: re.Pattern = field(init=False, repr=False, compare=False)

   def postinit(self):
       if self.severity not in SEVERITIES:
           raise ValueError(f"Invalid severity '{self.severity}' in rule '{self.id}'. Must be one of {SEVERITIES}")
       object.__setattr__(self, "_compiled", re.compile(self.pattern))

   def matches(self, command: str) -> bool:
       return bool(self._compiled.search(command))


@dataclass(frozen=True)
class EvalResult:
   denied: bool
   command: str
   matched_rules: List[Rule] = field(default_factory=list)
   reason: Optional[str] = None
   dry_run: bool = False

   @property
   def max_severity(self) -> Optional[str]:
       if not self.matched_rules:
           return None
       for s in SEVERITIES:
           if any(r.severity == s for r in self.matched_rules):
               return s
       return None


class DenylistEngine:
   def init(self, rules: List[Rule], strict: bool = False):
       self.rules = rules
       self.strict = strict

   @classmethod
   def from_config(cls, path: str | Path, strict: bool = False) -> DenylistEngine:
       path = Path(path)
       with path.open() as f:
           data = yaml.safe_load(f)
       rules = [Rule(**r) for r in data.get("rules", [])]
       return cls(rules, strict=strict)

   def evaluate(
       self, command: str, , dryrun: bool = False, allow_high: bool = False
   ) -> EvalResult:
       matched = [r for r in self.rules if r.matches(command)]
       if not matched:
           return EvalResult(denied=False, command=command)

       denied_rules = []
       for r in matched:
           if r.severity == "critical":
               denied_rules.append(r)
           elif r.severity == "high" and not allow_high:
               denied_rules.append(r)
           elif r.severity == "medium" and self.strict:
               denied_rules.append(r)

       if not denied_rules:
           return EvalResult(denied=False, command=command, matched_rules=matched)

       reasons = "; ".join(f"[{r.severity}] {r.id}: {r.description}" for r in denied_rules)
       return EvalResult(
           denied=not dry_run,
           command=command,
           matched_rules=denied_rules,
           reason=reasons,
           dry_run=dry_run,
       )
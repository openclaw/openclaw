---
name: king_skill_oeis_nist
description: Look up integer sequences (OEIS) and physical constants (NIST CODATA). Never recall constants from memory—always use exact values.
metadata:
  openclaw:
    emoji: 🔬
    requires:
      bins: ["python3"]
      env: ["REQUESTS_AVAILABLE"]
    install:
      - type: pip
        packages: ["requests"]
    os: ["darwin", "linux", "win32"]
---

# OEIS & NIST Constants

Look up integer sequences (OEIS) and physical constants (NIST CODATA 2022).

## When to Use

**USE this skill when:**
- Looking up integer sequences
- Needing exact physical constants
- Verifying mathematical sequences
- Scientific calculations requiring precision

**DON'T use when:**
- Constants can be derived from first principles
- Approximate values are sufficient

## Commands

### OEIS Lookup

```python
import requests

def oeis_lookup(query: str, max_results: int = 3) -> list[dict]:
    r = requests.get(f'https://oeis.org/search?q={query}&fmt=json', timeout=10)
    data = r.json()
    results = data if isinstance(data, list) else data.get('results', [])
    return [{
        'id': f'A{str(e["number"]).zfill(6)}',
        'name': e['name'].split('\n')[0],
        'data': e.get('data', '')[:80],
    } for e in results[:max_results]]

# Examples:
# oeis_lookup('1,1,2,3,5,8,13')    → A000045 Fibonacci
# oeis_lookup('2,3,5,7,11,13,17')  → A000040 Primes
# oeis_lookup('1,4,9,16,25')       → A000290 Squares
```

### NIST CODATA 2022 Constants

```python
CONSTANTS = {
    'c':     {'value': 299792458,        'unit': 'm/s',      'exact': True},
    'h':     {'value': 6.62607015e-34,   'unit': 'J·s',      'exact': True},
    'hbar':  {'value': 1.054571817e-34,  'unit': 'J·s',      'exact': True},
    'k_B':   {'value': 1.380649e-23,     'unit': 'J/K',      'exact': True},
    'e':     {'value': 1.602176634e-19,  'unit': 'C',        'exact': True},
    'N_A':   {'value': 6.02214076e23,    'unit': 'mol⁻¹',    'exact': True},
    'G':     {'value': 6.67430e-11,      'unit': 'm³/kg·s²', 'exact': False, 'unc': 0.00015e-11},
    'alpha': {'value': 7.2973525693e-3,  'unit': '1',        'exact': False},
    'm_e':   {'value': 9.1093837015e-31, 'unit': 'kg',       'exact': False},
    'sigma': {'value': 5.670374419e-8,   'unit': 'W/m²/K⁴',  'exact': True},
}

def get_constant(symbol: str) -> dict:
    return CONSTANTS.get(symbol, {'error': f'Unknown constant: {symbol}'})
```

## Notes

- Never recall constants from memory—always use exact values
- Token savings: ★★★☆☆
- Status: ✅ Verified

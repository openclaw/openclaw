---
name: king_skill_data_pipeline
description: ETL, data cleaning, analysis, and visualization pipelines using pandas/polars. For experiment logs, benchmark results, and peer-review score analysis.
metadata:
  openclaw:
    emoji: 📊
    requires:
      bins: ["python3", "pip"]
    install:
      - type: pip
        packages: ["pandas", "polars", "matplotlib", "seaborn", "scikit-learn", "scipy", "numpy"]
    os: ["darwin", "linux", "win32"]
---

# Data Pipeline

ETL, data cleaning, analysis, and visualization pipelines using pandas/polars.

## When to Use

**USE this skill when:**
- Analyzing experimental data
- Cleaning CSV datasets
- Computing statistics
- Correlation analysis
- Benchmark result analysis
- Data visualization
- Regression analysis

**DON'T use when:**
- Simple text processing suffices
- Data fits in memory without cleaning

## Commands

### Core Patterns

```python
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt

# Load and inspect
df = pd.read_csv("openclaw_results.csv")
print(df.describe())
print(df.dtypes)
print(df.isnull().sum())

# Analyze LLM judge scores
judge_cols = [f"judge_{i}" for i in range(17)]
df["consensus_score"] = df[judge_cols].mean(axis=1)
df["score_std"] = df[judge_cols].std(axis=1)
df["agreement"] = 1 - df["score_std"] / df["score_std"].max()

# Outlier detection
from scipy import stats
z_scores = np.abs(stats.zscore(df["consensus_score"]))
outliers = df[z_scores > 3]

# Correlation matrix
corr = df[judge_cols].corr()

# Export for paper
df.to_csv("cleaned_results.csv", index=False)
df.describe().to_latex("summary_stats.tex")
```

### Polars (Faster for Large Datasets)

```python
import polars as pl

df = pl.read_csv("large_log.csv")
result = (df
    .filter(pl.col("verified") == True)
    .group_by("method")
    .agg([pl.col("score").mean().alias("avg_score"),
          pl.col("score").std().alias("std_score")])
    .sort("avg_score", descending=True))
```

## Notes

- For OpenClaw experiment logs and benchmark results
- Token savings: 4/5
- Status: ✅ Verified

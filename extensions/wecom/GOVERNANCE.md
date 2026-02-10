# Governance

This document clarifies project ownership and collaboration expectations so contributors can work together with fewer ambiguities.

## 1. Upstream ownership
- This repository is the **Upstream / Source of Truth** for the OpenClaw WeCom plugin.
- **Author & Lead Maintainer:** YanHaidao (GitHub: YanHaidao).

## 2. Co-maintenance model
- Tencent Cloud contributors are welcome as **co-maintainers** for code, docs, testing, and cloud deployment adaptation.
- Tencent Cloud may host an official mirror repository for sync and downstream integration needs.

## 3. Decision-making
- We prefer discussion and consensus on non-trivial changes.
- If consensus is not reached in time, the Lead Maintainer makes the final upstream decision for roadmap, architecture, and release direction.

## 4. Contribution workflow
- Non-trivial changes should be proposed via Pull Request.
- Keep change scope clear, include test notes when relevant, and document behavior changes.

## 5. Mirrors and downstream adaptations
- Mirrors may carry downstream patches (for example deployment integration or cloud templates).
- Mirrors/downstream repositories should keep attribution in README or NOTICE:
  - Upstream source: this repository
  - Author: YanHaidao
  - Co-maintained with Tencent Cloud contributors

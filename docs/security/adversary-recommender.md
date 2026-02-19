# Adversary Recommender (ARR): Red Team Engine

OpenClaw's Adversary Recommender (ARR) is an **inverse Red Team engine** that systematically generates attacks to test Blue Team defenses. ARR produces attack candidates optimized to maximize failure probability while minimizing detectability.

## Core Concept

**Blue Team Question**: "Is this input malicious?"
**ARR Question**: "What input would most likely cause the system to fail, given its current defenses?"

ARR is a **generator + optimizer** over attacks, not a classifier.

## Architecture

### Inverse Objective Function

ARR maximizes:
The inverse approach — generating attacks rather than just detecting them — ensures comprehensive coverage and prevents overfitting to known attack patterns. ARR's optimization engine finds novel attack vectors that might otherwise go undetected until exploited by real adversaries.

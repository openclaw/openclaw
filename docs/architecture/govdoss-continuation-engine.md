# GovDOSS Continuation Execution Engine

## Overview

This layer enables safe, deferred execution of previously blocked high-risk actions.

## Architecture

### 1. Gateway Guard
- Evaluates request
- Generates approvalId + continuation

### 2. Approval Store
- Persists decision + metadata

### 3. Runtime Registry (NEW)
- Stores in-memory executors
- Prevents serialization risks

### 4. Resume Engine
- Validates approval state
- Fetches executor
- Executes safely

## Flow

1. Request arrives
2. Guard blocks (approval-required)
3. Executor stored in runtime registry
4. Approval granted
5. Resume called
6. Executor runs

## Security

- Executors are NOT serialized
- Approval IDs are single-use
- Registry entries are consumed after execution

## Future Enhancements

- Distributed executor registry (Redis)
- Multi-node continuation support
- Signed approval tokens
- Time-bound approvals

## Monetization Hooks

- Bill per approval
- Bill per resumed execution
- Tiered risk-based pricing

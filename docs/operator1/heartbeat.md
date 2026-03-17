---
title: Heartbeat
summary: "System monitoring, periodic health checks, and security audit logs in the Control Panel."
---

# Heartbeat

The **Heartbeat** section in the Control Panel provides a real-time health and security overview of your Operator1 instance.

## System Monitoring

Operator1 runs periodic "heartbeat" cycles every 24 hours (configurable in `AGENT.md`). These cycles verify:

- **Workspace Integrity**: Ensuring all required Markdown files exist.
- **Memory Freshness**: Checking if daily notes are being recorded.
- **Task Progress**: Monitoring pending delegations and stagnant runs.

## Audit Logs

The Heartbeat dashboard surfaces security-sensitive events from the `audit_state` and `audit_config` SQLite tables:

- **Command Approvals**: History of `security_exec_approvals`.
- **Config Changes**: Tracking who changed which setting and when.
- **Provider Access**: Monitoring API key usage and provider health.

## Status Reporting

Each agent reports its internal status during a heartbeat. The dashboard highlights:

- **Stale Agents**: Agents that haven't recorded a heartbeat in >48 hours.
- **Resource Pressure**: High token usage or hit-rate anomalies in QMD memory.
- **Schema Mismatches**: Notifications if the gateway needs a `doctor` run or migration.

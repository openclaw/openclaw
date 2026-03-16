import { describe, expect, it } from "vitest";
import { PROBE_EVENT_TYPES } from "../types.js";
import { mapAppLogRecord } from "./log-mapper.js";

function makeLogRecord(input: {
  level: "INFO" | "WARN" | "ERROR" | "FATAL";
  message: string;
  name?: string;
  parents?: string[];
  bindingsJson?: string;
}) {
  return {
    _meta: {
      logLevelName: input.level,
      date: new Date("2026-03-03T00:00:00.000Z"),
      name: input.name,
      parentNames: input.parents,
    },
    ...(input.bindingsJson ? { 0: input.bindingsJson, 1: input.message } : { 0: input.message }),
  };
}

describe("mapAppLogRecord", () => {
  it("maps FATAL with bind/config/listen keywords to ops.subsystem.error", () => {
    const events = mapAppLogRecord(
      makeLogRecord({
        level: "FATAL",
        message: "gateway listen bind failed on 0.0.0.0:18789",
        name: "gateway",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.OPS_SUBSYSTEM_ERROR,
      source: "app_log",
      severity: "critical",
      payload: {
        level: "FATAL",
        subsystem: "gateway",
        hasCoreKeyword: true,
      },
    });
  });

  it("maps websocket unauthorized rejection logs", () => {
    const events = mapAppLogRecord(
      makeLogRecord({
        level: "WARN",
        message: "unauthorized conn=ws-1 remote=1.2.3.4 client=web reason=token_mismatch",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.SECURITY_WS_UNAUTHORIZED,
      severity: "warn",
      payload: {
        connId: "ws-1",
        remoteIp: "1.2.3.4",
        client: "web",
        reason: "token_mismatch",
      },
    });
  });

  it("maps tools-invoke permission denial to HTTP tool failure", () => {
    const events = mapAppLogRecord(
      makeLogRecord({
        level: "ERROR",
        message:
          "tools-invoke: tool execution failed EACCES: permission denied, open '/etc/shadow'",
        bindingsJson: '{"subsystem":"tools-invoke"}',
      }),
    );

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.SECURITY_HTTP_TOOL_INVOKE_FAILED,
      severity: "error",
      payload: {
        subsystem: "tools-invoke",
        permissionDenied: true,
      },
    });
  });

  it("maps malformed/reset network errors", () => {
    const events = mapAppLogRecord(
      makeLogRecord({
        level: "INFO",
        message: "gateway request parse failed: Invalid JSON",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.SECURITY_HTTP_MALFORMED_OR_RESET,
      severity: "info",
      payload: {
        reason: "invalid_json",
      },
    });
  });

  it("maps device role escalation and flags owner promotion as critical", () => {
    const events = mapAppLogRecord(
      makeLogRecord({
        level: "INFO",
        message:
          "security audit: device access upgrade requested reason=pair_upgrade device=dev-1 roleFrom=none roleTo=owner scopesFrom=read scopesTo=all ip=8.8.8.8 auth=token client=web",
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: PROBE_EVENT_TYPES.SECURITY_DEVICE_ROLE_ESCALATION,
      severity: "critical",
      payload: {
        deviceId: "dev-1",
        roleFrom: "none",
        roleTo: "owner",
        remoteIp: "8.8.8.8",
      },
    });
  });
});

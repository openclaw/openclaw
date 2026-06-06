import { describe, expect, it } from "vitest";
import {
  ACOS_APPROVAL_REJECTION_MESSAGE,
  ACOS_CONTROLLED_REJECTION_MESSAGE,
  ACOS_DIAGNOSTIC_REJECTION_MESSAGE,
  assertAcosControlledActionAllowed,
  hasAcosApproval,
  isAcosControlledMode,
  normalizeAcosProvenance,
  readAcosProvenanceFromEnv,
  type AcosProvenance,
} from "./provenance.js";

const CONTROLLED_ENV = {
  ...process.env,
  OPENCLAW_ACOS_CONTROLLED: "1",
  OPENCLAW_DISABLE_AUTONOMOUS_INTAKE: undefined,
  OPENCLAW_ACOS_PROVENANCE: undefined,
  OPENCLAW_ACOS_DIAGNOSTIC_MODE: undefined,
};

const VALID_ACOS_PROVENANCE: AcosProvenance = {
  acos_dispatch: true,
  dispatcher: "acos",
  acos_task_id: "task-123",
  run_id: "run-123",
  queue_id: "queue-123",
  dispatched_at: "2026-06-06T00:00:00.000Z",
};

const APPROVED_ACOS_PROVENANCE: AcosProvenance = {
  ...VALID_ACOS_PROVENANCE,
  approval_granted: true,
  approval_scope: ["shell_exec", "apply_patch"],
};

describe("ACOS provenance enforcement", () => {
  it("detects ACOS controlled mode from local env flags", () => {
    expect(isAcosControlledMode({ OPENCLAW_ACOS_CONTROLLED: "1" })).toBe(true);
    expect(isAcosControlledMode({ OPENCLAW_ACOS_CONTROLLED: "true" })).toBe(true);
    expect(isAcosControlledMode({ OPENCLAW_DISABLE_AUTONOMOUS_INTAKE: "yes" })).toBe(true);
    expect(isAcosControlledMode({ OPENCLAW_ACOS_CONTROLLED: "0" })).toBe(false);
  });

  it("normalizes ACOS provenance from direct, metadata, and carrier payloads", () => {
    expect(normalizeAcosProvenance(VALID_ACOS_PROVENANCE)).toMatchObject(VALID_ACOS_PROVENANCE);
    expect(normalizeAcosProvenance({ metadata: VALID_ACOS_PROVENANCE })).toMatchObject(
      VALID_ACOS_PROVENANCE,
    );
    expect(normalizeAcosProvenance({ acosProvenance: VALID_ACOS_PROVENANCE })).toMatchObject(
      VALID_ACOS_PROVENANCE,
    );
    expect(normalizeAcosProvenance({ ...VALID_ACOS_PROVENANCE, acos_task_id: "" })).toBeUndefined();
    expect(
      normalizeAcosProvenance({ ...VALID_ACOS_PROVENANCE, dispatcher: "openclaw" }),
    ).toBeUndefined();
  });

  it("reads ACOS provenance from JSON environment metadata", () => {
    expect(
      readAcosProvenanceFromEnv({
        OPENCLAW_ACOS_PROVENANCE: JSON.stringify(VALID_ACOS_PROVENANCE),
      }),
    ).toMatchObject(VALID_ACOS_PROVENANCE);
    expect(readAcosProvenanceFromEnv({ OPENCLAW_ACOS_PROVENANCE: "not-json" })).toBeUndefined();
  });

  it("rejects local agent execution without ACOS provenance in controlled mode", () => {
    expect(() =>
      assertAcosControlledActionAllowed({
        action: "agent_turn",
        env: CONTROLLED_ENV,
        mutating: true,
      }),
    ).toThrow(ACOS_CONTROLLED_REJECTION_MESSAGE);
  });

  it("rejects Gateway agent execution without ACOS provenance in controlled mode", () => {
    expect(() =>
      assertAcosControlledActionAllowed({
        action: "gateway_agent_turn",
        env: CONTROLLED_ENV,
        mutating: true,
      }),
    ).toThrow(ACOS_CONTROLLED_REJECTION_MESSAGE);
  });

  it("rejects cron-created agent turns without ACOS provenance in controlled mode", () => {
    expect(() =>
      assertAcosControlledActionAllowed({
        action: "cron_agent_turn",
        env: CONTROLLED_ENV,
        mutating: true,
      }),
    ).toThrow(ACOS_CONTROLLED_REJECTION_MESSAGE);
  });

  it("allows valid ACOS provenance for controlled agent execution", () => {
    expect(() =>
      assertAcosControlledActionAllowed({
        action: "agent_turn",
        env: CONTROLLED_ENV,
        mutating: true,
        provenance: VALID_ACOS_PROVENANCE,
      }),
    ).not.toThrow();
  });

  it("allows diagnostic mode only for non-mutating checks", () => {
    expect(() =>
      assertAcosControlledActionAllowed({
        action: "agent_turn",
        env: CONTROLLED_ENV,
        diagnosticMode: true,
        mutating: false,
      }),
    ).not.toThrow();

    expect(() =>
      assertAcosControlledActionAllowed({
        action: "agent_turn",
        env: CONTROLLED_ENV,
        diagnosticMode: true,
        mutating: true,
        provenance: VALID_ACOS_PROVENANCE,
      }),
    ).toThrow(ACOS_DIAGNOSTIC_REJECTION_MESSAGE);
  });

  it("requires approval metadata for dangerous action classes", () => {
    expect(() =>
      assertAcosControlledActionAllowed({
        action: "shell_exec",
        env: CONTROLLED_ENV,
        mutating: true,
        requiresApproval: true,
        provenance: VALID_ACOS_PROVENANCE,
      }),
    ).toThrow(ACOS_APPROVAL_REJECTION_MESSAGE);
    expect(() =>
      assertAcosControlledActionAllowed({
        action: "apply_patch",
        env: CONTROLLED_ENV,
        mutating: true,
        requiresApproval: true,
        provenance: VALID_ACOS_PROVENANCE,
      }),
    ).toThrow(ACOS_APPROVAL_REJECTION_MESSAGE);
  });

  it("accepts approval metadata for dangerous tool classes", () => {
    expect(hasAcosApproval(APPROVED_ACOS_PROVENANCE, "shell_exec")).toBe(true);
    expect(hasAcosApproval(APPROVED_ACOS_PROVENANCE, "apply_patch")).toBe(true);
    expect(() =>
      assertAcosControlledActionAllowed({
        action: "shell_exec",
        env: CONTROLLED_ENV,
        mutating: true,
        requiresApproval: true,
        provenance: APPROVED_ACOS_PROVENANCE,
      }),
    ).not.toThrow();
  });

  it("preserves normal OpenClaw behavior when controlled mode is disabled", () => {
    expect(() =>
      assertAcosControlledActionAllowed({
        action: "agent_turn",
        env: { ...process.env, OPENCLAW_ACOS_CONTROLLED: undefined },
        mutating: true,
      }),
    ).not.toThrow();
  });
});

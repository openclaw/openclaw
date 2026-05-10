import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildTelegramRuntimeProofBase,
  createTelegramRuntimeProofEvent,
  emitTelegramRuntimeProofEvent,
  extractTelegramRuntimeProofRunIdFromText,
  hashTelegramRuntimeProofId,
  resolveTelegramRuntimeProofJsonlPath,
  resolveTelegramRuntimeProofRunId,
  TELEGRAM_RUNTIME_PROOF_EVENT,
  TELEGRAM_RUNTIME_PROOF_KINDS,
} from "./runtime-proof.js";

describe("telegram runtime proof helpers", () => {
  it("extracts explicit run markers without accepting arbitrary text", () => {
    expect(
      extractTelegramRuntimeProofRunIdFromText(
        "Manual Telegram E2E window for run_id=run_ABC-123: hello",
      ),
    ).toBe("run_ABC-123");
    expect(
      extractTelegramRuntimeProofRunIdFromText("please mention run but no marker"),
    ).toBeUndefined();
    expect(extractTelegramRuntimeProofRunIdFromText("run_id=abc")).toBeUndefined();
    expect(extractTelegramRuntimeProofRunIdFromText("run_id=abc/123")).toBeUndefined();
  });

  it("prefers safe env run id, then prompt marker, then e2e config slug", () => {
    expect(
      resolveTelegramRuntimeProofRunId({
        env: { STOMME_E2E_RUN_ID: "env_RUN-123" } as NodeJS.ProcessEnv,
        textCandidates: ["run_id=text_RUN-123"],
        cfg: { configSlug: "e2e-config-run" },
      }),
    ).toBe("env_RUN-123");
    expect(
      resolveTelegramRuntimeProofRunId({
        env: { STOMME_E2E_RUN_ID: "bad value" } as NodeJS.ProcessEnv,
        textCandidates: ["run_id=text_RUN-123"],
        cfg: { configSlug: "e2e-config-run" },
      }),
    ).toBe("text_RUN-123");
    expect(
      resolveTelegramRuntimeProofRunId({
        env: {} as NodeJS.ProcessEnv,
        textCandidates: ["hello"],
        cfg: { meta: { configSlug: "e2e-config-run" } },
      }),
    ).toBe("config-run");
  });

  it("hashes correlation identifiers and omits raw ids", () => {
    const hash = hashTelegramRuntimeProofId("telegram:123456789");

    expect(hash).toMatch(/^[a-f0-9]{12}$/u);
    expect(hash).not.toContain("123456789");
    expect(hashTelegramRuntimeProofId("telegram:123456789")).toBe(hash);
  });

  it("emits one parseable marked JSON line without prompt or secret fields", () => {
    const raw = vi.fn();
    const base = buildTelegramRuntimeProofBase({
      accountId: "default",
      sessionKey: "telegram:secret-chat-id",
      messageId: 456,
      env: { STOMME_E2E_RUN_ID: "RUN-1234" } as NodeJS.ProcessEnv,
      textCandidates: ["run_id=RUN-1234 raw prompt should not leak"],
    });

    emitTelegramRuntimeProofEvent({
      logger: { raw },
      base,
      kind: TELEGRAM_RUNTIME_PROOF_KINDS.assistantResponseObserved,
    });

    expect(raw).toHaveBeenCalledTimes(1);
    const line = String(raw.mock.calls[0]?.[0]);
    expect(line).toContain(`${TELEGRAM_RUNTIME_PROOF_EVENT} `);
    expect(line).not.toContain("raw prompt should not leak");
    expect(line).not.toContain("secret-chat-id");
    expect(line).not.toContain("token");
    const payload = JSON.parse(line.replace(`${TELEGRAM_RUNTIME_PROOF_EVENT} `, ""));
    expect(payload).toMatchObject({
      event: TELEGRAM_RUNTIME_PROOF_KINDS.assistantResponseObserved,
      type: TELEGRAM_RUNTIME_PROOF_KINDS.assistantResponseObserved,
      kind: TELEGRAM_RUNTIME_PROOF_KINDS.assistantResponseObserved,
      proofEvent: TELEGRAM_RUNTIME_PROOF_EVENT,
      status: "observed",
      channel: "telegram",
      runId: "RUN-1234",
      accountId: "default",
    });
    expect(payload.sessionKeyHash).toMatch(/^[a-f0-9]{12}$/u);
    expect(payload.messageIdHash).toMatch(/^[a-f0-9]{12}$/u);
  });

  it("also writes a dedicated config-scoped JSONL proof file", () => {
    const root = mkdtempSync(join(tmpdir(), "telegram-runtime-proof-"));
    try {
      const raw = vi.fn();
      emitTelegramRuntimeProofEvent({
        logger: { raw },
        base: { runId: "RUN-1234", accountId: "default" },
        kind: TELEGRAM_RUNTIME_PROOF_KINDS.inboundAccepted,
        env: { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv,
      });

      const proofPath = resolveTelegramRuntimeProofJsonlPath({
        OPENCLAW_STATE_DIR: root,
      } as NodeJS.ProcessEnv);
      expect(proofPath).toBe(join(root, "logs", "telegram-runtime-proof.jsonl"));
      const lines = readFileSync(proofPath!, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({
        event: "inbound_accepted",
        kind: "inbound_accepted",
        proofEvent: TELEGRAM_RUNTIME_PROOF_EVENT,
        runId: "RUN-1234",
        accountId: "default",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not emit without a bound run id", () => {
    const raw = vi.fn();
    emitTelegramRuntimeProofEvent({
      logger: { raw },
      base: {},
      kind: TELEGRAM_RUNTIME_PROOF_KINDS.inboundAccepted,
    });
    expect(raw).not.toHaveBeenCalled();
  });

  it("creates harness-compatible event and type aliases", () => {
    const event = createTelegramRuntimeProofEvent(
      TELEGRAM_RUNTIME_PROOF_KINDS.telegramDeliveryObserved,
      {
        runId: "RUN-1234",
      },
    );
    expect(event.event).toBe("telegram_delivery_observed");
    expect(event.kind).toBe("telegram_delivery_observed");
    expect(event.type).toBe("telegram_delivery_observed");
    expect(event.proofEvent).toBe(TELEGRAM_RUNTIME_PROOF_EVENT);
  });
});

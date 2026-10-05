import path from "node:path";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import * as configSessions from "../../config/sessions.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import {
  createAssistantToolCallMessage,
  type SessionEntryFixture,
} from "../subagent-test-fixtures.test-helpers.js";
import { makeAssistantTextMessage } from "./main-session-restart-recovery-transcript.test-support.js";

export function registerUnresolvedEffectRecoveryCases(input: {
  writePreparedMainSessionTranscript: (
    messages: readonly unknown[],
    entry?: SessionEntryFixture,
  ) => Promise<string>;
  expectRecovery: (
    expected: { started: number; settled: number; failed: number; skipped: number },
    cfg?: OpenClawConfig,
  ) => Promise<void>;
  loadTestTranscript: (
    sessionKey: string,
    storePath: string,
  ) => Promise<Array<{ message?: Record<string, unknown> }>>;
}) {
  const { writePreparedMainSessionTranscript, expectRecovery, loadTestTranscript } = input;
  it.each([
    { label: "inherited full access", mode: "full", permissionMode: undefined },
    { label: "explicit guarded access", mode: "full", permissionMode: "guarded" },
  ] as const)(
    "pauses the whole session with $label and an unresolved effect",
    async ({ mode, permissionMode }) => {
      const sessionsDir = await writePreparedMainSessionTranscript(
        [
          { role: "user", content: "send the update" },
          createAssistantToolCallMessage([
            { type: "toolCall", id: "send-1", name: "message", arguments: {} },
          ]),
          ...Array.from({ length: 25 }, (_, index) =>
            makeAssistantTextMessage(`progress ${index}`, { phase: "commentary" }),
          ),
        ],
        { permissionMode },
      );
      const scope = {
        storePath: path.join(sessionsDir, "sessions.json"),
        sessionKey: "agent:main:main",
      };
      await expectRecovery(
        { started: 0, settled: 0, failed: 0, skipped: 1 },
        { tools: { exec: { mode } } },
      );
      expect(callGateway).not.toHaveBeenCalled();
      const paused = loadSessionEntry(scope);
      expect(paused).toMatchObject({
        sessionId: "main-session",
        mainRestartRecovery: {
          chargedAttempts: 0,
          pause: { reason: "unverifiable-external-effect", toolCallId: "send-1" },
        },
      });
      expect(configSessions.resolveSessionWorkStartError(scope.sessionKey, paused)).toContain(
        "paused",
      );
      await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
      expect(callGateway).not.toHaveBeenCalled();
      const transcript = await loadTestTranscript(scope.sessionKey, scope.storePath);
      expect(transcript.at(-1)?.message?.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: expect.stringContaining("paused this whole session") }),
        ]),
      );
    },
  );
}

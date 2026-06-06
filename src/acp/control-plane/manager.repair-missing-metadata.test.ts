// ACP missing-metadata repair helpers decide when store rows can be re-initialized.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  hasPersistedAcpSessionMetadata,
  shouldRepairMissingAcpSessionMetadata,
} from "./manager.repair-missing-metadata.js";

describe("shouldRepairMissingAcpSessionMetadata", () => {
  it("returns persistent mode for hub-delegated store rows missing sqlite metadata", async () => {
    await withTempDir({ prefix: "openclaw-acp-repair-" }, async (home) => {
      process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
      const storePath = path.join(home, "agents/claude/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:claude:acp:54143f55-ea57-46be-9444-663f086780f1";
      const entry: SessionEntry = {
        sessionId: "child-session-id",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
        parentSessionKey: "agent:main:main",
        hubDelegated: {
          ownerSessionKey: "agent:main:main",
          createdAt: Date.now(),
        },
      };
      fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: entry }));

      expect(
        shouldRepairMissingAcpSessionMetadata({
          cfg: { session: { store: storePath } },
          sessionKey: "agent:main:main",
        }),
      ).toBeNull();

      expect(
        shouldRepairMissingAcpSessionMetadata({
          cfg: { session: { store: storePath } },
          sessionKey,
        }),
      ).toEqual({
        sessionKey,
        agent: "claude",
        mode: "persistent",
        backendId: undefined,
      });
      expect(
        hasPersistedAcpSessionMetadata({
          cfg: { session: { store: storePath } },
          sessionKey,
        }),
      ).toBe(false);
    });
  });

  it("returns oneshot mode for spawned one-shot ACP rows missing sqlite metadata", async () => {
    await withTempDir({ prefix: "openclaw-acp-repair-" }, async (home) => {
      process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:codex:acp:54143f55-ea57-46be-9444-663f086780f1";
      const entry: SessionEntry = {
        sessionId: "child-session-id",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
        parentSessionKey: "agent:main:main",
      };
      fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: entry }));

      expect(
        shouldRepairMissingAcpSessionMetadata({
          cfg: { session: { store: storePath } },
          sessionKey,
        }),
      ).toEqual({
        sessionKey,
        agent: "codex",
        mode: "oneshot",
        backendId: undefined,
      });
    });
  });

  it("returns persistent mode for thread-bound ACP binding keys missing sqlite metadata", async () => {
    await withTempDir({ prefix: "openclaw-acp-repair-" }, async (home) => {
      process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:codex:acp:binding:discord:default:feedface";
      const entry: SessionEntry = {
        sessionId: "child-session-id",
        updatedAt: Date.now(),
        spawnedBy: "agent:main:main",
        parentSessionKey: "agent:main:main",
      };
      fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: entry }));

      expect(
        shouldRepairMissingAcpSessionMetadata({
          cfg: { session: { store: storePath } },
          sessionKey,
        }),
      ).toEqual({
        sessionKey,
        agent: "codex",
        mode: "persistent",
        backendId: undefined,
      });
    });
  });

  it("does not repair ACP rows without explicit lifecycle evidence", async () => {
    await withTempDir({ prefix: "openclaw-acp-repair-" }, async (home) => {
      process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
      const storePath = path.join(home, "agents/codex/sessions/sessions.json");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      const sessionKey = "agent:codex:acp:54143f55-ea57-46be-9444-663f086780f1";
      const entry: SessionEntry = {
        sessionId: "child-session-id",
        updatedAt: Date.now(),
      };
      fs.writeFileSync(storePath, JSON.stringify({ [sessionKey]: entry }));

      expect(
        shouldRepairMissingAcpSessionMetadata({
          cfg: { session: { store: storePath } },
          sessionKey,
        }),
      ).toBeNull();
    });
  });
});

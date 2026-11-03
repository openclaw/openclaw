import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import * as sessionStore from "openclaw/plugin-sdk/session-store-runtime";
import * as transcript from "openclaw/plugin-sdk/session-transcript-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import {
  createSessionShareNodeCommands,
  SESSION_SHARE_LIST_COMMAND,
  SESSION_SHARE_READ_COMMAND,
} from "./node-commands.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "checks sharing after an in-process write before disclosing the transcript (revoked=%s)",
  async (revoked) => {
    await withOpenClawTestState(
      { label: "session-share-node-read", scenario: "minimal" },
      async () => {
        const agentId = "main";
        const sessionKey = "agent:main:shared";
        const storePath = sessionStore.resolveStorePath(undefined, { agentId });
        const scope = { agentId, sessionKey, storePath };
        const title = revoked ? "München" : "Mu\u0308nchen";
        await sessionStore.upsertSessionEntry({
          ...scope,
          entry: { sessionId: "shared-session", updatedAt: 1, category: "team", label: title },
        });
        const config: OpenClawConfig = {
          session: { store: storePath },
          plugins: { entries: { "session-share": { config: { share: { groups: ["team"] } } } } },
        };
        setRuntimeConfigSnapshot(config);
        const runtime = createPluginRuntimeMock({
          config: { current: () => config },
          agent: {
            session: {
              ...sessionStore,
              createSessionEntryListReader: async (params) => async () => ({
                entries: await sessionStore.listSessionEntriesAsync(params),
                // This fixture keeps the physical database fixed; row updates remain real.
                assertCurrent() {},
              }),
            },
          },
        });
        const commands = createSessionShareNodeCommands(createTestPluginApi({ runtime }));
        const list = commands.find((entry) => entry.command === SESSION_SHARE_LIST_COMMAND)!;
        const query = title.normalize(revoked ? "NFD" : "NFC");
        expect(
          JSON.parse(await list.handle(JSON.stringify({ searchTerm: query }))).sessions,
        ).toMatchObject([{ name: title }]);
        const originalRead = transcript.readSessionTranscriptCatalogPage;
        vi.spyOn(transcript, "readSessionTranscriptCatalogPage").mockImplementation(
          async (...args) => {
            const page = await originalRead(...args);
            await sessionStore.applySessionEntryPatch({
              ...scope,
              patch: { category: revoked ? "private" : "team", label: "updated while reading" },
            });
            return page;
          },
        );
        const command = commands.find((entry) => entry.command === SESSION_SHARE_READ_COMMAND)!;
        const result = command.handle(JSON.stringify({ threadId: sessionKey, limit: 10 }));
        if (revoked) {
          await expect(result).rejects.toThrow("Session is no longer shared");
        } else {
          expect(JSON.parse(await result)).toEqual({ threadId: sessionKey, items: [] });
        }
      },
    );
  },
);

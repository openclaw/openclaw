import * as terminalText from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  canReuseCodexCatalogPreview,
  projectCodexCatalogDeltaPage,
  projectCodexCatalogPage,
} from "./session-catalog-projection.js";

beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each([
  ["", "First user request"],
  ["Previous first user request", ""],
])(
  "observes native preview transition %j to %j within one timestamp second",
  async (before, after) => {
    const thread: CodexThread = {
      id: "preview-transition",
      projectId: null,
      name: null,
      source: "cli",
      originator: "codex_cli_rs",
      cwd: "/workspace/project",
      path: null,
      updatedAt: 100,
      recencyAt: 100,
      preview: before,
    };
    const requests: CodexThreadListParams[] = [];
    const harness = createClientHarness({
      onWrite(line, send) {
        const request = JSON.parse(line);
        expect(request.method).toBe("thread/list");
        requests.push(request.params);
        send({ id: request.id, result: { data: [thread] } });
      },
    });
    const index = new CodexCatalogIndex({
      homeId: "preview-transitions",
      assertCurrent: () => {},
      readNative: async (params) => {
        const response = await harness.client.request("thread/list", params, {
          catalogPreview: true,
          catalogPreviewCache: params.useStateDbOnly
            ? (candidate) => {
                const row = index.get(candidate.id);
                return canReuseCodexCatalogPreview(row, candidate) ? row?.preview : undefined;
              }
            : undefined,
        });
        return params.useStateDbOnly
          ? projectCodexCatalogDeltaPage(response, {
              sanitize: terminalText.sanitizeTerminalText,
              getRow: (id) => index.get(id),
            })
          : projectCodexCatalogPage(response, { sanitize: terminalText.sanitizeTerminalText });
      },
    });
    try {
      await index.initialize();
      expect((await index.list({})).sessions[0]?.fallbackName).toBe(before || undefined);
      thread.preview = after;
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await vi.waitFor(async () => {
        expect((await index.list({})).sessions[0]?.fallbackName).toBe(after || undefined);
      });
      expect(index.get(thread.id)?.preview).toBe(after);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toMatchObject({ useStateDbOnly: true });
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      const sanitize = vi.spyOn(terminalText, "sanitizeTerminalText");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(requests).toHaveLength(2);
      await index.list({});
      await vi.waitFor(() => expect(requests).toHaveLength(3));
      expect((await index.list({})).sessions[0]?.fallbackName).toBe(after || undefined);
      expect(sanitize).not.toHaveBeenCalled();
    } finally {
      harness.client.close();
      await index.close();
    }
  },
);

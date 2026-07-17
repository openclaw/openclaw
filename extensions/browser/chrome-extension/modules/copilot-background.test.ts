import { describe, expect, it, vi } from "vitest";
import {
  archiveCopilotSession,
  createCopilotController,
  resolveSidePanelTabId,
} from "./copilot-background.js";

function eventHook() {
  return { addListener: vi.fn() };
}

function storageArea() {
  return { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) };
}

describe("browser copilot background", () => {
  it("accepts only capability-bound live side-panel contexts", async () => {
    const chromeApi = {
      runtime: {
        id: "extension-id",
        getContexts: vi.fn(async () => [
          {
            contextType: "SIDE_PANEL",
            documentId: "doc-a",
            documentUrl: "chrome-extension://extension-id/sidepanel.html?binding=cap-a",
            tabId: -1,
          },
        ]),
      },
    };
    const panelBindings = { resolve: vi.fn(async (token) => (token === "cap-a" ? 12 : null)) };
    await expect(
      resolveSidePanelTabId(
        chromeApi as never,
        {
          sender: {
            documentId: "doc-a",
            url: "chrome-extension://extension-id/sidepanel.html?binding=cap-a",
          },
        } as never,
        panelBindings as never,
      ),
    ).resolves.toBe(12);
    await expect(
      resolveSidePanelTabId(
        chromeApi as never,
        {
          sender: {
            url: "chrome-extension://extension-id/sidepanel.html?binding=forged",
          },
        } as never,
        panelBindings as never,
      ),
    ).rejects.toThrow("live tab binding");
  });

  it("prepares a unique tab-specific panel path without a global option", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("44444444-4444-4444-8444-444444444444");
    const gateway = {
      onEvent: vi.fn(),
      onStatus: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const chromeApi = {
      runtime: { onConnect: eventHook() },
      tabs: { get: vi.fn(async () => ({ id: 44 })) },
      storage: { local: storageArea(), session: storageArea() },
    };
    const controller = createCopilotController({
      chromeApi: chromeApi as never,
      getConfig: vi.fn(),
      isTabShared: vi.fn(),
      addTabToOpenClawGroup: vi.fn(),
      attachDebugger: vi.fn(),
      scheduleTabsSync: vi.fn(),
      gateway: gateway as never,
    });

    await expect(controller.preparePanel(44)).resolves.toEqual({
      path: "sidepanel.html?binding=44444444-4444-4444-8444-444444444444",
    });
  });

  it("stops delivery and archives after aborting active work", async () => {
    const request = vi.fn(async () => ({ ok: true }));
    await archiveCopilotSession(
      { request } as never,
      { sessionKey: "session-7", sessionId: "id-7" } as never,
    );
    expect(request.mock.calls).toEqual([
      ["sessions.messages.unsubscribe", { key: "session-7" }],
      ["sessions.abort", { key: "session-7" }],
      ["sessions.patch", { key: "session-7", archived: true }],
    ]);
  });

  it("still attempts the authoritative archive when unsubscribe and abort fail", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket allowlist already gone"))
      .mockRejectedValueOnce(new Error("no active run"))
      .mockResolvedValueOnce({ ok: true });
    await expect(
      archiveCopilotSession(
        { request } as never,
        { sessionKey: "session-8", sessionId: "id-8" } as never,
      ),
    ).resolves.toBeUndefined();
    expect(request).toHaveBeenLastCalledWith("sessions.patch", {
      key: "session-8",
      archived: true,
    });
  });
});

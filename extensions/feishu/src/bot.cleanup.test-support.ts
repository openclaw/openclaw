import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, vi } from "vitest";

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
});

afterAll(() => {
  vi.doUnmock("./reply-dispatcher.js");
  vi.doUnmock("./reasoning-preview.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./media.js");
  vi.doUnmock("openclaw/plugin-sdk/media-runtime");
  vi.doUnmock("./client.js");
  vi.doUnmock("./bot-name.js");
  vi.doUnmock("openclaw/plugin-sdk/conversation-runtime");
  vi.resetModules();
});

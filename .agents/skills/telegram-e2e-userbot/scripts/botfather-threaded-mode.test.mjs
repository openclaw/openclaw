import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setBotFatherThreadedMode } from "./botfather-threaded-mode.mjs";

function fixture(context, { initial = false, acceptsChange = true, closeFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "botfather-mode-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const urlFile = path.join(root, "url");
  const url = "https://example.invalid/?tgWebAppData=synthetic-private-session";
  fs.writeFileSync(urlFile, url, { mode: 0o600 });
  const state = { enabled: initial, closed: false, launched: false, toggles: 0 };
  const page = {
    goto: async (value) => assert.equal(value, url),
    async waitForLoadState() {},
    getByText(text) {
      if (text instanceof RegExp) {
        assert.match("@leased_bot", text);
        assert.equal(text.test("@leased_bot_extra"), false);
      }
      if (text === "Disallow users to create new threads") {
        return {
          first() {
            return this;
          },
          isVisible: async () => state.enabled,
          async waitFor({ state: visibility }) {
            if ((visibility === "visible") !== state.enabled) {
              throw new Error(`request failed: ${url}`);
            }
          },
        };
      }
      return {
        first() {
          return this;
        },
        async waitFor() {},
        async click() {
          if (text === "Threaded Mode") {
            state.toggles += 1;
            if (acceptsChange) {
              state.enabled = !state.enabled;
            }
          }
        },
      };
    },
  };
  return {
    urlFile,
    username: "leased_bot",
    url,
    state,
    chromium: {
      async launch() {
        state.launched = true;
        return {
          newPage: async () => page,
          async close() {
            state.closed = true;
            if (closeFails) {
              throw new Error(`browser close failed: ${url}`);
            }
          },
        };
      },
    },
  };
}

for (const [initial, desired] of [
  [false, true],
  [true, false],
  [true, true],
]) {
  test(`confirms Threaded Mode ${initial} -> ${desired} and closes its browser`, async (context) => {
    const f = fixture(context, { initial });
    assert.deepEqual(await setBotFatherThreadedMode({ ...f, enabled: desired }), {
      before: initial,
      after: desired,
    });
    assert.equal(f.state.closed, true);
    assert.equal(f.state.toggles, initial === desired ? 0 : 1);
  });
}

for (const [flag, message] of Object.entries({
  acceptsChange: "BotFather Threaded Mode could not be confirmed.",
  closeFails: "BotFather browser cleanup failed.",
})) {
  test(`${flag} failure does not leak the signed URL`, async (context) => {
    const f = fixture(context, { [flag]: flag === "closeFails" });
    await assert.rejects(setBotFatherThreadedMode({ ...f, enabled: true }), (error) => {
      assert.equal(error.message, message);
      assert.equal(error.stack.includes(f.url), false);
      return true;
    });
    assert.equal(f.state.closed, true);
  });
}

test("a world-readable URL file is rejected before opening a browser", async (context) => {
  const f = fixture(context);
  fs.chmodSync(f.urlFile, 0o644);
  await assert.rejects(setBotFatherThreadedMode({ ...f, enabled: true }));
  assert.equal(f.state.launched, false);
});

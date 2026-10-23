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
  let enabled = initial;
  let closed = false;
  let launched = false;
  let toggles = 0;
  const page = {
    async goto(value) {
      assert.equal(value, url);
    },
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
          async isVisible() {
            return enabled;
          },
          async waitFor({ state }) {
            if ((state === "visible") !== enabled) {
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
            toggles += 1;
            if (acceptsChange) {
              enabled = !enabled;
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
    chromium: {
      async launch() {
        launched = true;
        return {
          async newPage() {
            return page;
          },
          async close() {
            closed = true;
            if (closeFails) {
              throw new Error(`browser close failed: ${url}`);
            }
          },
        };
      },
    },
    closed: () => closed,
    launched: () => launched,
    toggles: () => toggles,
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
    assert.equal(f.closed(), true);
    assert.equal(f.toggles(), initial === desired ? 0 : 1);
  });
}

test("an unconfirmed switch fails without leaking the signed URL", async (context) => {
  const f = fixture(context, { acceptsChange: false });
  await assert.rejects(setBotFatherThreadedMode({ ...f, enabled: true }), (error) => {
    assert.equal(error.message, "BotFather Threaded Mode could not be confirmed.");
    assert.equal(error.stack.includes(f.url), false);
    return true;
  });
  assert.equal(f.closed(), true);
});

test("a failed browser close cannot report success or expose its URL", async (context) => {
  const f = fixture(context, { closeFails: true });
  await assert.rejects(setBotFatherThreadedMode({ ...f, enabled: true }), (error) => {
    assert.equal(error.message, "BotFather browser cleanup failed.");
    assert.equal(error.stack.includes(f.url), false);
    return true;
  });
});

test("a world-readable URL file is rejected before opening a browser", async (context) => {
  const f = fixture(context);
  fs.chmodSync(f.urlFile, 0o644);
  await assert.rejects(setBotFatherThreadedMode({ ...f, enabled: true }));
  assert.equal(f.launched(), false);
});

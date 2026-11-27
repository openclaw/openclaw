import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";

const [entry, port, profile] = process.argv.slice(2);
assert(
  entry && port && profile,
  "usage: assert-tab-isolation.mjs <entry> <gateway-port> <profile>",
);
const run = promisify(execFile);
const submissions = [];
const fixture = createServer(async (request, response) => {
  if (request.url !== "/first" && request.url !== "/second") {
    response.writeHead(404).end();
    return;
  }
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    submissions.push({ path: request.url, name: new URLSearchParams(body).get("name") });
    response.writeHead(204).end();
    return;
  }
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Form fixture ${request.url}</title>
    <label>Name <input id="name"></label><button id="save">Save</button>
    <p role="status" id="result">Waiting</p>
    <script>
      document.querySelector('#save').onclick = async () => {
        const name = document.querySelector('#name').value;
        const result = await fetch(location.pathname, {
          method: 'POST', body: new URLSearchParams({ name }),
        });
        if (result.ok) document.querySelector('#result').textContent = 'Saved: ' + name;
      };
    </script>`);
});

async function browser(...args) {
  const { stdout } = await run(
    process.execPath,
    [entry, "browser", "--port", port, "--browser-profile", profile, "--json", ...args],
    { timeout: 30_000 },
  );
  return JSON.parse(stdout);
}

async function openForm(origin, path) {
  const opened = await browser("open", origin + path);
  const tab = opened.suggestedTargetId;
  assert.equal(typeof tab, "string", "open must return a reusable tab handle");
  const snapshot = await browser("snapshot", "--target-id", tab);
  assert.equal(snapshot.url, origin + path);
  const ref = (role, name) => {
    const match = Object.entries(snapshot.refs).find(
      ([, item]) => item.role === role && item.name === name,
    );
    assert(match, `missing ${role} "${name}" in ${path} snapshot`);
    return match[0];
  };
  return { tab, name: ref("textbox", "Name"), save: ref("button", "Save") };
}

async function submit(form, name) {
  await browser("type", form.name, name, "--target-id", form.tab);
  await browser("click", form.save, "--target-id", form.tab);
  await browser("wait", "--text", `Saved: ${name}`, "--target-id", form.tab);
}

try {
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const first = await openForm(origin, "/first");
  const second = await openForm(origin, "/second");
  assert.notEqual(first.tab, second.tab);

  // Snapshotting and focusing the second tab must not retarget the first tab's refs.
  await browser("focus", second.tab);
  await submit(first, "alpha");
  assert.deepEqual(submissions, [{ path: "/first", name: "alpha" }]);

  await browser("close", first.tab);
  const { tabs } = await browser("tabs");
  assert(!tabs.some((tab) => tab.url === origin + "/first"));
  assert(tabs.some((tab) => tab.url === origin + "/second"));
  await submit(second, "beta");
  assert.deepEqual(submissions, [
    { path: "/first", name: "alpha" },
    { path: "/second", name: "beta" },
  ]);
  await browser("close", second.tab);
  console.log("Browser tab isolation: two targeted forms submitted their own values exactly once");
} finally {
  await new Promise((resolve) => fixture.close(resolve));
}

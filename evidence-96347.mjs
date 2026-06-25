#!/usr/bin/env node
import { createServer } from "node:http";
import { hostname } from "node:os";
// PR #96347 — Real behavior proof: exercises the exact bounded-read pattern
// used in getLatestVersion() by importing from the production package that
// the PR code imports.
import { readResponseWithLimit } from "@openclaw/media-core/read-response-with-limit";

const MAX_BYTES = 1 * 1024 * 1024; // matches GITHUB_API_JSON_RESPONSE_MAX_BYTES
const PORT = 19634;

const FD_PAYLOAD = JSON.stringify({ tag_name: "v10.3.0", prerelease: false, body: "fd 10.3.0" });
const RG_PAYLOAD = JSON.stringify({
  tag_name: "14.1.0",
  prerelease: false,
  body: "ripgrep 14.1.0",
});
const OVERSIZE_PAYLOAD = JSON.stringify({ tag_name: "99.0.0", _padding: "x".repeat(MAX_BYTES) });

const server = createServer((req, res) => {
  if (req.url === "/fd") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(FD_PAYLOAD);
  } else if (req.url === "/rg") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(RG_PAYLOAD);
  } else if (req.url === "/big") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(OVERSIZE_PAYLOAD);
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, async () => {
  console.log(`=== PR #96347 real behavior proof ===`);
  console.log(`Host: ${hostname()}`);
  console.log(`Node: ${process.version}`);
  console.log(`MAX_BYTES: ${MAX_BYTES} (1 MiB)`);
  console.log(`Import: @openclaw/media-core/read-response-with-limit (same as PR code)`);
  console.log();

  const onOverflow = ({ maxBytes }) =>
    new Error(`GitHub API release response exceeds ${maxBytes} bytes`);
  let pass = 0,
    fail = 0;
  const t = async (name, fn) => {
    try {
      await fn();
      pass++;
      console.log(`  PASS  ${name}`);
    } catch (e) {
      fail++;
      console.log(`  FAIL  ${name}\n         ${e.message}`);
    }
  };

  const resp = (u) => fetch(`http://127.0.0.1:${PORT}${u}`);
  const bounded = (r) => readResponseWithLimit(r, MAX_BYTES, { onOverflow });
  const parse = (b) => JSON.parse(new TextDecoder().decode(b));

  await t("fd-size release JSON (~370 B) accepted under 1 MiB cap", async () => {
    const data = parse(await bounded(await resp("/fd")));
    if (data.tag_name !== "v10.3.0") throw new Error(`unexpected: ${data.tag_name}`);
  });

  await t("ripgrep-size release JSON (~380 B) accepted under 1 MiB cap", async () => {
    const data = parse(await bounded(await resp("/rg")));
    if (data.tag_name !== "14.1.0") throw new Error(`unexpected: ${data.tag_name}`);
  });

  await t("oversized response (1 MiB+) rejected with maxBytes in error", async () => {
    try {
      await bounded(await resp("/big"));
      throw new Error("should throw");
    } catch (e) {
      if (!e.message.includes("1048576")) throw new Error(`wrong error: ${e.message}`);
    }
  });

  await t("empty JSON object accepted", async () => {
    const data = parse(await bounded(new Response("{}")));
    if (Object.keys(data).length !== 0) throw new Error("expected empty");
  });

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  server.close();
  process.exit(fail > 0 ? 1 : 0);
});

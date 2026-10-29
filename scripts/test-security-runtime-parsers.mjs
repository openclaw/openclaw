import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const root = createRequire(new URL("../package.json", import.meta.url));
const matrix = createRequire(root.resolve("./extensions/matrix/package.json"));
const imap = createRequire(root.resolve("./extensions/imap/package.json"));
const mailparser = imap("mailparser");
const mailparserRequire = createRequire(imap.resolve("mailparser"));
const addressparser = mailparserRequire("nodemailer/lib/addressparser");
await test("mailparser preserves nested-comment sender identity", async () => {
  const nested = "Victim (x(y) <evil@evil.com>) <v@victim.com>";
  assert.deepEqual(addressparser(nested), [{ address: "v@victim.com", name: "Victim" }]);
  const mail = await mailparser.simpleParser(
    ["From: " + nested, "To: User <user@example.com>", "Subject: test", "", "hello"].join(
      String.fromCharCode(13, 10),
    ),
    {
      skipImageLinks: true,
      skipTextToHtml: true,
    },
  );
  assert.equal(mail.from.value[0].address, "v@victim.com");
  assert.equal(mail.to.value[0].address, "user@example.com");
});
// Boundary cases from upstream Nodemailer fix 1cd57d2 (Andris Reinman).
await test("mailparser keeps quoted angle and group delimiters inside addresses", () => {
  assert.deepEqual(addressparser('<"a@evil.com>"@good.com>'), [
    { address: '"a@evil.com>"@good.com', name: "" },
  ]);
  assert.deepEqual(addressparser('G: "a;" "<evil@evil.com>" <v@victim.com>;'), [
    { name: "G", group: [{ address: "v@victim.com", name: "a; <evil@evil.com>" }] },
  ]);
});

const metadataUrl = pathToFileURL(matrix.resolve("music-metadata")).href;
await test("metadata rejects zero-length MP4 entries without unbounded work", () => {
  const child =
    "const {parseBuffer}=await import(" +
    JSON.stringify(metadataUrl) +
    ");" +
    "try { await parseBuffer(Buffer.from('00000010667479704d34412000000000000000207374736400000000ffffffff000000006d7034610000000000000001','hex'),{mimeType:'audio/mp4'},{duration:true,skipCovers:true}); process.exit(2); }" +
    "catch(e) { if (!e.message.includes('Invalid stsd sample entry size: 0')) throw e; }";
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=128", "--input-type=module", "--eval", child],
    {
      timeout: 5000,
      killSignal: "SIGKILL",
      encoding: "utf8",
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

await test("metadata rejects oversized EBML before allocation", async () => {
  const { parseBuffer } = await import(metadataUrl);
  await assert.rejects(
    parseBuffer(
      Uint8Array.from([
        0x1a, 0x45, 0xdf, 0xa3, 0x8a, 0x42, 0x82, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
      ]),
      { mimeType: "video/webm" },
    ),
    /Invalid element length/,
  );
});

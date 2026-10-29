import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { test } from "node:test";

const imap = createRequire(new URL("../extensions/imap/package.json", import.meta.url));
const mailparser = imap("mailparser");
const consumers = ["mailparser", "mailauth"].map((name) => ({
  name,
  parser: createRequire(imap.resolve(name))("nodemailer/lib/addressparser"),
}));
// Fixtures adapted from Andris Reinman's Nodemailer fixes 0a876176 and 1cd57d2.
const cases = [
  [
    "nested comment",
    "Attacker (x(y) <trusted@example.com>) <attacker@evil.example>",
    "attacker@evil.example",
  ],
  ["quoted angle", '<"trusted@example.com>"@evil.example>', '"trusted@example.com>"@evil.example'],
  [
    "quoted group",
    'G: "a;" "<trusted@example.com>" <attacker@evil.example>;',
    "attacker@evil.example",
  ],
];
for (const [label, header, expected] of cases) {
  await test("inbound consumers preserve sender identity: " + label, async () => {
    for (const { name, parser } of consumers) {
      const parsed = parser(header, { flatten: true });
      assert.equal(parsed.length, 1, name);
      assert.equal(parsed[0].address, expected, name);
    }
    const mail = await mailparser.simpleParser(
      ["From: " + header, "To: reader@example.com", "Subject: parser boundary", "", "hello"].join(
        String.fromCharCode(13, 10),
      ),
    );
    // Flatten only to inspect identity; the production sender gate rejects From groups.
    const senders = mail.from.value.flatMap((entry) => entry.group ?? [entry]);
    assert.equal(senders.length, 1);
    assert.equal(senders[0].address, expected);
  });
}
await test("mailauth authenticates the same nested-comment sender domain", async () => {
  const raw = Buffer.from(
    ["From: " + cases[0][1], "To: reader@example.com", "", "hello"].join(
      String.fromCharCode(13, 10),
    ),
  );
  const result = await imap("mailauth").authenticate(raw, {
    disableArc: true,
    disableBimi: true,
    resolver: async () => [],
  });
  assert.equal(result.dkim.headerFrom[0], "attacker@evil.example");
});

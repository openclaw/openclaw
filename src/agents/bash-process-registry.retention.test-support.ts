import assert from "node:assert/strict";
import {
  addSession,
  appendOutput,
  deleteSession,
  getFinishedSession,
  getSession,
  markExited,
  prepareSessionPoll,
} from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { chunkString } from "./bash-tools.shared.js";

const MIB = 1024 * 1024;

function retain(index: number) {
  const session = createProcessSessionFixture({
    id: `retention-${index}`,
    maxOutputChars: 1_000,
    backgrounded: true,
  });
  addSession(session);
  const donor = Buffer.alloc(2 * MIB, 0x41 + index).toString("utf8");
  switch (index % 4) {
    case 0:
    case 1:
      // Exec splits one decoded callback into chunks before appending it.
      for (const chunk of chunkString(donor)) {
        appendOutput(session, "stdout", chunk);
      }
      break;
    case 2:
      // Even a value below the cap may borrow a much larger parent's storage.
      appendOutput(session, "stderr", donor.slice(64, 964));
      break;
    case 3:
      appendOutput(session, "stdout", donor);
      prepareSessionPoll(session, {});
      break;
  }
  if (index % 2 === 1) {
    markExited(session, 0, null, "completed");
  }
}

assert.equal(typeof global.gc, "function", "retention probe requires --expose-gc");
const gc = global.gc!;
const warm = createProcessSessionFixture({ id: "warm" });
appendOutput(warm, "stdout", "warm");
gc();
gc();
const before = process.memoryUsage();
for (let index = 0; index < 8; index++) {
  retain(index);
}
gc();
gc();
const after = process.memoryUsage();
const heapBytes = after.heapUsed - before.heapUsed;
const externalBytes = after.external - before.external;
console.log(JSON.stringify({ heapBytes, externalBytes, donorBytes: 16 * MIB }));
assert.ok(heapBytes < 2 * MIB, `bounded process output retained ${heapBytes} heap bytes`);
assert.ok(
  externalBytes < 2 * MIB,
  `bounded process output retained ${externalBytes} external bytes`,
);

// Assertions run after GC measurements so they cannot flatten the retained strings.
for (let index = 0; index < 8; index++) {
  const id = `retention-${index}`;
  const session = getSession(id) ?? getFinishedSession(id);
  assert.ok(session);
  assert.equal(
    session.aggregated,
    String.fromCharCode(0x41 + index).repeat(index % 4 === 2 ? 900 : 1_000),
  );
  assert.equal(session.totalOutputChars, index % 4 === 2 ? 900 : 2 * MIB);
  if (index % 4 === 3) {
    assert.equal(session.pendingPollDelivery?.output, session.aggregated);
  } else {
    assert.equal(prepareSessionPoll(session, undefined).output, session.aggregated);
  }
  markExited(session, 0, null, "completed");
  deleteSession(id);
}
const unicode = createProcessSessionFixture({ id: "unicode", maxOutputChars: 4 });
appendOutput(unicode, "stdout", "x🦞\ud800z");
assert.equal(unicode.aggregated, "🦞\ud800z");
assert.equal(prepareSessionPoll(unicode, undefined).output, "🦞\ud800z");

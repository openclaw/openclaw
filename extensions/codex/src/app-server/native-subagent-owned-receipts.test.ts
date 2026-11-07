import { link, symlink, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  hasUniqueOwnedChildResult,
  selectOwnedNativeCompletionReceipts,
} from "./native-subagent-owned-receipts.js";
import {
  candidate,
  childTurn,
  metadata,
  context,
  intent,
  consumed,
  ownedReceiptFixture,
} from "./native-subagent-owned-receipts.test-support.js";

it("joins the exact child-turn intent to a subsequent consumed native message", async () => {
  const f = await ownedReceiptFixture();
  const receipts = selectOwnedNativeCompletionReceipts(await f.read(), [candidate()]);
  expect(receipts).toHaveLength(1);
  expect(receipts[0]?.notification).toMatchObject({
    method: "rawResponseItem/completed",
    params: { threadId: "parent-thread", turnId: "parent-turn" },
  });
});

it.each([
  { name: "intent without consumption", records: [metadata(), context(), intent()] },
  { name: "consumption without intent", records: [metadata(), context(), consumed()] },
  { name: "consumption before intent", records: [metadata(), context(), consumed(), intent()] },
  {
    name: "duplicate consumed IDs",
    records: [metadata(), context(), intent(), consumed(), consumed("Child result", "other")],
  },
  {
    name: "different result",
    records: [metadata(), context(), intent(), consumed("other result")],
  },
  { name: "missing owned context", records: [metadata(), intent(), consumed()] },
  {
    name: "duplicate owned context",
    records: [metadata(), context(), context(), intent(), consumed()],
  },
])("rejects incomplete or ambiguous facts: $name", async ({ records }) => {
  const f = await ownedReceiptFixture(records);
  expect(selectOwnedNativeCompletionReceipts(await f.read(), [candidate()])).toEqual([]);
});

it.each(["parent", "turn", "path", "child", "unproved"] as const)(
  "rejects mismatched %s ownership",
  async (field) => {
    const f = await ownedReceiptFixture();
    const pending = candidate();
    if (field === "parent") {
      f.params.parentThreadId = "foreign-parent";
    }
    if (field === "turn") {
      f.params.turnId = "foreign-turn";
    }
    if (field === "path") {
      pending.agentPaths = ["/root/other"];
    }
    if (field === "child") {
      pending.childThreadId = "other-child";
    }
    if (field === "unproved") {
      pending.uniqueResultProven = false;
    }
    expect(selectOwnedNativeCompletionReceipts(await f.read(), [pending])).toEqual([]);
  },
);

it.each([
  "hardlink",
  "symlink",
  "outside",
  "root-symlink",
  "partial",
  "invalid-utf8",
  "expired",
  "revoked",
  "window",
] as const)("refuses unsafe or unproven canonical source: %s", async (failure) => {
  const f = await ownedReceiptFixture();
  if (failure === "hardlink" || failure === "symlink") {
    const destination = path.join(f.params.sessionsRoot, "alias.jsonl");
    await (failure === "hardlink" ? link : symlink)(f.params.rolloutPath, destination);
    f.params.rolloutPath = destination;
  }
  if (failure === "outside") {
    f.params.rolloutPath = path.join(f.home, "outside.jsonl");
    await writeFile(f.params.rolloutPath, f.content);
  }
  if (failure === "root-symlink") {
    const alias = path.join(f.home, "alias");
    await symlink(f.params.sessionsRoot, alias);
    f.params.sessionsRoot = alias;
    f.params.rolloutPath = path.join(alias, "rollout-parent.jsonl");
  }
  if (failure === "partial") {
    await writeFile(f.params.rolloutPath, f.content.trimEnd());
  }
  if (failure === "invalid-utf8") {
    await appendFile(f.params.rolloutPath, Buffer.from([0xff, 10]));
  }
  if (failure === "expired") {
    f.params.deadlineAt = performance.now() - 1;
  }
  if (failure === "revoked") {
    f.params.assertCurrent = () => {
      throw new Error("revoked");
    };
  }
  if (failure === "window") {
    await appendFile(
      f.params.rolloutPath,
      JSON.stringify({ padding: "x".repeat(16 * 1024 * 1024) }) + "\n",
    );
  }
  const facts = await f.read().catch(() => undefined);
  expect(selectOwnedNativeCompletionReceipts(facts, [candidate()])).toEqual([]);
});

it.each([
  {
    name: "known distinct predecessor",
    data: [childTurn("old", "Old result"), childTurn()],
    expected: true,
  },
  { name: "same predecessor body", data: [childTurn("old"), childTurn()], expected: false },
  { name: "same later body", data: [childTurn(), childTurn("later")], expected: false },
  {
    name: "unknown active turn",
    data: [childTurn(), childTurn("later", "Next", "inProgress")],
    expected: false,
  },
  { name: "duplicate turn IDs", data: [childTurn(), childTurn()], expected: false },
  { name: "wrong candidate turn", data: [childTurn("other")], expected: false },
  { name: "wrong result", data: [childTurn("child-turn", "other")], expected: false },
  { name: "incomplete pagination", data: [childTurn()], cursor: "next", expected: false },
])("requires complete unique canonical child results: $name", ({ data, cursor, expected }) => {
  expect(hasUniqueOwnedChildResult(candidate(), { data, nextCursor: cursor ?? null })).toBe(
    expected,
  );
});

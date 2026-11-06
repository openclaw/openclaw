import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createKnowledgeService } from "./service.js";
import { hostApi, stopAtTestEnd, toolContext, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

it("provisions an empty store and retains published evidence across a stopped service", async () => {
  const services: Array<{ stop?: () => unknown }> = [];
  const host = hostApi(tempDirs.make("knowledge-persistence-"), {
    extra: {
      registerService(service: { stop?: () => unknown }) {
        services.push(service);
        stopAtTestEnd(service);
      },
    },
  });
  const first = createKnowledgeService(host.api);
  const context = toolContext(host.api);
  const bytes = Buffer.from("Original evidence retained across service restart.\n");
  const upload = {
    requestId: randomUUID(),
    filename: "evidence.txt",
    attribution: "Synthetic persistence proof",
    data: bytes.toString("base64"),
    offset: 0,
    final: true,
  };
  const attached = await first.attach(upload, context);
  expect(attached.state).toBe("complete");
  const evidence = attached.evidence!;
  const draft = {
    requestId: randomUUID(),
    title: "Persistent note",
    type: "note",
    body: "Retained note body.\n",
    attachments: [evidence],
  };
  const receipt = await first.save_page(draft, context);
  expect(receipt.state).toBe("published");
  for (const service of services) {
    await service.stop?.();
  }
  const restarted = createKnowledgeService(host.api);
  expect(await restarted.save_page(draft, context)).toEqual(receipt);
  expect(await restarted.attach(upload, context)).toEqual(attached);
  const read = await restarted.record({ id: receipt.id, includeEvidence: true }, context);
  expect(read.record?.body).toBe(draft.body);
  expect(read.evidence?.[0]?.verified).toBe(true);
  const original = await restarted.attachment(
    {
      id: receipt.id,
      path: evidence.path,
      sha256: evidence.sha256,
    },
    context,
  );
  expect(Buffer.from(original.data, "base64")).toEqual(bytes);
  expect((await restarted.records({}, context)).total).toBe(1);
});

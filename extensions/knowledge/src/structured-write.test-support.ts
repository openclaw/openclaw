import { randomUUID } from "node:crypto";

export const draft = () => ({
  requestId: randomUUID(),
  title: "Publication test",
  type: "note",
  body: "Authored text.\n",
});
export const edit = (record: any, fields = {}) => ({
  requestId: randomUUID(),
  id: record.id,
  expectedRevision: record.revision,
  expectedHash: record.hash,
  title: record.title,
  body: record.body,
  ...fields,
});

// Seed the same authored records for structured-write and lifecycle tests.
// Keep service calls sequential so publication and evidence ordering stay explicit.
export async function seedStructuredWriteFixture(f: any) {
  f.fingerprint = (await f.service.ontology({}, f.owner)).fingerprint;
  f.pages = {};
  for (const type of ["person", "project", "meeting"]) {
    f.pages[type] = await f.service.save_page({ ...draft(), title: type, type }, f.owner);
  }
  f.source = await f.service.attach(
    {
      requestId: randomUUID(),
      filename: "meeting.txt",
      mediaType: "text/plain",
      attribution: "Meeting transcript",
      offset: 0,
      data: Buffer.from(
        "Alex: We chose option B.\nAlex: I will deliver by Friday.\nSpeaker 2: I disagree.",
      ).toString("base64"),
      final: true,
    },
    f.owner,
  );
  f.evidence = {
    ...f.source.evidence,
    start_line: 1,
    end_line: 1,
    quote: "We chose option B.",
  };
  f.claim = (extra = {}) => ({
    requestId: randomUUID(),
    expectedOntologyFingerprint: f.fingerprint,
    title: "Option B decision",
    body: "Alex chose option B.",
    claim_kind: "decision",
    assertion_origin: "source",
    attribution: "Alex, meeting transcript line 1",
    evidence: [f.evidence],
    entities: [f.pages.project.id],
    dependencies: [f.pages.meeting.id],
    ...extra,
  });
  f.edge = (extra = {}) => ({
    requestId: randomUUID(),
    expectedOntologyFingerprint: f.fingerprint,
    title: "Meeting discusses project",
    body: "Explicit meeting/project connection",
    from: f.pages.meeting.id,
    to: f.pages.project.id,
    label: "discusses",
    attribution: "Meeting transcript",
    evidence: [f.evidence],
    ...extra,
  });
}

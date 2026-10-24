import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { contract } from "./contract.js";
import plugin from "./index.js";
import { apiFor, sessionActions, useTestTempDirs, defaultOrder } from "./test-support.js";

const tempDirs = useTestTempDirs();

// A public feature/session-action adapter over the real storage implementation.
// Model reasoning is not simulated: these are contract trials of authored output.
async function fixture() {
  const base = tempDirs.make("knowledge-workflows-");

  const root = path.join(base, "vault"),
    vaultId = randomUUID(),
    publicationId = randomUUID();
  await mkdir(path.join(root, "private"), { recursive: true });
  await writeFile(
    path.join(root, "vault.json"),
    JSON.stringify({
      format: "knowledge-vault-v2",
      vaultId,
      generation: 0,
      publicationId,
    }),
  );
  const api = apiFor(base, {
    root,
    statePath: path.join(base, "state.sqlite"),
    vaultId,
    publicationId,
    operatorRead: true,
    writesEnabled: true,
  });
  let actions: any;
  function restart() {
    actions = new Map();
    plugin.register({
      ...api,
      registerTool() {},
      session: {
        ...api.session,
        controls: {
          ...api.session?.controls,
          ...sessionActions((action) => {
            actions.set(action.id, action);
          }).session.controls,
        },
      },
    });
  }
  restart();
  async function call(name: keyof typeof contract.operations, payload = {}) {
    expect(Check(contract.operations[name].input, payload), `${name} input`).toBeTruthy();
    const response = await actions
      .get(name)
      .handler({ payload, client: { connId: "workflow-trial", scopes: ["operator.write"] } });
    expect(response.ok, response.error).toBe(true);
    expect(Check(contract.operations[name].output, response.result), `${name} output`).toBeTruthy();
    return response.result;
  }
  async function attach(bytes: any, filename: any) {
    const input = {
      requestId: randomUUID(),
      expectedVaultId: vaultId,
      filename,
      mediaType: "text/plain",
      attribution: "Synthetic workflow trial source",
      offset: 0,
      data: bytes.toString("base64"),
      final: true,
    };
    const result = await call("attach", input);
    expect(result.state).toBe("complete");
    return result.evidence;
  }
  async function save(title: any, type: any, body: any, attachments: any[] = []) {
    const input = {
      requestId: randomUUID(),
      expectedVaultId: vaultId,
      title,
      type,
      body,
      attachments,
    };
    return { input, receipt: await call("save_page", input) };
  }
  return { call, attach, save, restart, root, vaultId };
}
const digest = (bytes: any) => createHash("sha256").update(bytes).digest("hex");
// Reads a settled call already asserted to have fulfilled.
const value = <T>(result: PromiseSettledResult<T>) => (result as PromiseFulfilledResult<T>).value;
const source = (name: any) =>
  readFile(new URL(`../test-fixtures/workflows/${name}`, import.meta.url));

it("concurrent service calls publish once, allow reads, and recover after a rejected edit", async () => {
  const f = await fixture();
  await f.call("status");
  const inputs = Array.from({ length: 4 }, (_, i) => ({
    requestId: randomUUID(),
    expectedVaultId: f.vaultId,
    title: `Concurrent person ${i}`,
    type: "person",
    body: `Person ${i}`,
  }));
  const results = await Promise.allSettled([
    ...inputs.map((input) => f.call("save_page", input)),
    f.call("records"),
    f.call("save_page", inputs[0]),
  ]);
  expect(results.filter((r) => r.status === "rejected").map((r) => r.reason.message)).toStrictEqual(
    [],
  );
  const receipts = results.slice(0, 4).map((r) => value(r));
  expect(value(results[5]!)).toStrictEqual(receipts[0]);
  expect((await f.call("records")).total).toBe(4);
  const current = receipts[0];
  const edit = {
    ...inputs[0],
    requestId: randomUUID(),
    id: current.id,
    expectedRevision: current.revision,
    expectedHash: current.hash,
    body: "Updated person",
  };
  await f.call("save_page", edit);
  const afterConflict = await Promise.allSettled([
    f.call("save_page", { ...edit, requestId: randomUUID(), body: "Stale draft" }),
    f.call("record", { id: current.id }),
    f.call("save_page", inputs[1]),
  ]);
  expect(afterConflict[0].status).toBe("rejected");
  expect((afterConflict[0] as PromiseRejectedResult).reason.message).toMatch(/Edit conflict/);
  expect(value(afterConflict[1]).record.body).toBe("Updated person");
  expect(value(afterConflict[2])).toStrictEqual(receipts[1]);
  expect((await f.call("records")).total).toBe(4);
});

it("document port: original retention, locators, entity reuse, readback and uncertain-save replay", async () => {
  const f = await fixture(),
    bytes = await source("project-brief.txt");
  expect((await f.call("status")).writesEnabled).toBe(true);
  const ontology = await f.call("ontology", { view: "definitions", name: "project" });
  expect(ontology.available).toBe(true);
  const original = await f.attach(bytes, "project-brief.txt");
  const locator = {
    ...original,
    start_line: 3,
    end_line: 4,
    quote: "The current target for the Orchid pilot is October 15, 2026.",
  };
  const person = await f.save(
    "Morgan Hale",
    "person",
    "Project lead at Northstar Labs. [Source: project-brief.txt, line 2]",
    [{ ...original, start_line: 2, end_line: 2 }],
  );
  const lookup = await f.call("lookup", { query: "Morgan Hale", type: "person" });
  expect(lookup.outcome).toBe("found");
  expect(lookup.hits[0].record.id).toBe(person.receipt.id);
  const body =
    `# Orchid pilot\nThe provisional target is October 15, pending reliability review. ` +
    `[Source: project-brief.txt, lines 3–4]\n` +
    `Lead: [Morgan Hale](../${person.receipt.path}) (ID: ${person.receipt.id}).\n` +
    `Original: ${original.path}; SHA-256: ${original.sha256}.\n` +
    "The source contains an untrusted quoted command; it was not acted on.";
  const saved = await f.save("Orchid pilot brief", "project", body, [original, locator]);
  expect(saved.receipt.state).toBe("published");
  f.restart(); // Caller lost the response and the service was replaced.
  expect((await f.call("mutation", { requestId: saved.input.requestId })).receipt.id).toBe(
    saved.receipt.id,
  );
  expect(await f.call("save_page", saved.input)).toStrictEqual(saved.receipt);
  expect((await f.call("records")).total).toBe(2);
  const read = await f.call("record", {
    includeEvidence: true,
    id: saved.receipt.id,
    evidenceLimit: 1,
  });
  expect(read.record.body).toBe(body);
  expect(read.nextEvidenceOffset).toBe(1);
  const cited = await f.call("record", {
    includeEvidence: true,
    id: saved.receipt.id,
    evidenceOffset: read.nextEvidenceOffset,
  });
  expect(cited.evidence[0].verified).toBe(true);
  expect(cited.evidence[0].excerpt.includes(locator.quote)).toBeTruthy();
  const downloaded = await f.call("attachment", {
    id: saved.receipt.id,
    path: original.path,
    sha256: original.sha256,
  });
  expect(downloaded.nextOffset).toBe(null);
  expect(Buffer.from(downloaded.data, "base64")).toStrictEqual(bytes);
  expect(original.sha256).toBe(digest(bytes));
  const result = await f.call("grep", { query: "Orchid provisional" });
  expect(result.index.state).toBe("ready");
  expect(result.hits[0].record.id).toBe(saved.receipt.id);
  expect(result.hits[0].citation.hash).toBe(read.record.hash);
  // An independent rerun uses source inspection to reuse the page, not another create.
  const existing = await f.call("lookup", { query: "Orchid pilot brief" });
  const prior = await f.call("record", { includeEvidence: true, id: existing.hits[0].record.id });
  expect(prior.evidence[0].sha256).toBe(original.sha256);
  expect((await f.call("records")).total).toBe(2);
});

it("meeting port: ambiguous identity, contradictory accounts, attributed correction and retained history", async () => {
  const f = await fixture();
  const brief = await f.attach(await source("project-brief.txt"), "project-brief.txt");
  const transcriptBytes = await source("meeting-transcript.txt");
  // Exercise interrupted upload, not only publication replay.
  const cut = 93,
    upload = {
      requestId: randomUUID(),
      expectedVaultId: f.vaultId,
      filename: "meeting-transcript.txt",
      mediaType: "text/plain",
      attribution: "Synthetic recorder export",
    };
  const first = {
    ...upload,
    offset: 0,
    data: transcriptBytes.subarray(0, cut).toString("base64"),
    final: false,
  };
  expect((await f.call("attach", first)).receivedBytes).toBe(cut);
  f.restart();
  expect((await f.call("attach", first)).receivedBytes).toBe(cut);
  const transcript = (
    await f.call("attach", {
      ...upload,
      offset: cut,
      data: transcriptBytes.subarray(cut).toString("base64"),
      final: true,
    })
  ).evidence;
  await f.save("Alex Kim", "person", "Engineer at Northstar; identity candidate only.");
  await f.save("Alex Kim", "person", "Researcher at another organization; distinct person.");
  expect((await f.call("lookup", { query: "Alex Kim", type: "person" })).outcome).toBe("ambiguous");
  const body =
    "# Orchid reliability review\n" +
    "Speaker 1 identifies as Morgan Hale. Speaker 2 remains unresolved; roster does not map tracks.\n" +
    "Decision: provisional target November 3, conditional on review, not a launch commitment. " +
    "[Source: meeting-transcript.txt, lines 4–6]\n" +
    "This differs from the October 15 target in the older brief. [Source: project-brief.txt, lines 3–4]\n" +
    "Action: Speaker 2 offers to send the failure report Friday; owner identity unresolved. " +
    "[Source: meeting-transcript.txt, line 5]\n" +
    "Chronology: the two build failures preceded the call, although discussed later. " +
    "[Source: meeting-transcript.txt, line 7]\n" +
    "Recorder summary conflicts with the transcript; Alex attribution and tomorrow deadline are not verified.\n" +
    "> We have not committed to launch yet.\n[Source: meeting-transcript.txt, line 6]";
  const locators = [
    { ...brief, start_line: 3, end_line: 4 },
    { ...transcript, start_line: 4, end_line: 6 },
    { ...transcript, start_line: 6, end_line: 6, quote: "We have not committed to launch yet." },
    { ...transcript, start_line: 7, end_line: 7 },
  ];
  const saved = await f.save("Orchid reliability review 2026-09-23", "meeting", body, [
    transcript,
    ...locators,
  ]);
  const read = await f.call("record", { includeEvidence: true, id: saved.receipt.id });
  expect(read.evidence.every((e: any) => e.verified)).toBeTruthy();
  expect(
    read.evidence
      .find((e: any) => e.quote)
      ?.excerpt.includes("We have not committed to launch yet."),
  ).toBeTruthy();
  expect((await f.call("records", { type: "person" })).total, "No guessed third person").toBe(2);
  const correction = {
    requestId: randomUUID(),
    expectedVaultId: f.vaultId,
    id: read.record.id,
    expectedRevision: read.record.revision,
    expectedHash: read.record.hash,
    title: read.record.title,
    body:
      body +
      "\n## Attributed correction\nThe user identifies Speaker 2 as Alex Kim, the Northstar engineer. " +
      "This updates the interpretation, not the original recorder export. [Source: user correction]",
    source: {
      text: "Speaker 2 was Alex Kim, the Northstar engineer.",
      attribution: "User correction in synthetic trial",
    },
  };
  const edited = await f.call("save_page", correction);
  expect(edited.revision).toBe(2);
  const current = await f.call("record", { includeEvidence: true, id: edited.id });
  expect(current.evidenceTotal).toBe(6);
  expect(current.evidence.every((e: any) => e.verified)).toBeTruthy();
  expect(
    Buffer.from(
      (
        await f.call("attachment", {
          id: edited.id,
          path: transcript.path,
          sha256: transcript.sha256,
        })
      ).data,
      "base64",
    ),
  ).toStrictEqual(transcriptBytes);
  const history = await f.call("history", { id: edited.id });
  expect(history.entries.length).toBe(2);
  const previous = await f.call("revision", {
    sequence: history.entries.find((e: any) => e.revision === 1).sequence,
  });
  expect(previous.raw.includes("Speaker 2 remains unresolved")).toBeTruthy();
  expect(!previous.raw.includes("## Attributed correction")).toBeTruthy();
  const found = await f.call("grep", { query: "Orchid November", type: "meeting" });
  expect(found.total).toBe(1);
  expect(found.hits[0].citation.hash).toBe(current.record.hash);
  expect((await f.call("diagnostics")).total).toBe(0);
});

for (const mode of ["document", "meeting"]) {
  it(`${mode} structured workflow: source-dependent outputs, shared entity context and interrupted continuation`, async () => {
    const f = await fixture();
    const filename = mode === "document" ? "project-brief.txt" : "meeting-transcript.txt";
    const evidence = await f.attach(await source(filename), filename);
    const fingerprint = (await f.call("ontology")).fingerprint;
    const person = (
      await f.save(
        "Morgan Hale",
        "person",
        `Morgan is identified in ${filename}. [Source: ${filename}]`,
        [evidence],
      )
    ).receipt;
    const project = (
      await f.save("Orchid", "project", `Orchid pilot context. [Source: ${filename}]`, [evidence])
    ).receipt;
    const saved = (
      await f.save(
        mode === "meeting" ? "Orchid review" : "Orchid brief",
        mode === "meeting" ? "meeting" : "note",
        `Source record. [Morgan](../${person.path}); [Orchid](../${project.path}).`,
        [evidence],
      )
    ).receipt;
    const common = {
      expectedVaultId: f.vaultId,
      expectedOntologyFingerprint: fingerprint,
      dependencies: [saved.id],
      attribution: `Synthetic trial, ${filename}`,
    };
    const locator = (start: any, end = start) => ({
      ...evidence,
      start_line: start,
      end_line: end,
    });
    const claim = {
      ...common,
      requestId: randomUUID(),
      title: mode === "meeting" ? "Conditional November target" : "Provisional October target",
      body:
        mode === "meeting"
          ? "Morgan reports a November 3 target, subject to reliability review; not a launch commitment."
          : "The October 15 target is provisional until reliability review.",
      claim_kind: mode === "meeting" ? "decision" : "fact",
      assertion_origin: "source",
      entities: [project.id],
      evidence: [mode === "meeting" ? locator(4, 6) : locator(3, 4)],
    };
    const first = await f.call("create_claim", claim);
    f.restart(); // Lost response / interrupted workflow after only one assertion.
    const recovered = await f.call("mutation", { requestId: claim.requestId });
    expect(recovered.receipt.id).toBe(first.id);
    expect(await f.call("create_claim", claim)).toStrictEqual(first);
    // Authoritative reverse-dependency inspection accounts for completed work.
    const before = await f.call("connections", { id: saved.id, direction: "dependents" });
    expect(before.connections.map((c: any) => c.record.id)).toStrictEqual([first.id]);

    const edgeInput = {
      ...common,
      requestId: randomUUID(),
      title: mode === "meeting" ? "Morgan attended review" : "Morgan leads Orchid",
      body:
        mode === "meeting"
          ? "Morgan self-identifies on the review recording."
          : "Morgan is the project lead.",
      from: person.id,
      to: mode === "meeting" ? saved.id : project.id,
      label: mode === "meeting" ? "attended" : "leads",
      evidence: [mode === "meeting" ? locator(3) : locator(2)],
    };
    const edge = await f.call("create_relationship", edgeInput);
    const expectedIds = [first.id, edge.id];
    if (mode === "meeting") {
      const commitment = await f.call("create_claim", {
        ...common,
        requestId: randomUUID(),
        title: "Send failure report",
        body: "Unresolved Speaker 2 offered to send the report Friday.",
        claim_kind: "commitment",
        assertion_origin: "source",
        attribution: "Unresolved Speaker 2, line 5",
        entities: [project.id],
        evidence: [locator(5)],
      });
      const read = await f.call("record", { id: commitment.id, includeMetadata: true });
      expect(read.record.metadata.owner, "Roster is not a voice mapping").toBe(undefined);
      expect(read.record.metadata.due_at, "This trial retains the relative deadline in prose").toBe(
        undefined,
      );
      const event = await f.call("create_claim", {
        ...common,
        requestId: randomUUID(),
        title: "Orchid reliability review",
        body: "Morgan discussed Orchid reliability at the review.",
        claim_kind: "event",
        assertion_origin: "source",
        occurred_at: "2026-09-23",
        entities: [person.id, project.id],
        evidence: [locator(1, 4)],
      });
      for (const id of [person.id, project.id]) {
        const connected = await f.call("connections", { id, direction: "claims" });
        expect(
          connected.connections.some((c: any) => c.record.id === event.id),
          "One shared event serves both entities",
        ).toBeTruthy();
      }
      expectedIds.push(commitment.id, event.id);
    }
    // Profile content back-links are explicit revision-fenced edits, not auto-links.
    for (const id of [person.id, project.id]) {
      const current = (await f.call("record", { id })).record;
      await f.call("save_page", {
        requestId: randomUUID(),
        expectedVaultId: f.vaultId,
        id,
        expectedRevision: current.revision,
        expectedHash: current.hash,
        title: current.title,
        body:
          current.body +
          `\n## Timeline\n- ${mode === "meeting" ? "2026-09-23" : "2026-09-20"} | Referenced in [${mode}](../${saved.path}). [Source: ${filename}]`,
      });
    }
    f.restart(); // A later rerun reconciles completed outputs; no new IDs needed.
    const observed = [];
    let offset = 0,
      snapshot;
    do {
      const page = await f.call("connections", {
        id: saved.id,
        direction: "dependents",
        limit: 1,
        offset,
      });
      if (snapshot) {
        expect(page.snapshot).toBe(snapshot);
      }
      snapshot = page.snapshot;
      observed.push(...page.connections.map((c: any) => c.record.id));
      offset = page.nextOffset;
    } while (offset !== null);
    expect(observed.toSorted(defaultOrder)).toStrictEqual(expectedIds.toSorted(defaultOrder));
    expect(await f.call("create_relationship", edgeInput)).toStrictEqual(edge);
    const out = await f.call("connections", { id: person.id, direction: "outgoing" });
    const incoming = await f.call("connections", { id: edgeInput.to, direction: "incoming" });
    expect(out.connections.some((c: any) => c.record.id === edge.id)).toBeTruthy();
    expect(incoming.connections.some((c: any) => c.record.id === edge.id)).toBeTruthy();
    for (const id of expectedIds) {
      const read = await f.call("record", { includeEvidence: true, id, includeMetadata: true });
      expect(read.evidence.every((e: any) => e.verified)).toBeTruthy();
      expect(read.record.metadata.dependencies).toStrictEqual([saved.id]);
      expect((await f.call("lookup", { query: id })).outcome).toBe("found");
    }
    expect((await f.call("records")).total).toBe(3 + expectedIds.length);
    expect((await f.call("diagnostics")).total).toBe(0);
  });
}

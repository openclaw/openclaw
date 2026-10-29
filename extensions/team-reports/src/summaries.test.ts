import { afterEach, expect, it, vi } from "vitest";
import { githubItem, reportDocument, reportMember } from "./reports-data.test-support.js";
import { completion, githubCounts as counts, type Complete } from "./reports.fixtures.js";
import { generateSummaries } from "./summaries.js";
import type { ReportDocument } from "./types.js";

const report = (): ReportDocument =>
  reportDocument([
    reportMember("alex", { github: { ...counts(1), items: [githubItem({ actor: "alex" })] } }),
    reportMember("blair", { github: { ...counts(), items: [] } }),
  ]);

function response() {
  return {
    globalSummary: "One active member.\n\n- **Widgets:** Fixed.\n- **Coverage:** Complete.",
    highlights: ["Fixed.", "No reviews.", "No messages.", "One inactive."],
    members: [
      { login: "alex", summary: "Corrected widget resizing.", confidence: "high" },
      { login: "blair", summary: "No visible activity was recorded.", confidence: "low" },
    ],
  };
}

function summarize(
  complete: Complete,
  overrides: Omit<Partial<Parameters<typeof generateSummaries>[0]>, "llm"> = {},
) {
  return generateSummaries({
    report: report(),
    options: { enabled: true },
    ...overrides,
    llm: { complete },
  });
}

const modelCompletion = () => completion(JSON.stringify(response()));

afterEach(() => vi.restoreAllMocks());

it.each(["missing", "duplicate"])("repairs valid JSON with %s member coverage", async (kind) => {
  const incomplete = response();
  if (kind === "missing") {
    incomplete.members.pop();
  } else {
    incomplete.members.push({ login: "alex", summary: "Duplicate.", confidence: "high" });
  }
  const complete = vi
    .fn<Complete>()
    .mockResolvedValueOnce(completion(JSON.stringify(incomplete)))
    .mockResolvedValueOnce(modelCompletion());
  const result = await summarize(complete);
  expect(result.summary.source).toBe("model");
  expect(result.report.members.every((entry) => entry.summary?.source === "model")).toBe(true);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain("member login");
});

it.each([
  '{"globalSummary":"private-response-marker',
  JSON.stringify({ ...response(), "private-response-marker": true }),
  JSON.stringify({
    ...response(),
    members: [{ login: "private-response-marker", summary: "Private", confidence: "low" }],
  }),
  new Error("private-response-marker"),
])("redacts failed summaries and clears warnings when disabled (case %#)", async (raw) => {
  vi.spyOn(Date, "now").mockReturnValue(20);
  const input = report();
  input.sources.github = { ok: false, warnings: ["Collection incomplete"], stats: {} };
  const complete = vi.fn<Complete>().mockImplementation(async () => {
    if (raw instanceof Error) {
      throw raw;
    }
    return completion(raw);
  });
  const logger = { warn: vi.fn() };
  const result = await summarize(complete, { report: input, logger });
  expect(result.summary).toMatchObject({
    source: "fallback",
    warnings: [expect.stringContaining("Model summary unavailable")],
  });
  expect(result.summary.warnings?.[0]?.length).toBeLessThanOrEqual(300);
  expect(logger.warn.mock.calls).toEqual([[result.summary.warnings?.[0]]]);
  expect(JSON.stringify([result, logger.warn.mock.calls])).not.toContain("private-response-marker");
  expect(result.report.members[0]?.github.items).toEqual(input.members[0]?.github.items);
  expect(result.report.members[1]?.summary).toMatchObject({
    source: "fallback",
    confidence: "low",
    text: expect.stringContaining("No visible activity"),
  });
  expect(input.members[0]?.summary).toBeUndefined();
  const params = { report: input, options: { enabled: false }, logger };
  const disabled = await summarize(complete, { ...params, previous: result });
  expect(disabled).toEqual(await summarize(complete, params));
  expect(disabled.summary.globalSummary).toContain("Source coverage has gaps");
  expect(disabled.report.members).toHaveLength(2);
  expect(disabled.summary.warnings).toBeUndefined();
  expect(complete).toHaveBeenCalledTimes(raw instanceof Error ? 1 : 2);
  expect(logger.warn).toHaveBeenCalledOnce();
});

it("reuses an unchanged fingerprint and restores stored member prose onto fresh evidence", async () => {
  const complete = vi.fn<Complete>().mockResolvedValue(modelCompletion());
  const first = await summarize(complete);
  const fresh = report();
  fresh.generatedAtMs = 12345;
  fresh.sources.github.stats.apiCalls = 100;
  fresh.members.reverse();
  const next = await summarize(complete, { report: fresh, previous: first });
  expect(complete).toHaveBeenCalledOnce();
  expect(next.summary).toEqual(first.summary);
  expect(next.report.generatedAtMs).toBe(12345);
  expect(next.report.members.find((entry) => entry.login === "alex")?.summary?.text).toBe(
    response().members[0]?.summary,
  );
});

it("bounds member evidence and excludes raw comment bodies from model input", async () => {
  const input = report();
  input.members[0]!.github.items = Array.from({ length: 100 }, (_, index) =>
    githubItem({
      kind: "issue_comment",
      title: `Public summary ${index}`,
      body: "RAW BODY MUST NOT REACH THE MODEL",
      url: `https://github.com/sample/widgets/issues/1#comment-${index}`,
      actor: "alex",
      atMs: index,
    }),
  );
  const complete = vi.fn<Complete>().mockResolvedValue(modelCompletion());
  await summarize(complete, { report: input });
  const digest = complete.mock.calls[0]?.[0].messages[1]?.content;
  expect(digest).not.toContain("RAW BODY");
  expect(digest).toContain("Public summary 99");
  expect(digest).not.toContain('"title":"Public summary 19"');
});

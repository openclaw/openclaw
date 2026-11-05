import { expect, it } from "vitest";
import { keywordCandidates, type KeywordPage } from "./recall-keyword.js";

const budget = { excerpts: 4, excerptChars: 1_000, pageChars: 2_800 };
const page = (id: string, label: string, body: string): KeywordPage => ({
  entry: { id, line: `note: ${label}`, label },
  body,
});

it("matches across possessives and simple plurals, ignoring stopwords", () => {
  const pages = [page("a", "Vaccination", "Nova got one."), page("b", "What are these", "x")];
  expect(keywordCandidates("What are Nova's vaccinations?", pages, 10, budget)).toMatchObject([
    { id: "a" },
  ]);
});

it("ranks by BM25 with a title boost and keeps only pages sharing a word", () => {
  const pages = [
    page("a", "Pizza oven", "Firebrick order placed."),
    page("b", "Vet visits", "Nova saw the vet. Nova is fine."),
    page("c", "Nova", "Puppy notes."),
  ];
  const ids = keywordCandidates("how is nova", pages, 10, budget).map((e) => e.id);
  // The title match outranks body mentions; the unrelated page is dropped.
  expect(ids).toEqual(["c", "b"]);
  expect(keywordCandidates("nova", pages, 1, budget).map((e) => e.id)).toEqual(["c"]);
  expect(keywordCandidates("the of", pages, 10, budget)).toEqual([]);
});

it("quotes the best passages within the per-passage and per-page budgets", () => {
  const long = (word: string) => `${word} ${"x".repeat(1_400)}`;
  const body = [long("alpha"), long("beta gamma"), long("gamma"), "short gamma", "delta"].join(
    "\n\n",
  );
  const [entry] = keywordCandidates("gamma beta", [page("p", "Doc", body)], 10, budget);
  const parts = entry!.text!.split("\n");
  // Rank: "beta gamma" first, then the gamma passages in page order; 1,000 chars
  // each and at most 2,800 per page, so the third long one is skipped for the short one.
  expect(parts.map((p) => p.slice(0, 10))).toEqual(["beta gamma", "gamma xxxx", "short gamm"]);
  expect(parts[0]).toHaveLength(1_000);
  expect(entry!.text!.length).toBeLessThanOrEqual(2_800 + parts.length);
  expect(entry!.text).not.toContain("alpha");
});

it("matches words in any script", () => {
  const pages = [page("a", "Прививки", "Нове нужна прививка."), page("b", "日記", "x")];
  expect(keywordCandidates("Когда прививка?", pages, 10, budget)).toMatchObject([{ id: "a" }]);
});

it("clips a long passage around the words that matched it", () => {
  const body = `${"General notes about the house. ".repeat(40)}Router reset PIN: 4421.`;
  const [entry] = keywordCandidates("router reset", [page("m", "Maintenance", body)], 10, budget);
  expect(entry!.text).toHaveLength(1_000);
  expect(entry!.text).toContain("Router reset PIN: 4421.");
});

it("fits the match window to what is left of the page budget, separators included", () => {
  const body = `${"General notes. ".repeat(80)}Router reset PIN: 4421.\n\n${"router ".repeat(30)}`;
  const tight = { excerpts: 4, excerptChars: 1_000, pageChars: 200 };
  const [entry] = keywordCandidates("router reset", [page("m", "Maintenance", body)], 10, tight);
  expect(entry!.text).toContain("Router reset PIN: 4421.");
  expect(entry!.text!.length).toBeLessThanOrEqual(200);
});

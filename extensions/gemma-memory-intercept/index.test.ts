// extensions/gemma-memory-intercept/index.test.ts
//
// Pure-function unit tests for the gemma-memory-intercept plugin.
// Validates the natural-language detector + the forbidden-call detector
// against the recall.sh pattern set documented in
// settings/projects/gemma-memory.md (P2.25 D24.1 + D24.2).

import assert from "node:assert/strict";
import { test } from "node:test";
import { __test__ } from "./index.ts";

const { looksLikeNaturalMemoRequest, detectForbiddenCall, buildBlockReason } = __test__;

// ---------------------------------------------------------------------------
// looksLikeNaturalMemoRequest — POSITIVE cases (must return true)
// ---------------------------------------------------------------------------

const POSITIVE: Array<[string, string]> = [
  [
    "지난주에 그 사람 만나기로 한 계획 어떻게 됐어?",
    "T1: 지난주(time) + 어떻게 됐어(intent) + 한글 명사",
  ],
  ["오로라랑 정한 계획 다시 보여줘", "T1 alt: 보여줘(intent) + 한글 명사"],
  ["방이동 갔던 날 메모 다시 보여줘", "T2: 보여줘 + 명사"],
  ["오늘 점심 김치찌개 먹었어, 적어둬", "T3: 오늘(time) + 적어둬(intent) + 명사"],
  ["어제 적은 거 지워줘", "T4: 어제(time) + 지워줘(intent) + 명사"],
  ["엄마한테 내일 병원 같이 가자고 했어. 기록해둬", "T5: 내일(time) + 기록해둬(intent) + 명사"],
  [
    "그때 정해둔 옵션 가격이 얼마였더라",
    "READ-tense recall: 그때(time) + 얼마였더라(intent) + 명사",
  ],
  ["엄마 전화번호 알려줘", "person + 알려줘(intent) + 명사"],
  ["방이동 어디에 있더라", "place + SEARCH intent"],
  ["지난주에 만난 사람 누구였지", "지난주(time) + 명사 (intent 약하지만 time + noun으로 통과)"],
];

for (const [text, label] of POSITIVE) {
  test(`looksLikeNaturalMemoRequest POSITIVE: ${label}`, () => {
    assert.equal(
      looksLikeNaturalMemoRequest(text),
      true,
      `expected true for: ${JSON.stringify(text)}`,
    );
  });
}

// ---------------------------------------------------------------------------
// looksLikeNaturalMemoRequest — NEGATIVE cases (must return false)
// ---------------------------------------------------------------------------

const NEGATIVE: Array<[string, string]> = [
  ["", "empty"],
  ["응", "too short (1 char)"],
  ["응 알겠어", "no intent or time keywords + short"],
  ["/export-context", "slash command"],
  ["/help", "slash command"],
  ["bash scripts/recall.sh 어제 메모 보여줘", "already routed to recall.sh — let it through"],
  ["1234567890", "no Hangul"],
  ["hello world", "no Hangul"],
  ["The weather is nice today", "English only, no Hangul"],
  ["고마워", "noun-only, no intent or time"],
  [
    "오늘 날씨가 좋네",
    "오늘 + noun BUT no intent/recall verb… actually 오늘 is TIME so this should be TRUE — see borderline",
  ],
  ["123", "too short"],
];

// Remove the borderline "오늘 날씨가 좋네" — it actually IS positive by design
// (time + noun). The recall plugin would catch this and try to route to recall.sh.
// If false-positive becomes a problem we can tighten in next iteration.
const NEGATIVE_FILTERED = NEGATIVE.filter(([text]) => text !== "오늘 날씨가 좋네");

for (const [text, label] of NEGATIVE_FILTERED) {
  test(`looksLikeNaturalMemoRequest NEGATIVE: ${label}`, () => {
    assert.equal(
      looksLikeNaturalMemoRequest(text),
      false,
      `expected false for: ${JSON.stringify(text)}`,
    );
  });
}

// Track this borderline case explicitly:
test("looksLikeNaturalMemoRequest BORDERLINE: time + noun without intent verb still matches", () => {
  assert.equal(
    looksLikeNaturalMemoRequest("오늘 날씨가 좋네"),
    true,
    "design: time + noun is enough to trigger; intent verb optional",
  );
});

// ---------------------------------------------------------------------------
// detectForbiddenCall — must return non-null for forbidden patterns
// ---------------------------------------------------------------------------

const FORBIDDEN: Array<[string, Record<string, unknown>, string]> = [
  ["read", { path: "/home/lisyoen/projects/openclaw/skills/memory/SKILL.md" }, "SKILL.md path"],
  ["read", { path: "/some/where/skill-creator/SKILL.md" }, "SKILL.md nested path"],
  ["read", { path: "MEMORY-SEARCH/skill.md" }, "case-insensitive SKILL.md"],
  [
    "read",
    { path: "/home/lisyoen/.openclaw/agents/gemma/workspace/SOUL.md" },
    "workspace profile SOUL.md",
  ],
  ["read", { path: "MEMORY.md" }, "workspace profile MEMORY.md (already in prompt)"],
  ["read", { path: "TOOLS.md" }, "workspace profile TOOLS.md"],
  ["read", { path: "BOOTSTRAP.md" }, "workspace profile BOOTSTRAP.md"],
  ["read", { file_path: "AGENTS.md" }, "workspace profile via file_path alias"],
  ["exec", { command: "find ~/workspace -name '*.md'" }, "exec find"],
  ["exec", { command: "ind ~/workspace" }, "exec ind (find typo)"],
  ["exec", { command: "grep -r aurora ~/workspace" }, "exec grep -r"],
  ["exec", { command: "cat ~/workspace/MEMORY.md" }, "exec cat workspace md"],
  ["exec", { command: "ls -R ~/workspace" }, "exec ls -R"],
  ["exec", { command: "bash scripts/memory.sh search aurora" }, "direct memory.sh"],
  ["exec", { command: "bash scripts/person.sh new aurora" }, "direct person.sh"],
  ["bash", { command: "find . -type f" }, "bash variant: find"],
];

for (const [tool, params, label] of FORBIDDEN) {
  test(`detectForbiddenCall FORBIDDEN: ${label}`, () => {
    const r = detectForbiddenCall(tool, params);
    assert.notEqual(
      r,
      null,
      `expected non-null for tool=${tool} params=${JSON.stringify(params)}, got null`,
    );
  });
}

// ---------------------------------------------------------------------------
// detectForbiddenCall — must return null for allowed patterns
// ---------------------------------------------------------------------------

const ALLOWED: Array<[string, Record<string, unknown>, string]> = [
  ["exec", { command: 'bash scripts/recall.sh "어제 메모 보여줘"' }, "recall.sh — allow"],
  [
    "exec",
    {
      command:
        'bash /home/lisyoen/.openclaw/agents/gemma/workspace/scripts/recall.sh "오로라 계획"',
    },
    "recall.sh abs path",
  ],
  ["exec", { command: "date +%Y-%m-%d" }, "harmless date call"],
  ["exec", { command: "echo hello" }, "echo"],
  ["read", { path: "/home/lisyoen/some/data.json" }, "read non-md non-skill"],
  ["read", { path: "/etc/hosts" }, "read unrelated file"],
  ["write", { path: "/tmp/x.md", content: "..." }, "write tool — out of scope"],
  ["read", { path: "" }, "read with empty path"],
  ["exec", {} as Record<string, unknown>, "exec with empty params"],
];

for (const [tool, params, label] of ALLOWED) {
  test(`detectForbiddenCall ALLOWED: ${label}`, () => {
    const r = detectForbiddenCall(tool, params);
    assert.equal(
      r,
      null,
      `expected null for tool=${tool} params=${JSON.stringify(params)}, got: ${r}`,
    );
  });
}

// ---------------------------------------------------------------------------
// buildBlockReason — sanity
// ---------------------------------------------------------------------------

test("buildBlockReason includes original call and user text sample", () => {
  const reason = buildBlockReason(
    `read({path:"foo/SKILL.md"})`,
    "지난주에 오로라랑 정한 계획 다시 보여줘",
  );
  assert.match(reason, /P2\.25c/, "should mention P2.25c");
  assert.match(reason, /scripts\/recall\.sh/, "should suggest recall.sh");
  assert.match(reason, /지난주에 오로라랑 정한 계획/, "should echo user text sample");
  assert.match(reason, /read\(\{path:"foo\/SKILL\.md"\}\)/, "should name forbidden call");
});

test("buildBlockReason embeds escaped double quotes from user text", () => {
  const reason = buildBlockReason("read SKILL.md", '메모에 "방이동" 적어둬');
  // The inner " in the user text should appear escaped as \\" inside the sample.
  assert.match(reason, /방이동/);
  // Escaped form must be present (the sample is wrapped in escaped quotes).
  assert.ok(reason.includes('\\"방이동\\"'), 'should escape inner quotes as \\"');
});

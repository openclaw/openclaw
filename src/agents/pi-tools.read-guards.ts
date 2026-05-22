// P2.24a — read 도구 빈 args 가드 (2026-05-22)
// 본 사고: jsonl 11:07:46~57 UTC 사이 read({path:""}) 7회 반복 → 루프 가드 → "잠깐만 기다려줘" 끊김.
// 결함: assertRequiredParams 가 빈 path 를 catch 하지만 모델이 같은 에러를 반복 무시.
// 가드: (1) 강한 에러 메시지, (2) 60초 슬라이딩 윈도우 카운터, (3) 사용자 메시지 path 자동 추출 best-effort.

const READ_EMPTY_ARGS_WINDOW_MS = 60_000;
const READ_EMPTY_ARGS_MAX_ATTEMPTS = 2;
const readEmptyArgsAttempts: { ts: number }[] = [];

let lastUserMessageTextForReadFallback: string | undefined;
let lastUserMessageTextTs = 0;
const LAST_USER_MESSAGE_VALID_MS = 5 * 60_000;

export function setLastUserMessageTextForReadFallback(text: string | undefined): void {
  lastUserMessageTextForReadFallback = text;
  lastUserMessageTextTs = Date.now();
}

function getLastUserMessageTextForReadFallback(): string | undefined {
  if (!lastUserMessageTextForReadFallback) {
    return undefined;
  }
  if (Date.now() - lastUserMessageTextTs > LAST_USER_MESSAGE_VALID_MS) {
    return undefined;
  }
  return lastUserMessageTextForReadFallback;
}

function trackReadEmptyArgsAttempt(): number {
  const now = Date.now();
  while (
    readEmptyArgsAttempts.length > 0 &&
    now - readEmptyArgsAttempts[0].ts > READ_EMPTY_ARGS_WINDOW_MS
  ) {
    readEmptyArgsAttempts.shift();
  }
  readEmptyArgsAttempts.push({ ts: now });
  return readEmptyArgsAttempts.length;
}

export function extractPathCandidatesFromUserMessage(text: string | undefined): string[] {
  if (!text || typeof text !== "string") {
    return [];
  }
  const candidates = new Set<string>();
  const mdRe = /[A-Za-z0-9_\-./\uac00-\ud7a3]{3,}\.md/g;
  const memRe = /(?:^|[^A-Za-z0-9_/-])((?:\/)?memory\/[A-Za-z0-9_\-./\uac00-\ud7a3]+)/g;
  let m: RegExpExecArray | null;
  m = mdRe.exec(text);
  while (m !== null) {
    candidates.add(m[0]);
    m = mdRe.exec(text);
  }
  m = memRe.exec(text);
  while (m !== null) {
    candidates.add(m[1].replace(/^\//, ""));
    m = memRe.exec(text);
  }
  return [...candidates];
}

export function isReadPathEmpty(value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (typeof value !== "string") {
    return true;
  }
  return value.trim().length === 0;
}

// 빈 args 감지 시: 자동 보완 가능하면 path 문자열 반환, 아니면 강한 에러 throw.
export function applyReadEmptyArgsGuard(
  record: Record<string, unknown> | undefined,
): string | undefined {
  const rawPath = record?.path;
  if (!isReadPathEmpty(rawPath)) {
    return undefined;
  }

  const attemptCount = trackReadEmptyArgsAttempt();
  const lastText = getLastUserMessageTextForReadFallback();
  const candidates = extractPathCandidatesFromUserMessage(lastText);

  if (attemptCount === 1 && candidates.length === 1) {
    const chosen = candidates[0];
    try {
      process.stderr.write(
        `[P2.24a] read empty path auto-extracted from user msg: ${JSON.stringify(chosen)}\n`,
      );
    } catch {
      // ignore
    }
    return chosen;
  }

  let msg: string;
  if (attemptCount >= READ_EMPTY_ARGS_MAX_ATTEMPTS + 1) {
    msg =
      "CRITICAL: read called with empty path argument " +
      attemptCount +
      ' times in the last 60s. STOP retrying — reply to the user with ONE Korean sentence: "read 호출이 ' +
      attemptCount +
      '번 빈 path 로 실패했어. 파일 경로를 한 번만 더 적어줄래?". Forbidden filler phrases mid-turn: "잠깐", "곧", "다시", "확인할게".';
  } else if (candidates.length === 0) {
    msg =
      'read: path argument is empty. Could not auto-extract a file path from the most recent user message. Please specify the file path explicitly. Example: read({path: "memory/aurora-somin-plan-2026-05-22.md"})';
  } else {
    msg =
      "read: path argument is empty. Multiple candidates found in the user message; auto-extract refused. Candidates: " +
      candidates.map((c) => JSON.stringify(c)).join(", ") +
      ". Please call read again with one explicit path.";
  }
  const err = new Error(msg) as Error & { code?: string };
  err.code = "READ_EMPTY_PATH";
  throw err;
}

// 테스트 전용 reset
export function __resetReadEmptyArgsGuardForTest(): void {
  readEmptyArgsAttempts.length = 0;
  lastUserMessageTextForReadFallback = undefined;
  lastUserMessageTextTs = 0;
}

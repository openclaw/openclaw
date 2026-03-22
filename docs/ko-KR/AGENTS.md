# AGENTS.md - 한국어 문서 번역 워크스페이스

## 읽어야 할 때

- `docs/ko/**` 유지보수 시
- 한국어 번역 파이프라인 (용어집/TM/프롬프트) 수정 시
- 한국어 번역 피드백 또는 회귀 처리 시

## 파이프라인 (docs-i18n)

- 원문: `docs/**/*.md`
- 번역본: `docs/ko/**/*.md`
- 용어집: `docs/.i18n/glossary.ko.json`
- 번역 메모리: `docs/.i18n/ko.tm.jsonl`
- 프롬프트 규칙: `scripts/docs-i18n/prompt.go`

상용 실행 방법:

```bash
# 일괄 번역 (doc 모드, 병렬 가능)
go run scripts/docs-i18n/main.go -lang ko -mode doc -parallel 6 docs/**/*.md

# 단일 파일
go run scripts/docs-i18n/main.go -lang ko -mode doc docs/channels/matrix.md

# 소규모 패치 (segment 모드, TM 활용; 병렬 불가)
go run scripts/docs-i18n/main.go -lang ko -mode segment docs/channels/matrix.md
```

참고사항:

- doc 모드는 전체 페이지 번역에, segment 모드는 소규모 수정에 사용합니다 (TM 의존).
- 새로운 기술 용어, 페이지 제목 또는 짧은 내비게이션 라벨을 추가할 때는 먼저 `docs/.i18n/glossary.ko.json`을 업데이트한 후 `doc` 모드를 실행하세요.
- `pnpm docs:check-i18n-glossary`로 변경된 영문 문서 제목과 짧은 내부 링크 라벨이 용어집에 반영되었는지 확인합니다.
- 대용량 파일이 시간 초과되면 **부분 교체** 또는 분할 후 재실행을 우선합니다.
- 번역 후 띄어쓰기, 용어 일관성을 반드시 확인합니다.

## 한국어 스타일 규칙

- **한영 혼용 띄어쓰기**: 한글과 영문/숫자 사이에 공백을 넣습니다 (예: `Gateway 게이트웨이`, `Skills 설정`).
- **따옴표**: 본문/제목에서는 한국어 큰따옴표(`""`)를 사용하고, 코드/CLI/키 이름에서는 ASCII 따옴표를 유지합니다.
- **영문 유지 용어**: `Skills`, `local loopback`, `Tailscale`, `Gateway`, `OpenClaw`, `Pi`, `CLI`, `Doctor`.
- **코드 블록/인라인 코드**: 원문 그대로 유지합니다. 코드 내에 공백이나 따옴표 변환을 넣지 않습니다.
- **경어체**: 문서 전반에서 `~합니다`/`~입니다` 형태의 경어체를 사용합니다.
- **기술 용어**: 널리 통용되는 외래어는 한글 표기를 사용합니다 (예: 에이전트, 프로바이더, 플러그인, 세션, 토큰).
- **제품명/서비스명**: WhatsApp, Telegram, Discord, iMessage, Slack, Microsoft Teams, Google Chat, Signal 등은 영문 그대로 유지합니다.
- **내부 링크**: Mintlify 경로를 유지하되, 한국어 문서 경로(`/ko/...`)로 변환하지 않습니다. 영문 경로 그대로 사용합니다.
- **Mintlify 컴포넌트**: `<Card>`, `<Steps>`, `<Tab>`, `<Tip>`, `<Note>`, `<Warning>` 등의 컴포넌트 태그는 원문 그대로 유지합니다.

## 주요 용어

| 영문       | 한국어     |
| ---------- | ---------- |
| Gateway    | Gateway    |
| Skills     | Skills     |
| agent      | 에이전트   |
| channel    | 채널       |
| session    | 세션       |
| provider   | 프로바이더 |
| model      | 모델       |
| tool       | 도구       |
| plugin     | 플러그인   |
| sandbox    | 샌드박스   |
| onboarding | 온보딩     |
| pairing    | 페어링     |
| heartbeat  | 하트비트   |
| streaming  | 스트리밍   |
| compaction | 압축       |
| template   | 템플릿     |
| daemon     | 데몬       |
| node       | 노드       |
| token      | 토큰       |
| webhook    | 웹훅       |
| cron job   | 크론 작업  |

## 파일 구조

한국어 번역 파일은 영문 원본의 디렉터리 구조를 그대로 따릅니다:

```
docs/ko/
├── index.md
├── start/
├── install/
├── channels/
├── concepts/
├── tools/
├── plugins/
├── automation/
├── providers/
├── platforms/
├── gateway/
├── cli/
├── reference/
├── help/
├── web/
├── nodes/
├── security/
├── debug/
└── diagnostics/
```
